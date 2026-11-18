/**
 * Where a file tab should open (nightshift item 798): an evidence table's cell opens its source's stored
 * text at the quote. Set just before the tab is opened or brought forward; `FileView` for that path scrolls
 * to the range and marks it, once per request (`seq`), and leaves its scroll alone otherwise.
 * Offsets are Rust's character offsets in the file's text (`evidenceBlock.utf16Range` converts them).
 */
export interface FileFind {
  path: string;
  start: number;
  end: number;
  seq: number;
}

export const fileFind = $state<{ target: FileFind | null }>({ target: null });

let seq = 0;

export function findInFile(path: string, start: number, end: number): void {
  fileFind.target = { path, start, end, seq: ++seq };
}
