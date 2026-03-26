/**
 * Gemini site adapter — handles Gemini-specific DOM interactions
 * for file chip detection, composer focus, and markdown injection.
 *
 * Gemini uses Angular with custom elements (rich-textarea, input-area-v2,
 * uploader-file-preview) and a Quill-based contenteditable editor.
 *
 * NOTE: File attachment injection is impossible on Gemini — there are no
 * <input type="file"> elements, and synthetic drag-drop events are blocked
 * by Chrome's isTrusted security check. Instead, we insert markdown as text
 * directly into the Quill editor via MAIN world execCommand.
 */

import type { SiteAdapter } from "./adapter";
import { delay } from "./adapter";

export class GeminiAdapter implements SiteAdapter {
  readonly site = "gemini";

  getComposerArea(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>("input-area-v2 div.input-area") ??
      (document.querySelector<HTMLElement>('div.ql-editor[role="textbox"]')?.closest("div.input-area") as HTMLElement) ??
      document.querySelector<HTMLElement>("input-area-v2")
    );
  }

  findFileChipForName(fileName: string): Element | null {
    const baseName = fileName.replace(/\.[^.]+$/, "").substring(0, 20);
    const chips = document.querySelectorAll<HTMLElement>(
      "uploader-file-preview.file-preview-chip"
    );
    for (const chip of chips) {
      const text = chip.textContent?.trim() ?? "";
      // Gemini shows filename (sans extension) + type label, e.g. "Profile PDF"
      if (text.includes(baseName)) return chip;
    }
    return null;
  }

  findPromptBox(): HTMLElement | null {
    return document.querySelector<HTMLElement>("input-area-v2 div.input-area") ?? null;
  }

  async injectFileAsAttachment(markdown: string, mdFilename: string): Promise<boolean> {
    this.refocusComposer();
    await delay(200);

    // Insert markdown as text via MAIN world (Quill editor execCommand)
    console.log("[MDSpin] Trying Gemini injection: MAIN world text insertion...");
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "INJECT_MD_FILE_GEMINI",
        markdown,
        mdFilename,
      });
      console.log("[MDSpin] MAIN world response:", resp);

      if (resp?.success) {
        console.log("[MDSpin] Gemini text insertion succeeded!");
        return true;
      }
    } catch (err) {
      console.error("[MDSpin] MAIN world injection error:", err);
    }

    console.log("[MDSpin] Gemini injection failed — falling back to clipboard");
    return false;
  }

  refocusComposer(): void {
    const editor = document.querySelector<HTMLElement>('div.ql-editor[role="textbox"]');
    if (editor) {
      editor.focus();
      console.log("[MDSpin] Refocused Gemini editor");
    }
  }

  snapshotChipTexts(): Set<string> {
    const texts = new Set<string>();
    const chips = document.querySelectorAll<HTMLElement>(
      "uploader-file-preview.file-preview-chip"
    );
    for (const chip of chips) {
      const t = chip.textContent?.trim() ?? "";
      if (t.length > 0) texts.add(t);
    }
    return texts;
  }

  hasNewChip(before: Set<string>, mdFilename: string): boolean {
    const after = this.snapshotChipTexts();
    const baseName = mdFilename.replace(".md", "");
    for (const text of after) {
      if (!before.has(text) && (text.includes(".md") || text.includes(baseName))) {
        console.log("[MDSpin] New Gemini chip detected:", text);
        return true;
      }
    }
    return false;
  }
}
