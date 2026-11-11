// The one shared menu (item 620, 2026-11-11; his pick, blocker 1855: "i like
// hud the most for project dropdown" — B, HUD brackets, on every menu).
//
// A menu joins by three things in its markup, and styles nothing of this
// itself:
//
//   <div class="… hud-m" in:hudIn|global out:hudOut|global> … </div>
//
//   `hud-m`     the card: darker glass, an amber-tinted edge, a deep shadow
//   `hud-row`   a row that can be picked (one hover for all: the well fill
//               and a thin amber lead); `hud-cur` on the current one. A
//               `role="menuitem"` / `menuitemradio` / `option` inside the
//               card is a row without the class (`aria-checked` = current)
//   `hud-head`  the mono, ruled, uppercase title; `hud-rule` a separator
//
// The motion (hudMenu.css):
//   open     220 ms — four amber corner brackets spring out of the button
//            (or the pointer, for a right-click menu) to the card's corners,
//            and the glass and its parts fill in behind them
//   pick     300 ms — the brackets close in and lock round the chosen row,
//            the rest of the glass clears, the locked row fades last
//   dismiss  150 ms — the brackets fall back into the button and the glass
//            clears with them
// A pick and a dismiss never look alike: "nothing happened" reads as nothing.
//
// The brackets are not the menu's children: a menu may scroll (`max-height`
// from `floatMenu`), and a child would scroll away with its rows or be
// clipped. They are one fixed frame on `document.body`, kept on the menu's
// rectangle each frame while it is open. Nothing here moves or scales the
// menu's own box, so the placement helpers (`placeMenu`, `placeRowMenu`,
// `placeRowSub`, `fitBelow`) measure true sizes as it opens.
//
// Svelte keeps the menu on screen through `out:` (the `{#if}` that closed
// it waits for the duration), inert, while the click's action already runs.
//
// Classic (`data-layout="classic"`) keeps its menus exactly: no frame, no
// state class, a zero-length transition, and every rule in hudMenu.css is
// keyed off Classic. Reduce motion: a plain 100 ms fade, no travel.
import "./hudMenu.css";
import { reducedMotion } from "./sendMotion";

export const HUD_OPEN_MS = 220;
export const HUD_PICK_MS = 300;
export const HUD_CLOSE_MS = 150;
/** Reduce motion: the fade's length, in and out. */
export const HUD_FADE_MS = 100;
/** How long after the click that picked a row a close still counts as that pick (an action may await first). */
export const HUD_PICK_WINDOW_MS = 1500;

/** What a row is: the shared class, or a menu item by its role (so a plain `<button role="menuitem">` needs nothing added). */
export const HUD_ROW = '.hud-row, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';

export interface HudArg {
  /** The button the menu opens from; without one, the last thing pressed (or the pointer, for a right-click). */
  anchor?: HTMLElement | null;
}

export type HudPhase = "in" | "pick" | "out";

interface Press {
  x: number;
  y: number;
  el: Element | null;
  point: boolean;
  t: number;
}
interface Pick {
  menu: Element;
  row: HTMLElement;
  t: number;
}

let press: Press | null = null;
let pick: Pick | null = null;
let enterAt = -1;
let listening = false;

/** A harness's flag: the phase classes stay on, so a paused frame can be shot. */
const held = () => typeof window !== "undefined" && !!(window as unknown as { __hudMenuHold?: boolean }).__hudMenuHold;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function classic(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.layout === "classic";
}

/** One set of capture listeners for every menu: what was pressed last (the opening's origin) and which row a click chose. */
function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      press = { x: e.clientX, y: e.clientY, el: e.target instanceof Element ? e.target : null, point: false, t: now() };
      // A new press ends the last pick's claim; the click that follows may make a new one.
      pick = null;
    },
    true,
  );
  document.addEventListener(
    "contextmenu",
    (e) => {
      press = { x: e.clientX, y: e.clientY, el: e.target instanceof Element ? e.target : null, point: true, t: now() };
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const row = t?.closest<HTMLElement>(HUD_ROW);
      const menu = row?.closest(".hud-m");
      if (row && menu && !row.matches(":disabled, [aria-disabled='true']")) pick = { menu, row, t: now() };
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" || e.key === "Tab") enterAt = now();
      else if (e.key === "Escape") pick = null;
    },
    true,
  );
}

