/**
 * Content script — runs on ChatGPT, Claude, and Gemini.
 * Intercepts file uploads, shows an inline MDSpin logo button,
 * and injects a converted .md file as a native attachment.
 *
 * Uses a Shadow DOM container to isolate styles and prevent
 * interference with the host page's UI.
 */

const SITE = detectSite();

const SUPPORTED_EXTENSIONS = new Set([
  "pdf", "docx", "pptx", "txt", "html", "rtf", "csv",
]);

// Store intercepted files keyed by name so we can convert them later
const interceptedFiles = new Map<string, File>();

// Track which chips already have an MDSpin button
const processedChips = new WeakSet<Element>();

// Track composer focus state
let composerFocused = false;

// Whether inline buttons are enabled (controlled by popup toggle, persisted in storage)
let inlineButtonsEnabled = true;

// Shadow DOM host and root — single container for all MDSpin UI
let shadowHost: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;

function detectSite(): string | null {
  const host = location.hostname;
  if (host.includes("chatgpt.com") || host.includes("chat.openai.com"))
    return "chatgpt";
  if (host.includes("claude.ai")) return "claude";
  if (host.includes("gemini.google.com")) return "gemini";
  return null;
}

function isSupportedFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXTENSIONS.has(ext);
}

// ── File Interception ──────────────────────────────────────────────

function interceptFiles() {
  // Intercept drops from the MDSpin popup (File objects don't cross the extension boundary,
  // so the popup stores markdown in chrome.storage.session and sets a text marker instead)
  document.addEventListener("drop", async (e) => {
    const text = e.dataTransfer?.getData("text/plain") ?? "";
    if (!text.startsWith("MDSPIN_DROP:")) return;

    // Block the host page (ChatGPT/Claude/Gemini) from inserting the marker as text
    e.preventDefault();
    e.stopImmediatePropagation();

    const filename = text.slice("MDSPIN_DROP:".length);
    console.log(`[MDSpin] Detected popup drag-drop for: ${filename}`);

    // Retrieve markdown via background worker relay (direct storage access is blocked by CSP)
    const pending = await chrome.runtime.sendMessage({ type: "GET_PENDING_DROP" });
    if (!pending?.markdown) {
      console.warn("[MDSpin] No pending markdown found in background worker");
      return;
    }

    await injectFileAsAttachment(pending.markdown, filename);
  }, true);

  document.addEventListener("drop", (e) => {
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (isSupportedFile(file.name)) {
        interceptedFiles.set(file.name, file);
        console.log(`[MDSpin] Intercepted drop: ${file.name}`);
      }
    }
  }, true);

  document.addEventListener("change", (e) => {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
    const files = input.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (isSupportedFile(file.name)) {
        interceptedFiles.set(file.name, file);
        console.log(`[MDSpin] Intercepted input: ${file.name}`);
      }
    }
  }, true);

  document.addEventListener("paste", (e) => {
    const files = e.clipboardData?.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (isSupportedFile(file.name)) {
        interceptedFiles.set(file.name, file);
        console.log(`[MDSpin] Intercepted paste: ${file.name}`);
      }
    }
  }, true);
}

// ── Composer Focus Tracking (Item #5) ──────────────────────────────

function getComposerArea(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('form[class*="composer"]') ??
    document.querySelector<HTMLElement>('#prompt-textarea')?.closest('form') as HTMLElement ??
    document.querySelector<HTMLElement>('form') ??
    document.querySelector<HTMLElement>('[class*="composer"]')
  );
}

