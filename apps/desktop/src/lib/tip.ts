// Nightloom's own tooltip (nightshift backlog 171, pass 1, 2026-09-24).
//
// Every hover in the app was a native `title=`: WKWebView draws it as the
// OS's small grey box after about a second, in 11px text, outside the
// app's palette. Swaraag, beside a screenshot of the Claude app's dark
// pill: "hovers look like this nice clear text, but then in Nightloom they
// look like this ugly little box thing. Also the duration for a hover to
// trigger is like twice as long."
//
// `use:tip={text}` (or `use:tip={{ text, keys }}`) replaces the `title=`.
// One shared pill lives on `document.body` (the `portal` mechanism of
// backlog 163 — nothing an ancestor clips or stacks can reach it), placed
// by the anchor's rectangle in viewport coordinates: above the anchor when
// it fits, else below, centred on it and clamped inside the window.
//
// - Hover shows it after `TIP_DELAY_MS`; moving from one tipped control to
//   the next within `TIP_WARM_MS` of the last tip shows the next at once,
//   the way native tooltips run along a toolbar.
// - Keyboard focus (`:focus-visible`) shows it at once.
// - Leave, blur, Escape, a press, a scroll or a resize hide it.
// - The pill has `pointer-events: none` and is never under the pointer's
//   target, so it never takes a click.
// - While shown the anchor's `aria-describedby` names the pill; an anchor
//   with no text and no `aria-label` gets the tip as its `aria-label`, so
//   a screen reader keeps the name the `title` gave it.
//
// Pass 2 (2026-09-25): every other component's `title=` became `use:tip`
// (a codemod; `tip.test.ts` fails on any native `title=` left in a
// component). HTML the app builds as a string ({@html}: wiki links, a math
// error, the note editor's formula widget) carries `data-tip=` instead,
// and a document-level delegate (`installTipDelegate`) gives any element
// with `data-tip` — or a stray native `title`, e.g. a markdown link's
// `[a](url "title")` or KaTeX's error span — the same pill on first hover.

// 300 since 2026-09-25: 150 felt "too quick" to him (blocker 420); the
// test keeps it under the OS box's ~1 s.
export const TIP_DELAY_MS = 300;

/** An element the pill can anchor to (an SVG mark as well as HTML). */
export type TipAnchor = HTMLElement | SVGElement;
export const TIP_WARM_MS = 300;
const GAP = 6;
const MARGIN = 8;

export type TipArg = string | { text: string; keys?: string } | null | undefined | false;

interface TipContent {
  text: string;
  keys?: string;
}

function content(arg: TipArg): TipContent | null {
  if (!arg) return null;
  if (typeof arg === "string") return arg.trim() ? { text: arg } : null;
  return arg.text && arg.text.trim() ? { text: arg.text, keys: arg.keys } : null;
}

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Placement {
  top: number;
  left: number;
  side: "above" | "below";
}

/**
 * Where a pill of `w`×`h` goes for an anchor: above it when there is room
 * (`gap` px clear, `margin` px from the window's top), else below it when
 * there is room there, else whichever side has more room, clamped so its
 * top stays inside the window. Horizontally centred on the anchor and
 * clamped `margin` px inside either edge (a pill wider than the window
 * starts at the margin).
 */
export function placeTip(
  anchor: AnchorRect,
  w: number,
  h: number,
  vw: number,
  vh: number,
  gap = GAP,
  margin = MARGIN,
): Placement {
  const aboveTop = anchor.top - gap - h;
  const belowTop = anchor.bottom + gap;
  const fitsAbove = aboveTop >= margin;
  const fitsBelow = belowTop + h <= vh - margin;
  let side: "above" | "below";
  if (fitsAbove) side = "above";
  else if (fitsBelow) side = "below";
  else side = anchor.top >= vh - anchor.bottom ? "above" : "below";
  let top = side === "above" ? aboveTop : belowTop;
  top = Math.max(margin, Math.min(top, vh - h - margin));
  let left = (anchor.left + anchor.right) / 2 - w / 2;
  left = Math.min(left, vw - w - margin);
  left = Math.max(left, margin);
  return { top: Math.round(top), left: Math.round(left), side };
}

/**
 * The timing rule alone, free of the DOM so it can be tested: `enter`
 * (hover) shows after the delay, or at once while warm; `focus` shows at
 * once; `leave` and `dismiss` hide and cancel a pending show. `dismiss`
 * (a press, Escape) also cools, so the next hover waits the full delay.
 */