// From the module's load, not the first menu: the press that opens the first menu is its origin too.
listen();

/**
 * Where the menu opens from, in the menu's own box (0,0 its top-left): the
 * anchor's centre, clamped onto the box — so a menu under its button opens
 * from a point on its top edge, one above it from its bottom edge.
 */
export function hudOrigin(
  menu: { left: number; top: number; width: number; height: number },
  from: { left: number; top: number; right: number; bottom: number } | null,
): { x: number; y: number } {
  if (!from) return { x: 0, y: 0 };
  const cx = (from.left + from.right) / 2 - menu.left;
  const cy = (from.top + from.bottom) / 2 - menu.top;
  return { x: Math.max(0, Math.min(menu.width, cx)), y: Math.max(0, Math.min(menu.height, cy)) };
}

/** What a close is: the pick of `row`, when a click (or Enter on the lit row) chose one just before; else a dismiss. */
export function hudExit(
  menu: Element,
  at: number,
  lastPick: { menu: Element; row: HTMLElement; t: number } | null,
  lastEnter: number,
): HTMLElement | null {
  if (lastPick && lastPick.menu === menu && at - lastPick.t <= HUD_PICK_WINDOW_MS && menu.contains(lastPick.row)) {
    return lastPick.row;
  }
  if (lastEnter >= 0 && at - lastEnter <= 250) {
    return menu.querySelector<HTMLElement>('[role="option"][aria-selected="true"], .hud-row.hud-key');
  }
  return null;
}

interface Live {
  frame: HTMLElement;
  raf: number;
  timer: ReturnType<typeof setTimeout> | null;
  box: string;
}
const live = new WeakMap<HTMLElement, Live>();

function originRect(node: HTMLElement, arg: HudArg | undefined): { left: number; top: number; right: number; bottom: number } | null {
  if (arg?.anchor?.isConnected) return arg.anchor.getBoundingClientRect();
  const fresh = press && now() - press.t < 1200 ? press : null;
  if (fresh) {
    if (fresh.point) return { left: fresh.x, right: fresh.x, top: fresh.y, bottom: fresh.y };
    const btn = fresh.el?.closest("button, [role='button'], [aria-haspopup], summary, a");
    if (btn && btn.isConnected && !node.contains(btn)) return btn.getBoundingClientRect();
    return { left: fresh.x, right: fresh.x, top: fresh.y, bottom: fresh.y };
  }
  // Opened from the keyboard: the focused thing, when it is not the menu's own.
  const a = document.activeElement;
  if (a instanceof HTMLElement && a !== document.body && !node.contains(a)) return a.getBoundingClientRect();
  return null;
}

function track(node: HTMLElement, l: Live) {
  const step = () => {
    if (!node.isConnected) {
      drop(node);
      return;
    }
    const r = node.getBoundingClientRect();
    const box = `${r.left},${r.top},${r.width},${r.height}`;
    if (box !== l.box) {
      l.box = box;
      const s = l.frame.style;
      s.left = `${r.left}px`;
      s.top = `${r.top}px`;
      s.setProperty("--mw", `${r.width}px`);
      s.setProperty("--mh", `${r.height}px`);
    }
    l.raf = requestAnimationFrame(step);
  };
  step();
}

function drop(node: HTMLElement) {
  const l = live.get(node);
  if (!l) return;
  cancelAnimationFrame(l.raf);
  if (l.timer) clearTimeout(l.timer);
  l.frame.remove();
  live.delete(node);
}