function setupFocusTracking() {
  // Use focusin/focusout on the document — these bubble, unlike focus/blur
  document.addEventListener("focusin", (e) => {
    const composer = getComposerArea();
    if (composer && composer.contains(e.target as Node)) {
      composerFocused = true;
      updateButtonVisibility();
    }
  });

  document.addEventListener("focusout", (e) => {
    const composer = getComposerArea();
    if (composer && composer.contains(e.target as Node)) {
      // Delay to allow focus to settle (e.g. clicking the MDSpin button itself)
      setTimeout(() => {
        const active = document.activeElement;
        const stillInComposer = composer.contains(active);
        // Also check if the active element is inside our shadow root
        const isMdspinBtn = shadowRoot?.activeElement?.hasAttribute("data-mdspin-file") ||
                            active?.hasAttribute("data-mdspin-file") ||
                            active?.closest("[data-mdspin-file]");
        if (!stillInComposer && !isMdspinBtn) {
          composerFocused = false;
          updateButtonVisibility();
        }
      }, 150);
    }
  });

  // Also show buttons when there are files attached (user just uploaded)
  // even if focus hasn't explicitly entered the composer yet
  document.addEventListener("click", (e) => {
    const composer = getComposerArea();
    if (composer && composer.contains(e.target as Node)) {
      composerFocused = true;
      updateButtonVisibility();
    } else {
      // Clicked outside composer — but check if it's the MDSpin button (in shadow root)
      const target = e.target as HTMLElement;
      const isMdspinHost = target === shadowHost || target.id === "mdspin-root";
      if (!isMdspinHost && !target.hasAttribute("data-mdspin-file") && !target.closest("[data-mdspin-file]")) {
        composerFocused = false;
        updateButtonVisibility();
      }
    }
  });
}

function updateButtonVisibility() {
  const root = shadowRoot ?? document;
  const buttons = root.querySelectorAll<HTMLElement>("[data-mdspin-file]");
  const show = inlineButtonsEnabled && composerFocused;
  for (const btn of buttons) {
    btn.style.opacity = show ? "1" : "0";
    btn.style.pointerEvents = show ? "auto" : "none";
  }
}

// ── Shadow DOM Container ───────────────────────────────────────────

function createShadowHost(): { host: HTMLDivElement; root: ShadowRoot } {
  const host = document.createElement("div");
  host.id = "mdspin-root";
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "9999",
    pointerEvents: "none",
    overflow: "visible",
  });
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: "open" });

  // Inject all styles (including keyframes) inside the shadow root
  const style = document.createElement("style");
  style.textContent = `
    @keyframes mdspin-rotate {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .mdspin-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px;
      background: transparent;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      position: absolute;
      pointer-events: auto;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }

    .mdspin-btn:hover {
      transform: scale(1.1);
    }

    .mdspin-btn img {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      transition: transform 0.3s ease;
    }

    .mdspin-btn img.spinning {
      animation: mdspin-rotate 1s linear infinite;
    }
  `;
  root.appendChild(style);

  return { host, root };
}

function ensureShadowRoot(): ShadowRoot {
  if (!shadowRoot || !shadowHost || !document.body.contains(shadowHost)) {
    const result = createShadowHost();
    shadowHost = result.host;
    shadowRoot = result.root;
  }
  return shadowRoot;
}

// ── Inline Button Injection ────────────────────────────────────────

function createButton(fileName: string): HTMLButtonElement {
  const root = ensureShadowRoot();

  const btn = document.createElement("button");
  btn.className = "mdspin-btn";

  const logoUrl = chrome.runtime.getURL("icons/logo-32.png");
  const img = document.createElement("img");
  img.src = logoUrl;
  img.alt = "MDSpin";
  btn.appendChild(img);

  btn.title = "Convert to Markdown with MDSpin";
  const show = inlineButtonsEnabled && composerFocused;
  btn.style.opacity = show ? "1" : "0";
  btn.style.pointerEvents = show ? "auto" : "none";

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleConvert(btn, fileName);
  });

  // Append to shadow root (not document.body)
  root.appendChild(btn);

  return btn;
}

function startSpinAnimation(btn: HTMLButtonElement) {
  const img = btn.querySelector("img");
  if (img) img.classList.add("spinning");
}

function stopSpinAnimation(btn: HTMLButtonElement) {
  const img = btn.querySelector("img");
  if (img) img.classList.remove("spinning");
}

// Guard against multiple concurrent conversions of the same file
const convertingFiles = new Set<string>();

