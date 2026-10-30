// Item 452 — a reply's HTML patched in place rather than replaced whole.
//
// `{@html}` removes every node of a block and inserts the new HTML whenever
// the string changes, which a streaming reply does on every delta. A text
// selection whose ends sit in those nodes then collapses before Cmd-C (his
// report, 2026-10-28). `liveHtml` keeps what did not change: it keeps the
// HTML it last drew as an inert tree, compares the new HTML with that tree
// (not with the live DOM, which other code decorates), and touches only the
// nodes that differ — a text node that grew gets the new words appended, so
// a selection in its older part stays where it was.
//
// The live DOM may carry other code's additions, which the walk allows for:
// the motion's word spans and the memory-reference links (both split one
// text node of the drawn HTML into several nodes — a "text run"), and the
// code blocks' Copy buttons (skipped). Anything else it cannot line up with
// the drawn tree is redrawn whole, as `{@html}` would have.

/** Elements that stand inside a text run of the drawn HTML (replyMotion, memoryOpen). */
function inRun(n: Node): boolean {
  if (n.nodeType === Node.TEXT_NODE) return true;
  if (!(n instanceof Element)) return false;
  return (n.tagName === "SPAN" && n.classList.contains("rm-w")) || (n.tagName === "A" && n.classList.contains("mem-ref"));
}

/** Nodes other code adds that have no counterpart in the drawn HTML (codeCopy). */
function extra(n: Node): boolean {
  return n instanceof Element && n.tagName === "BUTTON" && n.classList.contains("code-copy");
}

/** One counterpart of a drawn node in the live DOM: a single element, or a run of text pieces. */
interface Unit {
  text: boolean;
  nodes: Node[];
}

function unitsOf(live: Node): Unit[] {
  const out: Unit[] = [];
  for (const c of Array.from(live.childNodes)) {
    if (extra(c)) continue;
    if (inRun(c)) {
      const last = out[out.length - 1];
      if (last?.text) last.nodes.push(c);
      else out.push({ text: true, nodes: [c] });
    } else out.push({ text: false, nodes: [c] });
  }
  return out;
}

function sameAttrs(a: Element, b: Element): boolean {
  if (a.attributes.length !== b.attributes.length) return false;
  for (const at of Array.from(a.attributes)) if (b.getAttribute(at.name) !== at.value) return false;
  return true;
}

/** Whether the live children line up one to one with the drawn ones. */
function lines(units: Unit[], prev: Node): boolean {
  const p = prev.childNodes;
  if (units.length !== p.length) return false;
  for (let i = 0; i < p.length; i++) {
    const isText = p[i].nodeType === Node.TEXT_NODE;
    if (units[i].text !== isText) return false;
    if (!isText) {
      const el = units[i].nodes[0] as Element;
      if (!(p[i] instanceof Element) || el.tagName !== (p[i] as Element).tagName) return false;
    }
  }
  return true;
}

function redraw(live: Node, next: Node): void {
  while (live.firstChild) live.removeChild(live.firstChild);
  for (const c of Array.from(next.childNodes)) live.appendChild(c.cloneNode(true));
}

/** The text a run shows (its pieces' text, in order). */
function runText(u: Unit): string {
  return u.nodes.map((n) => n.textContent ?? "").join("");
}

/**
 * Make `live` (drawn from `prev`, perhaps decorated since) show `next`,
 * changing only what differs. `prev` and `next` are inert trees.
 * Returns how many live nodes were replaced or added (for the harness).
 */
export function patch(live: Node, prev: Node, next: Node): number {
  const units = unitsOf(live);
  if (!lines(units, prev)) {
    redraw(live, next);
    return next.childNodes.length;
  }
  const p = prev.childNodes;
  const n = next.childNodes;
  let touched = 0;
  // Where a node added at the end goes: after the last unit (before any extra, e.g. a Copy button).
  let tail: Node | null = units.length ? units[units.length - 1].nodes[units[units.length - 1].nodes.length - 1] : null;
  const insertAfter = (ref: Node | null, node: Node) => {
    if (ref) live.insertBefore(node, ref.nextSibling);
    else live.insertBefore(node, live.firstChild);
    return node;
  };
  for (let i = 0; i < Math.max(p.length, n.length); i++) {
    if (i >= n.length) {
      for (const x of units[i].nodes) live.removeChild(x);
      continue;
    }
    if (i >= p.length) {
      tail = insertAfter(tail, n[i].cloneNode(true));
      touched++;
      continue;
    }
    const u = units[i];
    const last = u.nodes[u.nodes.length - 1];
    if (p[i].isEqualNode(n[i])) continue;
    if (u.text && n[i].nodeType === Node.TEXT_NODE) {
      const was = (p[i] as Text).data;
      const now = (n[i] as Text).data;
      if (now.startsWith(was) && runText(u) === was) {
        // The words that arrived, after the ones already there.
        const more = now.slice(was.length);
        if (last.nodeType === Node.TEXT_NODE) (last as Text).appendData(more);
        else {
          // Item 480: the run now ends in this new node, so a node new to the
          // HTML (the next `$…$`) goes after it — not after the motion's span,
          // which drew "bec" [Y] "." "omes" for "becomes $Y$.".
          const t = live.insertBefore(document.createTextNode(more), last.nextSibling);
          if (tail === last) tail = t;
        }
      } else {
        const t = document.createTextNode(now);
        live.insertBefore(t, u.nodes[0]);
        for (const x of u.nodes) live.removeChild(x);
        if (tail && u.nodes.includes(tail)) tail = t;
        touched++;
      }
      continue;
    }
    const el = u.nodes[0];
    const pe = p[i];
    const ne = n[i];
    if (!u.text && pe instanceof Element && ne instanceof Element && pe.tagName === ne.tagName && sameAttrs(pe, ne)) {
      touched += patch(el, pe, ne);
      continue;
    }
    const fresh = ne.cloneNode(true);
    live.insertBefore(fresh, u.nodes[0]);
    for (const x of u.nodes) live.removeChild(x);
    if (tail && u.nodes.includes(tail)) tail = fresh;
    touched++;
  }
  return touched;
}

/** How often the text check redrew a block whole (the harnesses read it; 0 when `patch` is right). */
export const liveHtmlStats = { fallbacks: 0 };

/** The text `live` shows, less the nodes other code adds (Copy buttons) — comparable with the drawn tree's. */
export function shownText(live: Node): string {
  let s = "";
  for (const c of Array.from(live.childNodes)) {
    if (extra(c)) continue;
    s += c.nodeType === Node.TEXT_NODE ? (c as Text).data : shownText(c);
  }
  return s;
}

function parse(html: string): DocumentFragment {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
}

/**
 * `use:liveHtml={html}` in place of `{@html html}` on an element with no
 * other children. The HTML must already be sanitized (as `renderReply`'s is).
 */
export function liveHtml(node: HTMLElement, html: string) {
  let last = html;
  let prev = parse(html);
  redraw(node, prev);
  return {
    update(next: string) {
      if (next === last) return;
      const tree = parse(next);
      patch(node, prev, tree);
      // Item 480: the patched DOM must read exactly as a full render; if it
      // ever does not, draw it whole (as `{@html}` would have).
      if (shownText(node) !== tree.textContent) {
        redraw(node, tree);
        liveHtmlStats.fallbacks++;
      }
      prev = tree;
      last = next;
    },
  };
}
