// Convert via the MDSpin web proxy. The proxy injects the backend key
// server-side and rate-limits, so the extension ships NO secret — a backend
// key rotation can never break already-shipped extensions again.
const API_URL = "https://www.mdspin.app/api/convert";

console.log("[MDSpin BG] Service worker loaded");

// In-memory store for the pending drag-drop payload (popup → content script relay)
let pendingDrop: { markdown: string; filename: string } | null = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "STORE_PENDING_DROP") {
    pendingDrop = { markdown: message.markdown, filename: message.filename };
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_PENDING_DROP") {
    const result = pendingDrop;
    pendingDrop = null;
    sendResponse(result);
    return true;
  }

  if (message.type === "CLEAR_PENDING_DROP") {
    pendingDrop = null;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "CONVERT_FILE") {
    console.log("[MDSpin BG] Received CONVERT_FILE:", message.fileName);
    convertFile(message)
      .then((result) => {
        console.log("[MDSpin BG] Result:", result.error ?? `${result.markdown?.length} chars`);
        sendResponse(result);
      })
      .catch((err) => {
        console.error("[MDSpin BG] Error:", err);
        sendResponse({ error: String(err) });
      });
    return true;
  }

  if (message.type === "INJECT_MD_FILE_GEMINI") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: "No tab ID" });
      return true;
    }
    console.log("[MDSpin BG] Injecting .md file in MAIN world (Gemini):", message.mdFilename);

    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: geminiMainWorldInjectFile,
      args: [message.markdown, message.mdFilename],
    })
      .then((results) => {
        console.log("[MDSpin BG] Gemini injection result:", results);
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("[MDSpin BG] Gemini injection error:", err);
        sendResponse({ success: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "INJECT_MD_FILE") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: "No tab ID" });
      return true;
    }
    console.log("[MDSpin BG] Injecting .md file in MAIN world:", message.mdFilename);

    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: mainWorldInjectFile,
      args: [message.markdown, message.mdFilename],
    })
      .then((results) => {
        console.log("[MDSpin BG] Injection result:", results);
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("[MDSpin BG] Injection error:", err);
        sendResponse({ success: false, error: String(err) });
      });
    return true;
  }
});

/**
 * This function runs in the PAGE's main world (not the extension's isolated world).
 * It has full access to React internals, event handlers, and page-level JS.
 */
function mainWorldInjectFile(markdown: string, mdFilename: string) {
  console.log("[MDSpin MAIN] Injecting file:", mdFilename, "length:", markdown.length);

  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    console.error("[MDSpin MAIN] No file input found!");
    return false;
  }

  const mdFile = new File([markdown], mdFilename, {
    type: "text/plain",  // Use text/plain — ChatGPT may reject text/markdown
    lastModified: Date.now(),
  });

  const dt = new DataTransfer();
  dt.items.add(mdFile);

  // DO NOT reset input.value — the original working code didn't do this
  input.files = dt.files;
  console.log("[MDSpin MAIN] Set files on input, count:", input.files?.length);

  // Find React's onChange handler
  const propsKey = Object.keys(input).find(k => k.startsWith("__reactProps$"));
  if (propsKey) {
    const props = (input as any)[propsKey];
    console.log("[MDSpin MAIN] React props keys:", Object.keys(props));
    console.log("[MDSpin MAIN] onChange type:", typeof props.onChange, "value:", props.onChange);
    console.log("[MDSpin MAIN] onClick type:", typeof props.onClick, "value:", props.onClick);

    // Try calling onChange with a proper event-like object
    if (typeof props.onChange === "function") {
      console.log("[MDSpin MAIN] Calling onChange...");
      try {
        props.onChange({ target: input, currentTarget: input, type: "change", nativeEvent: new Event("change") });
        console.log("[MDSpin MAIN] onChange called successfully");
      } catch (err) {
        console.error("[MDSpin MAIN] onChange threw:", err);
      }
    } else {
      console.log("[MDSpin MAIN] onChange is not a function, trying onClick...");
      // Maybe ChatGPT uses onClick to trigger upload processing
      if (typeof props.onClick === "function") {
        try {
          props.onClick({ target: input, currentTarget: input, type: "click", preventDefault: () => {} });
          console.log("[MDSpin MAIN] onClick called");
        } catch (err) {
          console.error("[MDSpin MAIN] onClick threw:", err);
        }
      }
    }
  }

  // Also walk up the fiber tree to find the component that handles uploads
  const fiberKey = Object.keys(input).find(
    k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
  );
  if (fiberKey) {
    let fiber = (input as any)[fiberKey];
    let depth = 0;
    while (fiber && depth < 30) {
      const props = fiber.memoizedProps;
      if (props?.onChange && typeof props.onChange === "function") {
        console.log("[MDSpin MAIN] Fiber onChange at depth", depth, "type:", fiber.type || fiber.elementType?.name);
        try {
          props.onChange({ target: input, currentTarget: input, type: "change", nativeEvent: new Event("change") });
          console.log("[MDSpin MAIN] Fiber onChange called successfully at depth", depth);
        } catch (err) {
          console.error("[MDSpin MAIN] Fiber onChange threw:", err);
        }
      }
      // Also look for onDrop handlers
      if (props?.onDrop && typeof props.onDrop === "function") {
        console.log("[MDSpin MAIN] Found onDrop at depth", depth);
      }
      fiber = fiber.return;
      depth++;
    }
  }

  // Fire native events
  input.dispatchEvent(new Event("change", { bubbles: true }));
  console.log("[MDSpin MAIN] Dispatched native change event");

  return true;
}

