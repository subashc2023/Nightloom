/**
 * Whether the message box draws its formatting in place (nightshift item
 * 276): math typeset, bold / italic / headings styled, source back under the
 * cursor. A toggle beside the transcript's "thinking" and "tools", kept in
 * localStorage the way those are (`transcriptPrefs.svelte.ts`). Off by
 * default — his words: "sometimes im not doing any of that but i have those
 * sorts of symbols" — and off is the plain textarea, unchanged.
 */
const KEY = "nightloom.composer.format";

export function loadComposerFormat(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveComposerFormat(on: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, on ? "1" : "0");
  } catch {
    // best-effort
  }
}

export const composerFormat = $state({
  on: typeof localStorage === "undefined" ? false : loadComposerFormat(),
});

export function toggleComposerFormat(): void {
  composerFormat.on = !composerFormat.on;
  saveComposerFormat(composerFormat.on);
}
