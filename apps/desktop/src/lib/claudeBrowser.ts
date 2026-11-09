/**
 * Claude's browser (nightshift item 508, option A2 of
 * `notes/runner-design/508-report-2026-11-05.md`): the pure half — the
 * letterbox, the mapping from his pointer to page pixels, which keys go to
 * the page and which stay the app's, the status in words, and the address
 * line's draft. The store is `claudeBrowser.svelte.ts`, the tab
 * `ClaudeBrowserView.svelte`, the chip `ClaudeBrowserChip.svelte`.
 */
import type { BrowserInput, BrowserStatus } from "./api";

/** The browser's fixed viewport (the contract's `width`/`height`). */
export const PAGE_W = 1280;
export const PAGE_H = 800;
/** Pointer moves sent at most this often (~30 a second). */
export const MOVE_MS = 33;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the picture sits in a pane `bw`×`bh`: scaled to fit, aspect kept,
 * centred — bars above and below in a tall pane, at the sides in a wide one.
 */
export function letterbox(bw: number, bh: number, pw = PAGE_W, ph = PAGE_H): Rect & { scale: number } {
  if (bw <= 0 || bh <= 0 || pw <= 0 || ph <= 0) return { x: 0, y: 0, w: 0, h: 0, scale: 0 };
  const scale = Math.min(bw / pw, bh / ph);
  const w = pw * scale;
  const h = ph * scale;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h, scale };
}

/**
 * A point in the pane's box (`px`, `py` from its top-left) as page CSS
 * pixels, or null when it falls on a bar outside the picture.
 */
export function toPage(px: number, py: number, pic: Rect, pw = PAGE_W, ph = PAGE_H): { x: number; y: number } | null {
  if (pic.w <= 0 || pic.h <= 0) return null;
  const fx = (px - pic.x) / pic.w;
  const fy = (py - pic.y) / pic.h;
  if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return null;
  return {
    x: Math.min(pw - 1, Math.max(0, Math.round(fx * pw))),
    y: Math.min(ph - 1, Math.max(0, Math.round(fy * ph))),
  };
}

/** A DOM mouse button as the contract names it. */
export function buttonName(b: number): "left" | "right" | "middle" {
  return b === 2 ? "right" : b === 1 ? "middle" : "left";
}

