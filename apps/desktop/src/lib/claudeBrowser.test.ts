import { beforeEach, describe, expect, it, vi } from "vitest";
import viewSrc from "./ClaudeBrowserView.svelte?raw";
import appSrc from "../App.svelte?raw";
import * as api from "./api";
import {
  PAGE_H,
  PAGE_W,
  addressKey,
  addressShown,
  addressToUrl,
  buttonName,
  dialogLine,
  holdLine,
  letterbox,
  phaseOf,
  routeKey,
  throttle,
  toPage,
  wheelPixels,
  type KeyLike,
} from "./claudeBrowser";
import {
  applyFrame,
  applyStatus,
  browsers,
  chipShown,
  dismissChip,
  frames,
  phase,
  resetBrowsers,
  setHold,
  watch,
  watchCount,
} from "./claudeBrowser.svelte";
import { resetViewState, viewGet, viewSet } from "./viewState";
import * as tabs from "./tabs";
import { isKeptKind } from "./keptTabs.svelte";
import type { BrowserStatus } from "./api";

/**
 * Nightshift item 508, agent B: the "Claude's browser" tab. The suite runs
 * in node, so the tab is pinned through its pure half (`claudeBrowser.ts`:
 * the letterbox, the mapping, the key routing, the words), its store
 * (`claudeBrowser.svelte.ts`: status, frames, the watch count, the hold),
 * the tab kind in `tabs.ts`, and — for the wiring only the markup holds —
 * the component source. The backend's commands are stubbed.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  claudeBrowserWatch: vi.fn(async () => null),
  claudeBrowserHold: vi.fn(async (_s: string, held: boolean) => ({ ...LIVE, held_by: held ? "user" : "model" })),
  claudeBrowserStatus: vi.fn(async () => null),
  claudeBrowserInput: vi.fn(async () => null),
  claudeBrowserNav: vi.fn(async () => null),
}));

const LIVE: BrowserStatus = {
  live: true,
  url: "https://example.com/a",
  title: "Example",
  held_by: "model",
  width: 1280,
  height: 800,
  pages: 1,
};

const key = (k: Partial<KeyLike> & { key: string }): KeyLike => ({
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...k,
});

beforeEach(() => {
  resetBrowsers();
  vi.mocked(api.claudeBrowserWatch).mockClear();
  vi.mocked(api.claudeBrowserHold).mockClear();
});

describe("the letterbox and the mapping (three pane sizes)", () => {
  it("fills a pane of exactly the viewport's size", () => {
    const r = letterbox(1280, 800);
    expect(r).toEqual({ x: 0, y: 0, w: 1280, h: 800, scale: 1 });
    expect(toPage(640, 400, r)).toEqual({ x: 640, y: 400 });
  });

  it("puts bars above and below in a tall, narrow pane", () => {
    const r = letterbox(400, 900);
    expect(r.scale).toBeCloseTo(400 / 1280);
    expect(r.w).toBeCloseTo(400);
    expect(r.h).toBeCloseTo(250);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(325);
    // The picture's centre is the page's centre; its corners are the page's.
    expect(toPage(200, 450, r)).toEqual({ x: 640, y: 400 });
    expect(toPage(0, 325, r)).toEqual({ x: 0, y: 0 });
    expect(toPage(400, 575, r)).toEqual({ x: PAGE_W - 1, y: PAGE_H - 1 });
    // On a bar: nothing.
    expect(toPage(200, 100, r)).toBeNull();
    expect(toPage(200, 800, r)).toBeNull();
  });

  it("puts bars at the sides in a wide pane, scaling up", () => {
    const r = letterbox(1600 * 1.5, 600 * 1.5); // 2400×900
    expect(r.scale).toBeCloseTo(900 / 800);
    expect(r.w).toBeCloseTo(1440);
    expect(r.h).toBeCloseTo(900);
    expect(r.x).toBeCloseTo(480);
    expect(r.y).toBeCloseTo(0);
    expect(toPage(480 + 1440 / 4, 900 / 4, r)).toEqual({ x: 320, y: 200 });
    expect(toPage(100, 450, r)).toBeNull();
  });

  it("draws nothing in a pane with no size", () => {
    expect(letterbox(0, 500).w).toBe(0);
    expect(toPage(1, 1, letterbox(0, 500))).toBeNull();
  });

  it("names buttons and wheel units as the contract does", () => {
    expect([buttonName(0), buttonName(1), buttonName(2)]).toEqual(["left", "middle", "right"]);
    expect(wheelPixels(3, 0)).toBe(3);
    expect(wheelPixels(3, 1)).toBe(48);
  });
});

describe("keys: the page's, or the app's", () => {
  it("sends characters as they were typed, Shift and Option already in them", () => {
    expect(routeKey(key({ key: "a", code: "KeyA" }), true)).toEqual({ route: "page", input: { kind: "key", key: "a", modifiers: [] } });
    expect(routeKey(key({ key: "A", code: "KeyA", shiftKey: true }), true)).toEqual({
      route: "page",
      input: { kind: "key", key: "A", modifiers: [] },
    });
    expect(routeKey(key({ key: "å", code: "KeyA", altKey: true }), true)).toEqual({
      route: "page",
      input: { kind: "key", key: "å", modifiers: [] },
    });
  });

  it("passes the page's editing chords through", () => {
    expect(routeKey(key({ key: "a", code: "KeyA", metaKey: true }), true)).toEqual({
      route: "page",
      input: { kind: "key", key: "a", modifiers: ["Meta"] },
    });
    expect(routeKey(key({ key: "Z", code: "KeyZ", metaKey: true, shiftKey: true }), true)).toEqual({
      route: "page",
      input: { kind: "key", key: "z", modifiers: ["Meta", "Shift"] },
    });
    expect(routeKey(key({ key: "f", code: "KeyF", metaKey: true }), true).route).toBe("page");
    expect(routeKey(key({ key: "Enter", code: "Enter", shiftKey: true }), true)).toEqual({
      route: "page",
      input: { kind: "key", key: "Enter", modifiers: ["Shift"] },
    });
    expect(routeKey(key({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }), true)).toEqual({
      route: "page",
      input: { kind: "key", key: "ArrowLeft", modifiers: ["Meta"] },
    });
  });

  it("keeps Nightloom's own window chords for the app", () => {
    for (const code of ["KeyT", "KeyW", "KeyN", "KeyK", "KeyP", "KeyL", "Comma", "Backslash", "Digit1", "Digit9", "Equal", "Period"]) {
      expect(routeKey(key({ key: "x", code, metaKey: true }), true).route, code).toBe("app");
    }
    for (const code of ["BracketLeft", "BracketRight", "KeyS", "KeyO", "KeyF", "KeyT", "KeyB"]) {
      expect(routeKey(key({ key: "x", code, metaKey: true, shiftKey: true }), true).route, code).toBe("app");
    }
    expect(routeKey(key({ key: "Tab", code: "Tab", ctrlKey: true }), true).route).toBe("app");
    expect(routeKey(key({ key: "n", code: "KeyN", metaKey: true, altKey: true }), true).route).toBe("app");
  });

  it("uses Ctrl as the primary key off macOS", () => {
    expect(routeKey(key({ key: "t", code: "KeyT", ctrlKey: true }), false).route).toBe("app");
    expect(routeKey(key({ key: "a", code: "KeyA", ctrlKey: true }), false)).toEqual({
      route: "page",
      input: { kind: "key", key: "a", modifiers: ["Control"] },
    });
    // On macOS Ctrl+T is the page's (an emacs binding), not the app's.
    expect(routeKey(key({ key: "t", code: "KeyT", ctrlKey: true }), true).route).toBe("page");
  });

  it("leaves paste, IME composition and bare modifiers to the engine", () => {
    expect(routeKey(key({ key: "v", code: "KeyV", metaKey: true }), true).route).toBe("none");
    expect(routeKey(key({ key: "Process", code: "KeyA" }), true).route).toBe("none");
    expect(routeKey(key({ key: "a", code: "KeyA", isComposing: true }), true).route).toBe("none");
    expect(routeKey(key({ key: "Dead", code: "KeyE", altKey: true }), true).route).toBe("none");
    expect(routeKey(key({ key: "Shift", code: "ShiftLeft", shiftKey: true }), true).route).toBe("none");
    expect(routeKey(key({ key: "Meta", code: "MetaLeft", metaKey: true }), true).route).toBe("none");
  });
});

describe("states and the hold", () => {
  it("reads none, starting, live and ended", () => {
    expect(phaseOf(null, false)).toBe("none");
    expect(phaseOf({ ...LIVE, live: false }, false)).toBe("starting");
    expect(phaseOf(LIVE, false)).toBe("live");
    expect(phaseOf({ ...LIVE, live: false }, true)).toBe("ended");
    expect(phaseOf(null, true)).toBe("ended");
  });

  it("says who holds the browser, and that Claude is paused while he does", () => {
    expect(holdLine(LIVE, "live")).toMatch(/^Claude has the browser\. Your first click or key here takes it over\./);
    expect(holdLine({ ...LIVE, held_by: "user" }, "live")).toMatch(/^You have the browser\. Claude is paused/);
    expect(holdLine(LIVE, "ended")).toBe("");
  });

  it("follows status events, and the hold's answer", async () => {
    expect(phase("s1")).toBe("none");
    applyStatus("s1", { ...LIVE, live: false });
    expect(phase("s1")).toBe("starting");
    applyStatus("s1", LIVE);
    expect(phase("s1")).toBe("live");
    await setHold("s1", true);
    expect(api.claudeBrowserHold).toHaveBeenCalledWith("s1", true);
    expect(browsers.byChat.s1.held_by).toBe("user");
    await setHold("s1", false);
    expect(browsers.byChat.s1.held_by).toBe("model");
    applyStatus("s1", { ...LIVE, live: false });
    expect(phase("s1")).toBe("ended");
  });

  it("offers the chip from the first live, once per browser", () => {
    applyStatus("s2", { ...LIVE, live: false });
    expect(chipShown("s2")).toBe(false);
    applyStatus("s2", LIVE);
    expect(chipShown("s2")).toBe(true);
    dismissChip("s2");
    expect(chipShown("s2")).toBe(false);
    // A navigation or a hold change is the same browser: still dismissed.
    applyStatus("s2", { ...LIVE, url: "https://example.com/b" });
    expect(chipShown("s2")).toBe(false);
    // It closes and a new one goes live: offered again.
    applyStatus("s2", { ...LIVE, live: false });
    applyStatus("s2", LIVE);
    expect(chipShown("s2")).toBe(true);
  });

  it("keeps only frames newer than the one shown", () => {
    applyFrame({ session: "s1", seq: 5, jpeg: "AAA", w: 1280, h: 800 });
    applyFrame({ session: "s1", seq: 4, jpeg: "BBB", w: 1280, h: 800 });
    expect(frames.s1.src).toBe("data:image/jpeg;base64,AAA");
    applyFrame({ session: "s1", seq: 6, jpeg: "CCC", w: 1280, h: 800 });
    expect(frames.s1.seq).toBe(6);
  });

  it("words a dialog the backend dismissed as one line", () => {
    expect(dialogLine({ kind: "alert", message: "Saved" })).toBe(
      "The page showed an alert: “Saved”. It was accepted for you; answering dialogs here is not built yet.",
    );
    expect(dialogLine({ kind: "file", message: "" })).toMatch(/^The page showed a file picker\. It was cancelled/);
    expect(dialogLine({ kind: "alert", message: "Your session will expire in 5 minutes." })).toMatch(/minutes\.” It was accepted/);
  });
});

describe("watching follows visibility", () => {
  it("turns frames on at the first watcher and off when the last one goes", () => {
    watch("s1", true);
    watch("s1", true); // the same chat's tab in the other pane
    expect(watchCount("s1")).toBe(2);
    watch("s1", false);
    watch("s1", false);
    watch("s1", false); // an extra stop never goes below zero
    expect(vi.mocked(api.claudeBrowserWatch).mock.calls).toEqual([
      ["s1", true],
      ["s1", false],
    ]);
    expect(watchCount("s1")).toBe(0);
  });

  it("is wired in the tab: only in front, only while the window shows, stopped on close", () => {
    const src = viewSrc;
    expect(src).toMatch(/if \(away \|\| !docVisible\) return;\s*watch\(s, true\);\s*return \(\) => watch\(s, false\);/);
    expect(src).toContain('document.addEventListener("visibilitychange"');
    expect(appSrc).toContain("<ClaudeBrowserView session={k.content.session} {away} />");
  });
});

describe("the address line's draft", () => {
  it("shows his draft over the page's address, and the address without one", () => {
    expect(addressShown("exam", "https://example.com/")).toBe("exam");
    expect(addressShown(null, "https://example.com/")).toBe("https://example.com/");
    expect(addressShown(null, undefined)).toBe("");
  });

  it("keeps the half-typed text per chat past a switch away and a relaunch", () => {
    const disk = new Map<string, string>();
    const store = { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v) };
    resetViewState(store);
    viewSet(addressKey("s1"), "arxiv.org/abs/24", "");
    viewSet(addressKey("s2"), "localhost:5173", "");
    // Back to the tab (a fresh read, as a view drawn again does).
    expect(viewGet(addressKey("s1"), "")).toBe("arxiv.org/abs/24");
    expect(viewGet(addressKey("s2"), "")).toBe("localhost:5173");
    // A relaunch: memory gone, the disk read again.
    resetViewState(store);
    expect(viewGet(addressKey("s1"), "")).toBe("arxiv.org/abs/24");
    // Enter or Esc clears it; the page's address shows again.
    viewSet(addressKey("s1"), "", "");
    expect(viewGet(addressKey("s1"), "")).toBe("");
    resetViewState(null);
  });

  it("is wired in the tab: read on each chat, written on each keystroke", () => {
    const src = viewSrc;
    expect(src).toContain("const v = viewGet(addressKey(session), \"\");");
    expect(src).toContain("viewSet(addressKey(session), v, \"\");");
  });

  it("turns what he typed into an address, or refuses it", () => {
    expect(addressToUrl("example.com")).toBe("https://example.com/");
    expect(addressToUrl("  https://a.b/c?d=1 ")).toBe("https://a.b/c?d=1");
    expect(addressToUrl("localhost:5173/x")).toBe("http://localhost:5173/x");
    expect(addressToUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(addressToUrl("about:blank")).toBe("about:blank");
    expect(addressToUrl("two words")).toBeNull();
    expect(addressToUrl("javascript:alert(1)")).toBeNull();
    expect(addressToUrl("file:///etc/passwd")).toBeNull();
    expect(addressToUrl("notahost")).toBeNull();
    expect(addressToUrl("")).toBeNull();
  });
});

describe("pointer moves are throttled to ~30 a second", () => {
  it("sends the first at once, the last of a burst after the gap", () => {
    let t = 0;
    const queued: (() => void)[] = [];
    const sent: number[] = [];
    const th = throttle((x: number) => sent.push(x), 33, () => t, (f) => queued.push(f));
    th.call(1);
    t = 5;
    th.call(2);
    t = 10;
    th.call(3);
    expect(sent).toEqual([1]);
    t = 33;
    queued.shift()!();
    expect(sent).toEqual([1, 3]);
    t = 100;
    th.call(4);
    expect(sent).toEqual([1, 3, 4]);
    th.cancel();
    th.call(5);
    expect(sent).toEqual([1, 3, 4]);
  });
});

describe("the tab kind", () => {
  it("is one tab per chat, kept mounted, dropped with its chat", () => {
    const a = { kind: "browser" as const, session: "s1" };
    expect(tabs.sameContent(a, { kind: "browser", session: "s1" })).toBe(true);
    expect(tabs.sameContent(a, { kind: "browser", session: "s2" })).toBe(false);
    expect(tabs.sameContent(a, { kind: "chat", session: "s1" })).toBe(false);
    expect(isKeptKind(a)).toBe(true);
    expect(tabs.tabTitle(a, [{ id: "s1", title: "Cut data" }])).toBe("Claude's browser · Cut data");
    expect(tabs.tabGlyph(a)).toBe("globe");
    expect(tabs.parseContentDrag(JSON.stringify(a))).toEqual(a);
    expect(tabs.parseContentDrag(JSON.stringify({ kind: "browser" }))).toBeNull();
    const ws = tabs.emptyWorkspace();
    tabs.land(ws, tabs.focusedPane(ws), a, "new");
    expect(tabs.findAnywhere(ws, a)).toBeTruthy();
    tabs.dropChat(ws, "s1");
    expect(tabs.findAnywhere(ws, a)).toBeUndefined();
  });
});