export function tipTimer(opts: {
  show: () => void;
  hide: () => void;
  delay?: number;
  warm?: number;
  now?: () => number;
}): { enter(): void; focus(): void; leave(): void; dismiss(): void; readonly shown: boolean } {
  const delay = opts.delay ?? TIP_DELAY_MS;
  const warm = opts.warm ?? TIP_WARM_MS;
  const now = opts.now ?? (() => Date.now());
  let pending: ReturnType<typeof setTimeout> | null = null;
  let shown = false;
  const cancel = () => {
    if (pending !== null) clearTimeout(pending);
    pending = null;
  };
  const open = () => {
    cancel();
    if (!shown) {
      shown = true;
      opts.show();
    }
  };
  const close = (cool: boolean) => {
    cancel();
    if (shown) {
      shown = false;
      opts.hide();
      lastHidden = cool ? -Infinity : now();
    }
  };
  return {
    enter() {
      if (shown || pending !== null) return;
      if (now() - lastHidden <= warm) open();
      else pending = setTimeout(open, delay);
    },
    focus: open,
    leave: () => close(false),
    dismiss: () => close(true),
    get shown() {
      return shown;
    },
  };
}

/**
 * The composer's Send tip (backlog 171; walk 2026-09-25 part 2: "no pill
 * on the disabled Send" — the button had no tip at all). A disabled Send
 * says why it is disabled; an enabled one says what it does and its key.
 */
export function sendTip(connected: boolean, empty: boolean, held = false): { text: string; keys?: string } {
  if (!connected) return { text: "Nothing to send to yet — no model is connected" };
  // Item 222: a rail change is being connected; the message waits for it.
  if (held) return { text: "Applying the rail's new settings — Send is back in a moment" };
  if (empty) return { text: "Type a message or attach a file to send", keys: "↵" };
  return { text: "Send this message", keys: "↵" };
}

// When the last pill was hidden, shared across every anchor so the warm
// run spans controls.
let lastHidden = -Infinity;

/** For tests: forget the warm run. */
export function coolTips(): void {
  lastHidden = -Infinity;
}

let pill: HTMLDivElement | null = null;
let pillText: HTMLSpanElement | null = null;
let pillKeys: HTMLSpanElement | null = null;
let owner: TipAnchor | null = null;
let seq = 0;
const PILL_ID = "nl-tip";

function ensurePill(): HTMLDivElement {
  if (pill && pill.isConnected) return pill;
  pill = document.createElement("div");
  pill.id = PILL_ID;
  pill.className = "nl-tip";
  pill.setAttribute("role", "tooltip");
  pillText = document.createElement("span");
  pillText.className = "nl-tip-text";
  pillKeys = document.createElement("span");
  pillKeys.className = "nl-tip-keys";
  pill.append(pillText, pillKeys);
  document.body.appendChild(pill);
  return pill;
}

function fill(c: TipContent): void {
  ensurePill();
  pillText!.textContent = c.text;
  pillKeys!.textContent = c.keys ?? "";
  pillKeys!.hidden = !c.keys;
}

function position(anchor: TipAnchor): void {
  const el = ensurePill();
  // Measured at the window's origin (a fixed box's fitted width depends on
  // the room to its right, so the last spot would skew it), then placed;
  // both happen before the next paint.
  el.style.top = "0px";
  el.style.left = "0px";
  const r = anchor.getBoundingClientRect();
  const p = placeTip(r, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight);
  el.style.top = `${p.top}px`;
  el.style.left = `${p.left}px`;
  el.dataset.side = p.side;
}

// Open menus (backlog 210): while any is open, only an anchor inside one
// may show the pill — a tip from the page under a menu ("Show this folder"
// on the Welcome page) was drawn over it.
const menus = new Set<Element>();

/** Whether `node` may show its pill now: no menu open, or it is inside one. */
export function tipAllowed(node: Node): boolean {
  if (menus.size === 0) return true;
  for (const m of menus) if (m.contains(node)) return true;
  return false;
}

/**
 * A menu opens: the pill showing for anything outside it hides, and no
 * such pill shows until the returned release is called (the menu closes).
 */
export function holdTips(menu: Element): () => void {
  menus.add(menu);
  if (owner && !tipAllowed(owner)) owner.dispatchEvent(new CustomEvent("nl-tip-release"));
  return () => {
    menus.delete(menu);
  };
}