async function handleConvert(btn: HTMLButtonElement, fileName: string) {
  if (convertingFiles.has(fileName)) {
    console.log("[MDSpin] Already converting:", fileName);
    return;
  }

  const file = interceptedFiles.get(fileName);
  if (!file) {
    btn.title = "File not captured — use the MDSpin popup to convert";
    setTimeout(() => {
      btn.title = "Convert to Markdown with MDSpin";
    }, 3000);
    return;
  }

  // Mark as converting
  convertingFiles.add(fileName);

  // Start spinning animation
  startSpinAnimation(btn);
  btn.style.pointerEvents = "none";

  try {
    console.log("[MDSpin] Reading file...", file.name, file.size, "bytes");
    const fileData = await fileToBase64(file);
    console.log("[MDSpin] Sending to background...", fileData.length, "base64 chars");

    const response = await chrome.runtime.sendMessage({
      type: "CONVERT_FILE",
      fileName: file.name,
      fileData,
      fileType: file.type,
    });

    console.log("[MDSpin] Got response:", response);

    if (!response || response.error) {
      const errMsg = response?.error ?? "No response from background";
      console.error("[MDSpin] Conversion error:", errMsg);
      stopSpinAnimation(btn);
      btn.title = `Error: ${errMsg}`;
      btn.style.pointerEvents = "auto";
      // Flash red border
      btn.style.outline = "2px solid #ef4444";
      setTimeout(() => {
        btn.style.outline = "none";
        btn.title = "Convert to Markdown with MDSpin";
      }, 3000);
      return;
    }

    // Stop spinning
    stopSpinAnimation(btn);

    // Try to inject the markdown as a native .md file attachment
    const mdFilename = file.name.replace(/\.[^.]+$/, ".md");
    const injected = await injectFileAsAttachment(response.markdown, mdFilename);

    if (injected) {
      // Show success — green check overlay briefly
      btn.style.outline = "2px solid #16a34a";
      btn.title = "MD file attached!";
    } else {
      // Fallback: copy to clipboard — refocus page first
      try {
        // Focus the prompt textarea so the document is focused
        const textarea = document.querySelector<HTMLElement>("#prompt-textarea");
        if (textarea) textarea.focus();
        await new Promise((r) => setTimeout(r, 100));
        await navigator.clipboard.writeText(response.markdown);
        btn.title = "Copied to clipboard!";
        btn.style.outline = "2px solid #FF4800";
      } catch (clipErr) {
        console.warn("[MDSpin] Clipboard also failed:", clipErr);
        btn.title = "Conversion done — paste from clipboard";
        btn.style.outline = "2px solid #FF4800";
      }
    }

    btn.style.pointerEvents = "auto";
    setTimeout(() => {
      btn.style.outline = "none";
      btn.title = "Convert to Markdown with MDSpin";
    }, 3000);
  } catch (err) {
    console.error("[MDSpin] Failed:", err);
    stopSpinAnimation(btn);
    btn.title = `Failed: ${err}`;
    btn.style.outline = "2px solid #ef4444";
    btn.style.pointerEvents = "auto";
  } finally {
    convertingFiles.delete(fileName);
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── File Attachment Injection ──────────────────────────────────────

/**
 * Snapshot the current file chip DOM elements so we can detect new ones.
 * Returns a Set of textContent strings from chip-like elements.
 */
function snapshotChipTexts(): Set<string> {
  const composer = getComposerArea();
  if (!composer) return new Set();
  const texts = new Set<string>();
  // Walk the composer DOM looking for small elements (file chips have short text)
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const el = node as HTMLElement;
    const t = el.textContent?.trim() ?? "";
    if (t.length > 2 && t.length < 100) {
      texts.add(t);
    }
    node = walker.nextNode();
  }
  return texts;
}

/** Check if a new chip appeared by comparing snapshots */
function hasNewChip(before: Set<string>, mdFilename: string): boolean {
  const after = snapshotChipTexts();
  // Look for any new text that contains ".md" and wasn't there before
  for (const text of after) {
    if (!before.has(text) && (text.includes(".md") || text.includes(mdFilename.replace(".md", "")))) {
      console.log("[MDSpin] New chip text detected:", text);
      return true;
    }
  }
  return false;
}

/**
 * CRITICAL: Refocus ChatGPT's composer before injecting files.
 * Clicking the Shadow DOM button steals focus, which can prevent
 * ChatGPT from processing file input changes.
 */
function refocusComposer() {
  const textarea = document.querySelector<HTMLElement>("#prompt-textarea");
  if (textarea) {
    textarea.focus();
    console.log("[MDSpin] Refocused prompt textarea");
  }
}

async function injectFileAsAttachment(
  markdown: string,
  mdFilename: string
): Promise<boolean> {

  // CRITICAL: Restore focus to ChatGPT's composer before any injection attempt
  refocusComposer();
  await new Promise((r) => setTimeout(r, 200));

  const chipsBefore = snapshotChipTexts();
  console.log("[MDSpin] Chips before injection:", chipsBefore.size, "texts");

  // === Approach A: MAIN world injection (full React access) ===
  console.log("[MDSpin] Trying Approach A: MAIN world injection...");
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "INJECT_MD_FILE",
      markdown,
      mdFilename,
    });
    console.log("[MDSpin] MAIN world response:", resp);

    await new Promise((r) => setTimeout(r, 1500));
    if (hasNewChip(chipsBefore, mdFilename)) {
      console.log("[MDSpin] Approach A succeeded!");
      return true;
    }
    console.log("[MDSpin] Approach A: no new .md chip detected");
  } catch (err) {
    console.error("[MDSpin] Approach A error:", err);
  }

  // === Approach B: Original simple file input (worked in previous session) ===
  // Refocus again in case Approach A disrupted it
  refocusComposer();
  await new Promise((r) => setTimeout(r, 200));

  console.log("[MDSpin] Trying Approach B: simple file input (original)...");
  try {
    const mdFile = new File([markdown], mdFilename, {
      type: "text/markdown",
      lastModified: Date.now(),
    });

    let input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      console.log("[MDSpin] No file input found");
    } else {
      console.log("[MDSpin] Found file input:", input.id, "accept:", input.accept);

      const dt = new DataTransfer();
      dt.items.add(mdFile);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // React's onChange fires for file inputs from synthetic events

      console.log("[MDSpin] Dispatched change event, files:", input.files?.length);

      await new Promise((r) => setTimeout(r, 1500));
      if (hasNewChip(chipsBefore, mdFilename)) {
        console.log("[MDSpin] Approach B succeeded!");
        return true;
      }
      console.log("[MDSpin] Approach B: no new .md chip detected");
    }
  } catch (err) {
    console.error("[MDSpin] Approach B error:", err);
  }

  // === Approach C: Drag-and-drop on composer ===
  refocusComposer();
  await new Promise((r) => setTimeout(r, 200));

  console.log("[MDSpin] Trying Approach C: drag-and-drop...");
  try {
    const mdFile = new File([markdown], mdFilename, {
      type: "text/markdown",
      lastModified: Date.now(),
    });

    const dropTarget =
      document.querySelector<HTMLElement>('form[class*="composer"]') ??
      document.querySelector<HTMLElement>('#prompt-textarea')?.closest('form') as HTMLElement ??
      document.querySelector<HTMLElement>("#prompt-textarea");

    if (dropTarget) {
      const dt = new DataTransfer();
      dt.items.add(mdFile);
      const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
      dropTarget.dispatchEvent(new DragEvent("dragenter", opts));
      dropTarget.dispatchEvent(new DragEvent("dragover", opts));
      dropTarget.dispatchEvent(new DragEvent("drop", opts));

      await new Promise((r) => setTimeout(r, 1500));
      if (hasNewChip(chipsBefore, mdFilename)) {
        console.log("[MDSpin] Approach C succeeded!");
        return true;
      }
      console.log("[MDSpin] Approach C: no new .md chip detected");
    }
  } catch (err) {
    console.error("[MDSpin] Approach C error:", err);
  }

  console.log("[MDSpin] All injection approaches failed — falling back to clipboard");
  return false;
}