/**
 * Runs in Gemini's MAIN world — inserts markdown as text into the Quill editor.
 *
 * File attachment is impossible on Gemini (no file inputs, isTrusted blocks
 * synthetic drag-drop). Instead we insert text directly into the editor.
 */
function geminiMainWorldInjectFile(markdown: string, _mdFilename: string): boolean {
  const TAG = "[MDSpin MAIN Gemini]";
  console.log(`${TAG} Inserting text, length:`, markdown.length);

  const editor = document.querySelector<HTMLElement>('div.ql-editor[role="textbox"]');
  if (!editor) {
    console.error(`${TAG} Quill editor not found`);
    return false;
  }

  // Focus the editor
  editor.focus();

  // Clear the placeholder class if present (Quill adds ql-blank when empty)
  editor.classList.remove("ql-blank");

  // Try execCommand first — works well with contenteditable and Quill
  const success = document.execCommand("insertText", false, markdown);
  if (success) {
    console.log(`${TAG} Text inserted via execCommand`);
    // Dispatch input event so Angular detects the change
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  // Fallback: directly set content and fire events
  console.log(`${TAG} execCommand failed, using direct insertion`);
  const p = document.createElement("p");
  p.textContent = markdown;
  editor.innerHTML = "";
  editor.appendChild(p);

  // Fire input events for Angular/Quill to pick up
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: markdown,
  }));

  console.log(`${TAG} Text inserted via direct DOM`);
  return true;
}

/**
 * Resolve a Supabase access token for the conversion request.
 * Popup conversions pass a fresh token in the message. Inline (content-script)
 * conversions have none, so fall back to the session the popup mirrored into
 * chrome.storage.local — but only if it has not expired.
 */
async function getAccessToken(messageToken?: string | null): Promise<string | null> {
  if (messageToken) return messageToken;
  const { mdspinSession } = await chrome.storage.local.get("mdspinSession");
  if (mdspinSession?.access_token && typeof mdspinSession.expires_at === "number") {
    const nowSec = Math.floor(Date.now() / 1000);
    if (mdspinSession.expires_at > nowSec + 30) return mdspinSession.access_token;
  }
  return null;
}

async function convertFile(message: {
  fileName: string;
  fileData: string;
  fileType: string;
  accessToken?: string | null;
}): Promise<{ markdown?: string; error?: string; rateLimit?: { limit: number; remaining: number } }> {
  console.log("[MDSpin BG] Calling API...");

  // The web proxy expects multipart/form-data with a `file` field. Decode the
  // base64 payload into a Blob and upload it as a real file.
  const mimeType = message.fileType || guessMimeType(message.fileName);
  const bytes = Uint8Array.from(atob(message.fileData), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), message.fileName);

  // Attach the user's Supabase token when signed in — the proxy uses it to
  // resolve per-user quota. Anonymous conversions send no header (unchanged).
  const headers: Record<string, string> = {};
  const token = await getAccessToken(message.accessToken);
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    // Do NOT set Content-Type; fetch sets the multipart boundary itself.
    response = await fetch(API_URL, { method: "POST", body: form, headers });
  } catch (err) {
    console.error("[MDSpin BG] Fetch failed:", err);
    return { error: `Network error: ${err}` };
  }

  console.log("[MDSpin BG] Status:", response.status);

  // The proxy sends X-RateLimit-* on both success and 429, so parse once here and
  // surface quota to the popup in either case. Number(null) is 0 (and passes
  // Number.isFinite), so guard on header presence, not the parsed number.
  const limitHeader = response.headers.get("X-RateLimit-Limit");
  const remainingHeader = response.headers.get("X-RateLimit-Remaining");
  const rateLimit =
    limitHeader !== null && remainingHeader !== null
      ? { limit: Number(limitHeader), remaining: Number(remainingHeader) }
      : undefined;

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("[MDSpin BG] Error body:", errorText);
    // The proxy returns JSON like {"error":"...","message":"..."} — prefer the
    // human-readable message over the raw body.
    let errorMessage = errorText;
    try {
      const parsed = JSON.parse(errorText);
      errorMessage = parsed.message || parsed.error || errorText;
    } catch {
      /* non-JSON body — fall back to raw text */
    }
    if (response.status === 413) {
      return { error: "File is too large for the server to process." };
    }
    if (response.status === 415) {
      return { error: "This file type is not supported by the server." };
    }
    if (response.status === 429) {
      return { error: errorMessage || "Daily conversion limit reached. Try again later.", rateLimit };
    }
    return {
      error: errorMessage || `Conversion failed (HTTP ${response.status}). Please try again.`,
    };
  }

  const data = await response.json();
  console.log("[MDSpin BG] Response keys:", Object.keys(data));
  return { markdown: data.markdown_text ?? "", rateLimit };
}

function guessMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    rtf: "application/rtf",
    txt: "text/plain",
    csv: "text/csv",
    html: "text/html",
    pages: "application/x-iwork-pages-sffpages",
  };
  return map[ext] ?? "application/octet-stream";
}
