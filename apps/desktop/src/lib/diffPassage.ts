/*
 * A selection inside a tool card's diff (`EditDiffView`) as a passage to
 * comment on (item 754). The diff's lines are rows of a mark (`+`, `−`,
 * space) and the text; `Selection.toString()` joins rows with no newline,
 * so the passage is rebuilt from the rows the selection touches, each as a
 * unified-diff line, under the file's path. Comment only: Ask aside and
 * Reply stay on prose.
 */

export interface DiffRow {
  kind: "add" | "del" | "ctx";
  text: string;
}

/** The rows as unified-diff text under a `--- path` / `+++ path` header. Pure. */
export function diffQuote(path: string, rows: readonly DiffRow[]): string {
  const body = rows.map((r) => (r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ") + r.text);
  const head = path ? [`--- ${path}`, `+++ ${path}`] : [];
  return [...head, ...body].join("\n");
}

function elementOf(n: Node | null): Element | null {
  if (!n) return null;
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

/**
 * The passage for a selection whose both ends are in one diff body inside
 * `viewport` (and not inside a transcript nested in it, an aside card's),
 * or null.
 */
export function diffPassage(sel: Selection | null, viewport: Element): { text: string; range: Range } | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const a = elementOf(sel.anchorNode)?.closest(".ed-body") ?? null;
  const b = elementOf(sel.focusNode)?.closest(".ed-body") ?? null;
  if (!a || a !== b || !viewport.contains(a)) return null;
  const t = a.closest(".transcript, .aside-thread");
  if (t && t !== viewport && viewport.contains(t)) return null;
  const range = sel.getRangeAt(0);
  const rows: DiffRow[] = [];
  for (const row of Array.from(a.querySelectorAll(".ed-line:not(.sep)"))) {
    if (!range.intersectsNode(row)) continue;
    const kind = row.classList.contains("add") ? "add" : row.classList.contains("del") ? "del" : "ctx";
    rows.push({ kind, text: row.querySelector(".ed-text")?.textContent ?? "" });
  }
  if (rows.length === 0) return null;
  const path = a.closest(".edit-diff")?.querySelector(".ed-path")?.textContent?.trim() ?? "";
  return { text: diffQuote(path, rows), range };
}
