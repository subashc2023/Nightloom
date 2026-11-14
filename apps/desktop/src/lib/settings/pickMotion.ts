/**
 * Item 631 (his words, 2026-11-11: "If I click on Nightloom tab versus your
 * browser, it just kind of immediately changed with no animation rather than
 * like a slide"): one small motion for every choice in Settings, from one
 * place. Put `use:pickMotion` on a container; every radio group inside it
 * (`[role="radiogroup"]` whose options carry `aria-checked`) moves when its
 * pick changes — no per-control wiring, so a group added later moves too.
 *
 * - A segmented choice (`.seg`): the selection's ring **slides** from the old
 *   option to the new one (180 ms, ease-out) while the new option's fill
 *   fades in under it (looping page `notes/runner-design/631-segmented-loop.html`,
 *   option A, the pick).
 * - Any other radio group (the Accent / light / new-chat cards, the palette
 *   swatches, the Animations cards): the picked option's ring **pops** once
 *   (an outline that eases out, 260 ms) and its radio dot settles in.
 *
 * At rest nothing is added: the ghost ring exists only while it moves, so a
 * still screen is pixel-for-pixel what it was. Off under Classic (it keeps
 * today's look) and under Reduce motion. Styles: `pickMotion.css`.
 */
import "./pickMotion.css";

export const SLIDE_MS = 180;
export const POP_MS = 260;

function still(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.layout === "classic") return true;
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Slide a ring from `from` to `to` inside the segmented group `g`. */
function slide(g: HTMLElement, from: HTMLElement, to: HTMLElement): void {
  const gr = g.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (b.width === 0 || a.width === 0) return;
  if (getComputedStyle(g).position === "static") g.style.position = "relative";
  for (const old of g.querySelectorAll(":scope > .pick-ghost")) old.remove();
  const ghost = document.createElement("span");
  ghost.className = "pick-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const left = b.left - gr.left - g.clientLeft;
  const top = b.top - gr.top - g.clientTop;
  Object.assign(ghost.style, { left: `${left}px`, top: `${top}px`, width: `${b.width}px`, height: `${b.height}px` });
  g.appendChild(ghost);
  to.classList.add("pick-landing");
  const done = () => {
    ghost.remove();
    to.classList.remove("pick-landing");
  };
  if (typeof ghost.animate !== "function") {
    done();
    return;
  }
  const anim = ghost.animate(
    [
      { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)`, width: `${a.width}px`, height: `${a.height}px` },
      { transform: "translate(0, 0)", width: `${b.width}px`, height: `${b.height}px` },
    ],
    { duration: SLIDE_MS, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
  );
  anim.onfinish = done;
  anim.oncancel = done;
  setTimeout(done, SLIDE_MS + 200);
}

/** One ring pop on a picked card or swatch. */
function pop(el: HTMLElement): void {
  el.classList.remove("pick-pop");
  // Restart the animation when picked twice in a row.
  void el.offsetWidth;
  el.classList.add("pick-pop");
  setTimeout(() => el.classList.remove("pick-pop"), POP_MS + 60);
}

/**
 * From one batch of `aria-checked` changes, each group's new pick and the
 * option it left. Exported for the test.
 */
export function picksIn(records: MutationRecord[], root: Element): { group: HTMLElement; from: HTMLElement | null; to: HTMLElement }[] {
  const byGroup = new Map<HTMLElement, { from: HTMLElement | null; to: HTMLElement | null }>();
  for (const r of records) {
    if (r.type !== "attributes" || r.attributeName !== "aria-checked") continue;
    const el = r.target as HTMLElement;
    const group = el.closest<HTMLElement>('[role="radiogroup"]');
    if (!group || !root.contains(group)) continue;
    const now = el.getAttribute("aria-checked") === "true";
    const was = r.oldValue === "true";
    if (now === was) continue;
    const e = byGroup.get(group) ?? { from: null, to: null };
    if (now) e.to = el;
    else e.from = el;
    byGroup.set(group, e);
  }
  const out: { group: HTMLElement; from: HTMLElement | null; to: HTMLElement }[] = [];
  for (const [group, e] of byGroup) if (e.to) out.push({ group, from: e.from, to: e.to });
  return out;
}

export function pickMotion(node: HTMLElement): { destroy(): void } {
  if (typeof MutationObserver === "undefined") return { destroy() {} };
  const mo = new MutationObserver((records) => {
    if (still()) return;
    for (const { group, from, to } of picksIn(records, node)) {
      if (group.classList.contains("seg")) {
        if (from && from.isConnected) slide(group, from, to);
      } else pop(to);
    }
  });
  mo.observe(node, { subtree: true, attributes: true, attributeFilter: ["aria-checked"], attributeOldValue: true });
  return { destroy: () => mo.disconnect() };
}
