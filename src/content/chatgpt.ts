/**
 * ChatGPT site adapter — handles ChatGPT-specific DOM interactions
 * for file chip detection, composer focus, and file injection.
 */

import type { SiteAdapter } from "./adapter";
import { delay } from "./adapter";

export class ChatGPTAdapter implements SiteAdapter {
  readonly site = "chatgpt";

  getComposerArea(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>('form[class*="composer"]') ??
      (document.querySelector<HTMLElement>("#prompt-textarea")?.closest("form") as HTMLElement) ??
      document.querySelector<HTMLElement>("form") ??
      document.querySelector<HTMLElement>('[class*="composer"]')
    );
  }

  findFileChipForName(fileName: string): Element | null {
    const composerArea = this.getComposerArea();
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

  findPromptBox(): HTMLElement | null {
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

  async injectFileAsAttachment(markdown: string, mdFilename: string): Promise<boolean> {
    this.refocusComposer();
    await delay(200);

    const chipsBefore = this.snapshotChipTexts();
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

      await delay(1500);
      if (this.hasNewChip(chipsBefore, mdFilename)) {
        console.log("[MDSpin] Approach A succeeded!");
        return true;
      }
      console.log("[MDSpin] Approach A: no new .md chip detected");
    } catch (err) {
      console.error("[MDSpin] Approach A error:", err);
    }

    // === Approach B: Simple file input ===
    this.refocusComposer();
    await delay(200);

    console.log("[MDSpin] Trying Approach B: simple file input...");
    try {
      const mdFile = new File([markdown], mdFilename, {
        type: "text/markdown",
        lastModified: Date.now(),
      });

      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) {
        console.log("[MDSpin] No file input found");
      } else {
        console.log("[MDSpin] Found file input:", input.id, "accept:", input.accept);

        const dt = new DataTransfer();
        dt.items.add(mdFile);
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));

        console.log("[MDSpin] Dispatched change event, files:", input.files?.length);

        await delay(1500);
        if (this.hasNewChip(chipsBefore, mdFilename)) {
          console.log("[MDSpin] Approach B succeeded!");
          return true;
        }
        console.log("[MDSpin] Approach B: no new .md chip detected");
      }
    } catch (err) {
      console.error("[MDSpin] Approach B error:", err);
    }

    // === Approach C: Drag-and-drop on composer ===
    this.refocusComposer();
    await delay(200);

    console.log("[MDSpin] Trying Approach C: drag-and-drop...");
    try {
      const mdFile = new File([markdown], mdFilename, {
        type: "text/markdown",
        lastModified: Date.now(),
      });

      const dropTarget =
        document.querySelector<HTMLElement>('form[class*="composer"]') ??
        (document.querySelector<HTMLElement>("#prompt-textarea")?.closest("form") as HTMLElement) ??
        document.querySelector<HTMLElement>("#prompt-textarea");

      if (dropTarget) {
        const dt = new DataTransfer();
        dt.items.add(mdFile);
        const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
        dropTarget.dispatchEvent(new DragEvent("dragenter", opts));
        dropTarget.dispatchEvent(new DragEvent("dragover", opts));
        dropTarget.dispatchEvent(new DragEvent("drop", opts));

        await delay(1500);
        if (this.hasNewChip(chipsBefore, mdFilename)) {
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

  refocusComposer(): void {
    const textarea = document.querySelector<HTMLElement>("#prompt-textarea");
    if (textarea) {
      textarea.focus();
      console.log("[MDSpin] Refocused prompt textarea");
    }
  }

  snapshotChipTexts(): Set<string> {
    const composer = this.getComposerArea();
    if (!composer) return new Set();
    const texts = new Set<string>();
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

  hasNewChip(before: Set<string>, mdFilename: string): boolean {
    const after = this.snapshotChipTexts();
    for (const text of after) {
      if (!before.has(text) && (text.includes(".md") || text.includes(mdFilename.replace(".md", "")))) {
        console.log("[MDSpin] New chip text detected:", text);
        return true;
      }
    }
    return false;
  }
}
