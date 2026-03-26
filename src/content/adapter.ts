/**
 * Site adapter interface — each supported AI chat platform
 * implements this to provide platform-specific DOM interactions.
 */
export interface SiteAdapter {
  /** Unique site identifier (e.g. "chatgpt", "gemini") */
  readonly site: string;

  /** Returns the composer/input area container element */
  getComposerArea(): HTMLElement | null;

  /** Finds the DOM element for a file chip matching the given filename */
  findFileChipForName(fileName: string): Element | null;

  /** Finds the visible prompt box for MDSpin button positioning */
  findPromptBox(): HTMLElement | null;

  /** Injects a converted .md file as a native attachment. Returns true on success. */
  injectFileAsAttachment(markdown: string, mdFilename: string): Promise<boolean>;

  /** Restores focus to the composer after button clicks */
  refocusComposer(): void;

  /** Snapshots current chip texts for change detection */
  snapshotChipTexts(): Set<string>;

  /** Checks whether a new chip appeared after injection */
  hasNewChip(before: Set<string>, mdFilename: string): boolean;
}

/** Shared delay utility */
export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