/** The modifiers held, in Playwright's names. */
export function modifiersOf(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string[] {
  const out: string[] = [];
  if (e.metaKey) out.push("Meta");
  if (e.ctrlKey) out.push("Control");
  if (e.altKey) out.push("Alt");
  if (e.shiftKey) out.push("Shift");
  return out;
}

/** A wheel delta in pixels, whatever unit the event came in. */
export function wheelPixels(delta: number, mode: number): number {
  return mode === 1 ? delta * 16 : mode === 2 ? delta * PAGE_H : delta;
}

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/**
 * Nightloom's own window chords that stay the app's while the picture has
 * the keyboard, by physical key (⌘ on macOS, Ctrl elsewhere). Everything
 * else goes to the page — ⌘A, ⌘C, ⌘X, ⌘Z, ⌘⇧Z, ⌘F, ⌘B, ⌘I, arrows with any
 * modifier — so the page's own editing works as it would in a browser.
 * Kept, with why: tabs (⌘T new, ⌘W close, ⌘⇧[ / ⌘⇧] step), windows and
 * the app (⌘N, ⌘⇧N, ⌥⌘N, ⌘Q, ⌘H, ⌘M, ⌘, Settings), ⌘\ the sidebar,
 * ⌘1…9 / ⌘⇧1…9 providers and models, ⌘⇧S/O/F/H the model aliases,
 * ⌘⇧T / ⌘⇧B thinking and tool calls, ⌘= ⌘− ⌘0 zoom, ⌘. stop the turn,
 * ⌘K commands, ⌘P projects, ⌘L back to the chat's box (his way out).
 */
const APP_CODES = new Set([
  "KeyT",
  "KeyW",
  "KeyN",
  "KeyQ",
  "KeyH",
  "KeyM",
  "Comma",
  "Backslash",
  "Equal",
  "Minus",
  "Digit0",
  "Period",
  "KeyK",
  "KeyP",
  "KeyL",
]);
const APP_SHIFT_CODES = new Set(["BracketLeft", "BracketRight", "KeyS", "KeyO", "KeyF", "KeyH", "KeyT", "KeyB", "KeyN"]);

/** The modifier keys alone: nothing to send. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "OS"]);

export type KeyRoute =
  /** Send this to the page; the app's handler must not see it. */
  | { route: "page"; input: BrowserInput }
  /** One of the app's own chords: leave the event alone. */
  | { route: "app" }
  /** Neither: a modifier alone, IME composition, or ⌘V (its `paste`
   *  event carries the text). Leave the event to the browser engine. */
  | { route: "none" };

/** What a keydown with the picture focused does (`mac`: ⌘ is primary). */
export function routeKey(e: KeyLike, mac: boolean): KeyRoute {
  if (e.isComposing || e.key === "Process" || e.key === "Dead" || e.key === "Unidentified") return { route: "none" };
  if (MODIFIER_KEYS.has(e.key)) return { route: "none" };
  // Ctrl+Tab steps the tabs on every platform (backlog 286).
  if (e.ctrlKey && e.key === "Tab") return { route: "app" };
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (primary) {
    if (/^Digit[1-9]$/.test(e.code)) return { route: "app" };
    if (e.altKey && e.code === "KeyN") return { route: "app" };
    // ⌘⇧Z is not here: it is the page's redo while the page has the keys.
    if (APP_CODES.has(e.code) || (e.shiftKey && APP_SHIFT_CODES.has(e.code))) return { route: "app" };
    // Paste arrives as a `paste` event with the text (sent as `text`).
    if (!e.shiftKey && !e.altKey && e.code === "KeyV") return { route: "none" };
  }
  const chord = e.metaKey || e.ctrlKey;
  if (e.key.length === 1 || [...e.key].length === 1) {
    // A character: Shift and Option already made it what it is ("A", "å"),
    // so they are not sent again unless ⌘ or Ctrl makes it a chord, then
    // by the physical key so ⌘⇧Z is Meta+Shift+z, not Meta+Shift+Z.
    if (!chord) return { route: "page", input: { kind: "key", key: e.key, modifiers: [] } };
    const letter = /^Key([A-Z])$/.exec(e.code);
    const key = letter ? letter[1].toLowerCase() : e.key.toLowerCase();
    return { route: "page", input: { kind: "key", key, modifiers: modifiersOf(e) } };
  }
  return { route: "page", input: { kind: "key", key: e.key, modifiers: modifiersOf(e) } };
}

/** What a chat's browser is, as the tab and chip say it. */
export type BrowserPhase = "none" | "starting" | "live" | "ended";

/**
 * The phase from the last status and whether this run has seen it live:
 * no status → none (nothing started in this chat, or not since the app
 * started); up but never live → starting; live; down after being live →
 * ended.
 */
export function phaseOf(status: BrowserStatus | null | undefined, seenLive: boolean): BrowserPhase {
  if (!status) return seenLive ? "ended" : "none";
  if (status.live) return "live";
  return seenLive ? "ended" : "starting";
}

/** The one line under the bar that says who has the browser. */
export function holdLine(status: BrowserStatus | null | undefined, phase: BrowserPhase): string {
  if (phase !== "live" || !status) return "";
  return status.held_by === "user"
    ? "You have the browser. Claude is paused: its browser calls wait until you give it back."
    : "Claude has the browser. Your first click or key here takes it over.";
}

/** What each phase says in the tab when there is no picture to show. */
export function phaseText(phase: BrowserPhase): { title: string; body: string } {
  switch (phase) {
    case "none":
      return {
        title: "No browser in this chat yet",
        body: "Claude starts its browser the first time it uses it in this chat (Playwright). Its pages will show here, live.",
      };
    case "starting":
      return { title: "Starting Claude's browser…", body: "The first picture shows here as soon as the page draws." };
    case "live":
      return { title: "Waiting for the first picture…", body: "" };
    case "ended":
      return {
        title: "Claude's browser has closed",
        body: "Its pages and any logins in it are gone; they lived only in memory. Claude starts a fresh one the next time it uses its browser in this chat.",
      };
  }
}

/** What a dialog the page raised becomes as the tab's one-line notice. */
export function dialogLine(d: { kind: "alert" | "confirm" | "prompt" | "file"; message: string }): string {
  const what =
    d.kind === "alert"
      ? "an alert"
      : d.kind === "confirm"
        ? "a confirm box"
        : d.kind === "prompt"
          ? "a prompt"
          : "a file picker";
  const how =
    d.kind === "alert" || d.kind === "confirm" ? "accepted" : d.kind === "prompt" ? "answered empty" : "cancelled";
  const msg = d.message.trim();
  const said = msg ? `: “${msg.length > 160 ? `${msg.slice(0, 160)}…` : msg}”` : "";
  // "…minutes.”" ends its own sentence; no second full stop after the quote.
  const stop = /[.!?…]$/.test(msg.length > 160 ? "…" : msg) ? "" : ".";
  return `The page showed ${what}${said}${stop} It was ${how} for you; answering dialogs here is not built yet.`;
}

/**
 * What he typed in the address line, as a URL to go to, or null when it
 * is not one: a bare host gets https://, localhost and 127.0.0.1 get
 * http://; only http(s) and about:blank are sent.
 */
export function addressToUrl(typed: string): string | null {
  const t = typed.trim();
  if (!t || /\s/.test(t)) return null;
  if (t === "about:blank") return t;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${local ? "http" : "https"}://${t}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    if (!local && !u.hostname.includes(".") && !/^\d+$/.test(u.hostname) && u.hostname !== "localhost") return null;
    return u.href;
  } catch {
    return null;
  }
}

/** The address line's view-state key, one per chat's browser. */
export function addressKey(session: string): string {
  return `browser.addr:${session}`;
}

/**
 * What the address line shows: his half-typed draft when there is one
 * (it outlives a switch away and back), else where the page is.
 */
export function addressShown(draft: string | null, url: string | undefined): string {
  return draft !== null ? draft : url ?? "";
}

/**
 * A trailing throttle: `fn` at most once per `ms`, the last call in a burst
 * always delivered (so the page sees where the pointer stopped). `now` and
 * `later` are injectable for the suite.
 */
export function throttle<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
  now: () => number = () => Date.now(),
  later: (f: () => void, ms: number) => unknown = (f, d) => setTimeout(f, d),
): { call: (...a: A) => void; cancel: () => void } {
  let last = -Infinity;
  let pending: A | null = null;
  let timer = false;
  let dead = false;
  const flush = () => {
    timer = false;
    if (dead || !pending) return;
    const a = pending;
    pending = null;
    last = now();
    fn(...a);
  };
  return {
    call: (...a: A) => {
      if (dead) return;
      const t = now();
      if (t - last >= ms && !timer) {
        last = t;
        pending = null;
        fn(...a);
        return;
      }
      pending = a;
      if (!timer) {
        timer = true;
        later(flush, Math.max(0, ms - (t - last)));
      }
    },
    cancel: () => {
      dead = true;
      pending = null;
    },
  };
}