/** Svelte action: Nightloom's tooltip on this element. */
export function tip(node: TipAnchor, arg: TipArg): { update(arg: TipArg): void; destroy(): void } {
  let c = content(arg);
  const id = ++seq;
  let labelled = false;

  const syncLabel = () => {
    const needs = !!c && !node.hasAttribute("aria-label") && !(node.textContent ?? "").trim();
    if (needs) {
      node.setAttribute("aria-label", c!.text);
      labelled = true;
    } else if (labelled) {
      if (c) node.setAttribute("aria-label", c.text);
      else {
        node.removeAttribute("aria-label");
        labelled = false;
      }
    }
  };

  const onScroll = () => timer.leave();
  const show = () => {
    if (!c || !node.isConnected || !tipAllowed(node)) return;
    // Another anchor's pill hands over.
    if (owner && owner !== node) owner.dispatchEvent(new CustomEvent("nl-tip-release"));
    owner = node;
    fill(c);
    const el = ensurePill();
    el.dataset.owner = String(id);
    el.classList.add("shown");
    position(node);
    node.setAttribute("aria-describedby", PILL_ID);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
  };
  const hide = () => {
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    if (node.getAttribute("aria-describedby") === PILL_ID) node.removeAttribute("aria-describedby");
    if (owner !== node) return;
    owner = null;
    pill?.classList.remove("shown");
  };
  const timer = tipTimer({ show, hide });

  const onEnter = () => timer.enter();
  const onLeave = () => timer.leave();
  const onFocus = () => {
    let keyboard = true;
    try {
      keyboard = node.matches(":focus-visible");
    } catch {
      /* an engine without :focus-visible shows it on every focus */
    }
    if (keyboard) timer.focus();
  };
  const onBlur = () => timer.leave();
  const onDown = () => timer.dismiss();
  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key === "Escape" && timer.shown) timer.dismiss();
  };
  const onRelease = () => timer.leave();

  node.addEventListener("pointerenter", onEnter);
  node.addEventListener("pointerleave", onLeave);
  node.addEventListener("focus", onFocus);
  node.addEventListener("blur", onBlur);
  node.addEventListener("pointerdown", onDown);
  node.addEventListener("keydown", onKey);
  node.addEventListener("nl-tip-release", onRelease);
  syncLabel();

  return {
    update(next: TipArg) {
      c = content(next);
      syncLabel();
      if (!c) timer.leave();
      else if (timer.shown && owner === node) {
        fill(c);
        position(node);
      }
    },
    destroy() {
      timer.leave();
      node.removeEventListener("pointerenter", onEnter);
      node.removeEventListener("pointerleave", onLeave);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("blur", onBlur);
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("keydown", onKey);
      node.removeEventListener("nl-tip-release", onRelease);
      if (labelled) node.removeAttribute("aria-label");
    },
  };
}

/** Tags whose `title` names embedded content for a screen reader; WebKit
 *  draws no tooltip over them that the delegate should replace. */
const FRAME_TAGS = new Set(["IFRAME", "EMBED", "OBJECT"]);

/**
 * The element a pointer or focus at `target` should tip through the
 * delegate: the nearest ancestor-or-self with `data-tip`, or with a native
 * `title` (not a frame's). A stray `title` is moved to `data-tip` so the OS
 * box never shows beside the pill. Null when there is nothing to tip or
 * the element already has its delegated action.
 */
export function delegateTarget(target: EventTarget | null): TipAnchor | null {
  const start = target as Element | null;
  if (!start || typeof start.closest !== "function") return null;
  const el = start.closest("[data-tip], [title]") as TipAnchor | null;
  if (!el || FRAME_TAGS.has(el.tagName.toUpperCase()) || delegated.has(el)) return null;
  const native = el.getAttribute("title");
  if (native !== null) {
    if (!el.hasAttribute("data-tip")) el.setAttribute("data-tip", native);
    el.removeAttribute("title");
  }
  return el.getAttribute("data-tip") ? el : null;
}

const delegated = new WeakSet<Element>();
let delegateInstalled = false;

/**
 * Once per document: hovering or focusing an element with `data-tip` (or a
 * stray native `title`) attaches `tip` to it and replays the enter/focus,
 * so string-built HTML gets the same pill as a component's `use:tip`.
 */
export function installTipDelegate(doc: Document = document): void {
  if (delegateInstalled) return;
  delegateInstalled = true;
  const adopt = (e: Event, replay: string) => {
    const el = delegateTarget(e.target);
    if (!el) return;
    delegated.add(el);
    const action = tip(el, el.getAttribute("data-tip"));
    // A later change to `data-tip` (a link re-resolved) follows.
    new MutationObserver(() => action.update(el.getAttribute("data-tip"))).observe(el, {
      attributes: true,
      attributeFilter: ["data-tip"],
    });
    el.dispatchEvent(new Event(replay));
  };
  doc.addEventListener("pointerover", (e) => adopt(e, "pointerenter"), true);
  doc.addEventListener("focusin", (e) => adopt(e, "focus"), true);
}

if (typeof document !== "undefined") installTipDelegate();
