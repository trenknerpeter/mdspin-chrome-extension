/**
 * Content script — runs on ChatGPT, Claude, and Gemini.
 * Intercepts file uploads, shows an inline MDSpin logo button,
 * and injects a converted .md file as a native attachment.
 *
 * Uses a Shadow DOM container to isolate styles and prevent
 * interference with the host page's UI.
 *
 * Platform-specific logic is delegated to site adapters
 * (see chatgpt.ts, gemini.ts).
 */

import type { SiteAdapter } from "./adapter";
import { delay } from "./adapter";
import { ChatGPTAdapter } from "./chatgpt";
import { GeminiAdapter } from "./gemini";

// ── Site Detection & Adapter ─────────────────────────────────────

function detectSite(): string | null {
  const host = location.hostname;
  if (host.includes("chatgpt.com") || host.includes("chat.openai.com"))
    return "chatgpt";
  if (host.includes("claude.ai")) return "claude";
  if (host.includes("gemini.google.com")) return "gemini";
  return null;
}

function createAdapter(site: string): SiteAdapter | null {
  switch (site) {
    case "chatgpt": return new ChatGPTAdapter();
    case "gemini":  return new GeminiAdapter();
    default:        return null;
  }
}

const SITE = detectSite();
const adapter = SITE ? createAdapter(SITE) : null;

// ── Constants & State ────────────────────────────────────────────

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

// ── Utilities ────────────────────────────────────────────────────

function isSupportedFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXTENSIONS.has(ext);
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

// ── File Interception ──────────────────────────────────────────────

function interceptFiles() {
  // Intercept drops from the MDSpin popup (File objects don't cross the extension boundary,
  // so the popup stores markdown in chrome.storage.session and sets a text marker instead)
  document.addEventListener("drop", async (e) => {
    const text = e.dataTransfer?.getData("text/plain") ?? "";
    if (!text.startsWith("MDSPIN_DROP:")) return;

    // Block the host page from inserting the marker as text
    e.preventDefault();
    e.stopImmediatePropagation();

    const filename = text.slice("MDSPIN_DROP:".length);
    console.log(`[MDSpin] Detected popup drag-drop for: ${filename}`);

    // Retrieve markdown via background worker relay
    const pending = await chrome.runtime.sendMessage({ type: "GET_PENDING_DROP" });
    if (!pending?.markdown) {
      console.warn("[MDSpin] No pending markdown found in background worker");
      return;
    }

    if (adapter) {
      // Write to clipboard early while user gesture is fresh
      try {
        await navigator.clipboard.writeText(pending.markdown);
      } catch { /* will retry later if needed */ }

      const injected = await adapter.injectFileAsAttachment(pending.markdown, filename);
      if (!injected) {
        // Clipboard was already written above — user can paste
        console.log("[MDSpin] Injection failed, markdown copied to clipboard");
      }
    }
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

// ── Composer Focus Tracking ──────────────────────────────────────

function setupFocusTracking() {
  document.addEventListener("focusin", (e) => {
    const composer = adapter?.getComposerArea();
    if (composer && composer.contains(e.target as Node)) {
      composerFocused = true;
      updateButtonVisibility();
    }
  });

  document.addEventListener("focusout", (e) => {
    const composer = adapter?.getComposerArea();
    if (composer && composer.contains(e.target as Node)) {
      setTimeout(() => {
        const active = document.activeElement;
        const stillInComposer = composer.contains(active);
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

  document.addEventListener("click", (e) => {
    const composer = adapter?.getComposerArea();
    if (composer && composer.contains(e.target as Node)) {
      composerFocused = true;
      updateButtonVisibility();
    } else {
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

  convertingFiles.add(fileName);
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
      btn.style.outline = "2px solid #ef4444";
      setTimeout(() => {
        btn.style.outline = "none";
        btn.title = "Convert to Markdown with MDSpin";
      }, 3000);
      return;
    }

    stopSpinAnimation(btn);

    const mdFilename = file.name.replace(/\.[^.]+$/, ".md");

    // Write to clipboard EARLY while user gesture is still valid
    // (injection attempts can take seconds and exhaust the gesture timeout)
    let clipboardWritten = false;
    try {
      await navigator.clipboard.writeText(response.markdown);
      clipboardWritten = true;
    } catch {
      // Will retry after injection attempt
    }

    const injected = adapter
      ? await adapter.injectFileAsAttachment(response.markdown, mdFilename)
      : false;

    if (injected) {
      btn.style.outline = "2px solid #16a34a";
      btn.title = "Markdown inserted!";
    } else {
      // Fallback: clipboard (may already be written)
      if (!clipboardWritten) {
        try {
          adapter?.refocusComposer();
          await delay(100);
          await navigator.clipboard.writeText(response.markdown);
          clipboardWritten = true;
        } catch (clipErr) {
          console.warn("[MDSpin] Clipboard also failed:", clipErr);
        }
      }
      if (clipboardWritten) {
        btn.title = "Copied to clipboard — paste with Ctrl+V";
        btn.style.outline = "2px solid #FF4800";
      } else {
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

// ── Button Positioning ─────────────────────────────────────────────

const BTN_SIZE = 36;
const BTN_GAP = 10;

function positionButton(btn: HTMLElement) {
  const promptBox = adapter?.findPromptBox();
  if (!promptBox) return;

  const boxRect = promptBox.getBoundingClientRect();

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

    const chip = adapter?.findFileChipForName(fileName);
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

// ── Main ───────────────────────────────────────────────────────────

function init() {
  if (!SITE || !adapter) return;

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

  // Watch for storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.inlineButtonEnabled) {
      inlineButtonsEnabled = changes.inlineButtonEnabled.newValue ?? true;
      updateButtonVisibility();
    }
  });

  // Create shadow DOM container
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