// ── File Chip Detection ────────────────────────────────────────────

function findFileChipForName(fileName: string): Element | null {
  const composerArea = getComposerArea();
  if (!composerArea) return null;

  const walker = document.createTreeWalker(
    composerArea,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        const el = node as HTMLElement;
        const text = el.textContent?.trim() ?? "";
        if (!text.includes(fileName.replace(/\.[^.]+$/, "").substring(0, 20))) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let best: Element | null = null;
  let bestLen = Infinity;

  let current = walker.nextNode();
  while (current) {
    const el = current as HTMLElement;
    const len = el.textContent?.length ?? Infinity;
    if (len < bestLen && len < 200) {
      best = el;
      bestLen = len;
    }
    current = walker.nextNode();
  }

  return best;
}

/**
 * Finds the actual rounded prompt box (not a full-width wrapper)
 * by looking for the visible container around the textarea/chip.
 */
function findPromptBox(): HTMLElement | null {
  const textarea = document.querySelector<HTMLElement>("#prompt-textarea");
  if (!textarea) return null;

  let el: HTMLElement | null = textarea;
  while (el && el !== document.body) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 100 && rect.width < window.innerWidth * 0.9) {
      if (rect.height > 50) {
        return el;
      }
    }
    el = el.parentElement;
  }
  return null;
}