/** The click-away scrim a menu is drawn after (`.scrim`, `.tab-scrim`, `.tab-chooser-scrim`): live while the menu is open. */
function scrim(node: HTMLElement, on: boolean) {
  const sc = node.previousElementSibling;
  if (sc instanceof HTMLElement && /scrim/.test(sc.className)) sc.style.pointerEvents = on ? "" : "none";
}

function setPhase(node: HTMLElement, l: Live, phase: HudPhase | null, reduced: boolean) {
  for (const el of [node, l.frame]) {
    el.classList.remove("hud-in", "hud-pick", "hud-out");
    el.classList.toggle("hud-rm", reduced && phase !== null);
    if (phase) el.classList.add(`hud-${phase}`);
  }
}

function begin(node: HTMLElement, arg: HudArg | undefined): Live {
  listen();
  let l = live.get(node);
  if (!l) {
    const frame = document.createElement("div");
    frame.className = "hud-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.innerHTML = '<i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i>';
    document.body.appendChild(frame);
    l = { frame, raf: 0, timer: null, box: "" };
    live.set(node, l);
    track(node, l);
  }
  if (l.timer) clearTimeout(l.timer);
  node.querySelector(".hud-picked")?.classList.remove("hud-picked");
  scrim(node, true);
  const r = node.getBoundingClientRect();
  const o = hudOrigin(r, originRect(node, arg));
  l.frame.style.setProperty("--ox", `${o.x}px`);
  l.frame.style.setProperty("--oy", `${o.y}px`);
  return l;
}

/**
 * `in:hudIn|global` — the opening. Returns a function so Svelte calls it
 * afresh on every opening (a config object is cached across a reversed
 * transition), a microtask after the menu is placed.
 */
export function hudIn(node: HTMLElement, arg?: HudArg) {
  return () => {
    if (classic() || typeof requestAnimationFrame === "undefined") return { duration: 0 };
    const reduced = reducedMotion();
    const l = begin(node, arg);
    setPhase(node, l, "in", reduced);
    const ms = reduced ? HUD_FADE_MS : HUD_OPEN_MS;
    // The opening class comes off when it is over: a row added later (a
    // filtered list) must not replay the parts' rise.
    if (!held()) {
      l.timer = setTimeout(() => {
        l.timer = null;
        if (node.classList.contains("hud-in")) setPhase(node, l, null, reduced);
      }, ms + 140);
    }
    return { duration: ms };
  };
}

/** `out:hudOut|global` — the close: a pick when a row was just chosen, else a dismiss. */
export function hudOut(node: HTMLElement, _arg?: HudArg) {
  return () => {
    const l = live.get(node);
    if (classic() || !l) return { duration: 0 };
    const reduced = reducedMotion();
    if (l.timer) clearTimeout(l.timer);
    const row = hudExit(node, now(), pick, enterAt);
    pick = null;
    if (row) {
      const m = node.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const s = l.frame.style;
      s.setProperty("--px", `${r.left - m.left}px`);
      s.setProperty("--py", `${r.top - m.top}px`);
      s.setProperty("--pw", `${r.width}px`);
      s.setProperty("--ph", `${r.height}px`);
      row.classList.add("hud-picked");
    }
    setPhase(node, l, row ? "pick" : "out", reduced);
    // The menu stays for the length of its close; the full-window scrim
    // beside it must not eat a click meant for the app in that time.
    scrim(node, false);
    const ms = reduced ? HUD_FADE_MS : row ? HUD_PICK_MS : HUD_CLOSE_MS;
    // The frame goes with the menu (the tracker drops it when the node
    // leaves); this is the backstop for a node removed some other way.
    if (held()) return { duration: ms };
    l.timer = setTimeout(() => {
      if (!node.isConnected || node.classList.contains("hud-out") || node.classList.contains("hud-pick")) drop(node);
    }, ms + 400);
    return { duration: ms };
  };
}
