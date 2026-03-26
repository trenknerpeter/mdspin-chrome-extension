/**
 * Claude site adapter — handles Claude.ai-specific DOM interactions
 * for file chip detection, composer focus, and file injection.
 *
 * Claude uses React with a Tiptap/ProseMirror contenteditable editor.
 * File uploads work via a hidden <input type="file"> that accepts all types.
 * Setting input.files + dispatching a native change event is sufficient
 * to trigger Claude's file upload handler (no MAIN world injection needed).
 */

import type { SiteAdapter } from "./adapter";
import { delay } from "./adapter";

export class ClaudeAdapter implements SiteAdapter {
  readonly site = "claude";

  getComposerArea(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>("fieldset.flex.w-full") ??
      document.querySelector<HTMLElement>('[data-testid="chat-input"]')?.closest("fieldset") as HTMLElement ??
      null
    );
  }

  findFileChipForName(fileName: string): Element | null {
    const baseName = fileName.replace(/\.[^.]+$/, "").substring(0, 20);
    // Claude uses .group/thumbnail wrappers — NOT data-testid="file-thumbnail"
    const thumbs = document.querySelectorAll<HTMLElement>('.group\\/thumbnail');
    for (const thumb of thumbs) {
      // data-testid on inner div equals the full filename (e.g. "Profile.pdf")
      const inner = thumb.querySelector<HTMLElement>("[data-testid]");
      if (inner?.dataset.testid?.includes(baseName)) return thumb;

      // aria-label on remove button: "Remove <filename>"
      const removeBtn = thumb.querySelector<HTMLElement>('button[aria-label^="Remove"]');
      const ariaLabel = removeBtn?.getAttribute("aria-label") ?? "";
      if (ariaLabel.includes(baseName)) return thumb;
    }
    return null;
  }

  findPromptBox(): HTMLElement | null {
    return this.getComposerArea();
  }

  async injectFileAsAttachment(markdown: string, mdFilename: string): Promise<boolean> {
    this.refocusComposer();
    await delay(200);

    const chipsBefore = this.snapshotChipTexts();
    console.log("[MDSpin] Chips before injection:", chipsBefore.size, "texts");

    // === Approach A: File input with native change event ===
    console.log("[MDSpin] Trying Claude injection: file input + change event...");
    try {
      const mdFile = new File([markdown], mdFilename, {
        type: "text/plain",
        lastModified: Date.now(),
      });

      const input = document.querySelector<HTMLInputElement>(
        'input[data-testid="file-upload"]'
      );
      if (!input) {
        console.log("[MDSpin] No file input found");
      } else {
        const dt = new DataTransfer();
        dt.items.add(mdFile);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));

        console.log("[MDSpin] Dispatched change event, files:", input.files?.length);

        await delay(1500);
        if (this.hasNewChip(chipsBefore, mdFilename)) {
          console.log("[MDSpin] Claude file injection succeeded!");
          return true;
        }
        console.log("[MDSpin] No new chip detected after file input approach");
      }
    } catch (err) {
      console.error("[MDSpin] File input approach error:", err);
    }

    // No text fallback for Claude — dumping raw markdown into the composer
    // is never useful. The caller in index.ts handles clipboard fallback.
    console.log("[MDSpin] File input approach failed — falling back to clipboard");
    return false;
  }

  refocusComposer(): void {
    const editor = document.querySelector<HTMLElement>('[data-testid="chat-input"]');
    if (editor) {
      editor.focus();
      console.log("[MDSpin] Refocused Claude editor");
    }
  }

  snapshotChipTexts(): Set<string> {
    const texts = new Set<string>();
    // Use data-testid values (actual filenames) rather than textContent (just shows "pdf")
    const thumbs = document.querySelectorAll<HTMLElement>('.group\\/thumbnail');
    for (const thumb of thumbs) {
      const inner = thumb.querySelector<HTMLElement>("[data-testid]");
      const testId = inner?.dataset.testid ?? "";
      if (testId.length > 0) texts.add(testId);
    }
    return texts;
  }

  hasNewChip(before: Set<string>, mdFilename: string): boolean {
    const after = this.snapshotChipTexts();
    const baseName = mdFilename.replace(".md", "");
    for (const text of after) {
      if (!before.has(text) && (text.includes(".md") || text.includes(baseName))) {
        console.log("[MDSpin] New Claude chip detected:", text);
        return true;
      }
    }
    return false;
  }
}