const BTN_SIZE = 36;
const BTN_GAP = 10;

function positionButton(btn: HTMLElement) {
  const promptBox = findPromptBox();
  if (!promptBox) return;

  const boxRect = promptBox.getBoundingClientRect();

  // Center horizontally above the prompt box, with a gap above the top edge
  Object.assign(btn.style, {
    left: `${boxRect.left + boxRect.width / 2 - BTN_SIZE / 2}px`,
    top: `${boxRect.top - BTN_SIZE - BTN_GAP}px`,
  });
}

function injectButtons() {
  const root = ensureShadowRoot();

  for (const [fileName] of interceptedFiles) {
    const existing = root.querySelector(`[data-mdspin-file="${CSS.escape(fileName)}"]`);
    if (existing) {
      positionButton(existing as HTMLElement);
      continue;
    }

    const chip = findFileChipForName(fileName);
    if (!chip) continue;

    if (processedChips.has(chip)) continue;
    processedChips.add(chip);

    const btn = createButton(fileName);
    btn.setAttribute("data-mdspin-file", fileName);
    positionButton(btn);

    console.log(`[MDSpin] Injected button for: ${fileName}`);
  }
}

// ── Smooth Position Tracking ─────────────────────────────────────

let rafId: number | null = null;

function startPositionTracking() {
  function tick() {
    const root = shadowRoot;
    if (root) {
      const buttons = root.querySelectorAll<HTMLElement>("[data-mdspin-file]");
      for (const btn of buttons) {
        positionButton(btn);
      }
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}

function stopPositionTracking() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

// ── Main ───────────────────────────────────────────────────────────

function init() {
  if (!SITE) return;

  console.log(`[MDSpin] Active on ${SITE}`);

  // Load persisted inline button setting
  chrome.storage.local.get("inlineButtonEnabled", (result) => {
    inlineButtonsEnabled = result.inlineButtonEnabled ?? true;
    console.log(`[MDSpin] Inline buttons ${inlineButtonsEnabled ? "enabled" : "disabled"}`);
    updateButtonVisibility();
  });

  // Listen for toggle messages from the popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "TOGGLE_INLINE_BUTTON") {
      inlineButtonsEnabled = msg.enabled;
      console.log(`[MDSpin] Inline buttons toggled: ${inlineButtonsEnabled}`);
      updateButtonVisibility();
    }
  });

  // Also watch for storage changes (in case popup changes it while content script is running)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.inlineButtonEnabled) {
      inlineButtonsEnabled = changes.inlineButtonEnabled.newValue ?? true;
      updateButtonVisibility();
    }
  });

  // Create shadow DOM container (styles are encapsulated inside)
  ensureShadowRoot();

  // Start intercepting files
  interceptFiles();

  // Setup focus tracking
  setupFocusTracking();

  // Watch for DOM changes and inject buttons
  const observer = new MutationObserver(() => {
    injectButtons();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Smooth position tracking via requestAnimationFrame
  startPositionTracking();

  // Also run periodically to catch chips that appear without triggering mutations
  setInterval(injectButtons, 1500);
}

init();
