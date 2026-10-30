/**
 * Tabs whose view stays mounted while another tab is in front (item 487,
 * 2026-10-30: "save where i'm scrolled at on a pdf or something at least
 * while its open as a tab … its painful scrolling back down every time i
 * switch tabs" — and the same for every kind of tab).
 *
 * A pane draws only its active tab, so a tab sent to the back was destroyed
 * and drawn again on the way forward, at the top. For most views a remembered
 * `scrollTop` would do (`tabPlace.ts`), but not for a PDF: it is WebKit's own
 * PDF view inside an `<embed>`, whose place no script can read or set. The
 * probe (`notes/runner-design/487-harness/pdfprobe.swift`) found that the PDF
 * keeps its page only if the element itself survives, hidden with
 * `visibility: hidden` (not `display: none`, not removed and put back).
 *
 * So these kinds — the read-only views and the note — stay mounted in their
 * pane once visited, hidden while another tab is in front: the PDF keeps its
 * page and zoom, a note its caret, selection, undo and scroll, a file its
 * Plain/Formatted and image-size switches. The chat and the aside keep their
 * place their own way (065 and 237's scroll map; the transcript is the live
 * chat's and too heavy to keep twice), a web tab's page is a native view
 * that is hidden, not closed, and the singletons (Nightshift, the graph, New
 * project) keep their state in `app` — their scroll is `tabPlace.ts`'s.
 *
 * At most `KEEP_PER_PANE` per pane, the least recently shown dropped first
 * (it then opens as it always did). Kept in the order they were first shown,
 * never re-sorted: moving a mounted `<embed>` in the DOM reloads the PDF.
 * A tab moved to the other pane is drawn afresh there (a node cannot move
 * without the same reload).
 */
import type { Pane, Tab, TabContent } from "./tabs";

export const KEEP_PER_PANE = 6;

/** The kinds kept mounted (see above for the others). An attachment chip in
 *  a message box (`draft`) only ever floats, and is never a pane's tab. */
export function isKeptKind(c: TabContent): boolean {
  if (c.kind === "attachment") return !c.draft;
  return (
    c.kind === "note" ||
    c.kind === "file" ||
    c.kind === "thread" ||
    c.kind === "subagent"
  );
}

interface Entry {
  id: string;
  /** When it was last in front (a counter, not a clock). */
  seen: number;
}

/** Per pane, in the order first shown. Not reactive: `keptIn` is read in
 *  the template with the active tab, which is what changes. */
const kept = new Map<string, Entry[]>();
let clock = 0;

/**
 * The pane's kept list once `active` is in front: `active` added (or its
 * `seen` bumped) when it is a kept kind, tabs no longer in the pane dropped,
 * then the least recently seen dropped past `cap`. Order is kept.
 */
export function nextKept(
  list: readonly Entry[],
  live: ReadonlySet<string>,
  active: string | null,
  now: number,
  cap = KEEP_PER_PANE,
): Entry[] {
  let out = list
    .filter((e) => live.has(e.id))
    .map((e) => (e.id === active ? { id: e.id, seen: now } : e));
  if (active !== null && live.has(active) && !out.some((e) => e.id === active))
    out.push({ id: active, seen: now });
  while (out.length > cap) {
    let oldest = 0;
    for (let i = 1; i < out.length; i++)
      if (out[i].seen < out[oldest].seen) oldest = i;
    if (out[oldest].id === active) break;
    out = out.filter((_, i) => i !== oldest);
  }
  return out;
}

/**
 * The tabs to draw in `pane` by the kept block — the active one among them
 * when it is a kept kind, the rest hidden. Called from the template with the
 * pane's active tab, so it runs whenever the front tab or the pane's tabs
 * change.
 */
export function keptIn(pane: Pane, active: Tab): Tab[] {
  const byId = new Map(
    pane.tabs.filter((t) => isKeptKind(t.content)).map((t) => [t.id, t]),
  );
  const prev = kept.get(pane.id) ?? [];
  const front = isKeptKind(active.content) ? active.id : null;
  const changed =
    front !== null && prev.find((e) => e.id === front)?.seen !== clock;
  const next = nextKept(
    prev,
    new Set(byId.keys()),
    front,
    changed ? ++clock : clock,
  );
  kept.set(pane.id, next);
  return next.map((e) => byId.get(e.id)!);
}

/** For the suite. */
export function resetKept(): void {
  kept.clear();
  clock = 0;
}

/**
 * The action on a kept tab's content box: while it is hidden (`away`), it
 * keeps the box it had in front — taken out of the pane's flow, at the same
 * top and height — so nothing inside is laid out again at another size (a
 * file scrolled to its end would otherwise be clamped a strip's height up).
 */
export function keptBox(node: HTMLElement, away: boolean) {
  let last = { top: 0, height: 0 };
  const measure = () => {
    if (!node.classList.contains("away"))
      last = { top: node.offsetTop, height: node.offsetHeight };
  };
  const ro = new ResizeObserver(measure);
  ro.observe(node);
  measure();
  const apply = (a: boolean) => {
    if (a && last.height > 0) {
      node.style.top = `${last.top}px`;
      node.style.height = `${last.height}px`;
    } else {
      node.style.top = "";
      node.style.height = "";
      measure();
    }
  };
  apply(away);
  return { update: apply, destroy: () => ro.disconnect() };
}
