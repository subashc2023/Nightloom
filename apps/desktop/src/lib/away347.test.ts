import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followStep } from "./sendScroll";
import transcriptSrc from "./Transcript.svelte?raw";

// Nightshift backlog 347, his words: he sends, switches to another window
// while the reply cooks, and comes back "scrolled to the very bottom". The
// follow-the-bottom step now holds still while the window is away. The
// suite has no DOM (environment "node"), so the scroll itself is measured in
// `harness/away347.html`; here, the decision, the presence signal, and that
// the transcript asks both.

describe("followStep (backlog 347)", () => {
  it("focused: a pinned reader follows, an unpinned one stays — as before", () => {
    expect(followStep(true, false, false)).toBe("follow");
    expect(followStep(true, false, true)).toBe("follow");
    expect(followStep(false, false, false)).toBe("stay");
  });

  it("away: growth below a pinned reader releases the pin and moves nothing", () => {
    expect(followStep(true, true, false)).toBe("release");
  });

  it("away with nothing new below stays pinned, so a quiet chat still follows on return", () => {
    expect(followStep(true, true, true)).toBe("stay");
  });

  it("away and already reading up the page: untouched", () => {
    expect(followStep(false, true, false)).toBe("stay");
  });
});

describe("presence (backlog 347)", () => {
  let doc: EventTarget & { visibilityState: string };
  let win: EventTarget;

  beforeEach(() => {
    vi.resetModules();
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    win = new EventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("outside the app, the window's blur is away and its focus is back", async () => {
    const { presence, watchPresence } = await import("./away.svelte");
    watchPresence();
    expect(presence.away).toBe(false);
    win.dispatchEvent(new Event("blur"));
    expect(presence.away).toBe(true);
    win.dispatchEvent(new Event("focus"));
    expect(presence.away).toBe(false);
  });

  it("a hidden document is away even with the window focused", async () => {
    const { presence, watchPresence } = await import("./away.svelte");
    watchPresence();
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(presence.away).toBe(true);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(presence.away).toBe(false);
  });

  it("in the app, the native window's focus decides, not the document's blur (a web tab's webview takes the keyboard)", async () => {
    let handler: ((e: { payload: boolean }) => void) | null = null;
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => ({
        onFocusChanged: async (h: (e: { payload: boolean }) => void) => {
          handler = h;
          return () => {};
        },
      }),
    }));
    (win as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { presence, watchPresence } = await import("./away.svelte");
    watchPresence();
    await vi.waitFor(() => expect(handler).not.toBeNull());
    win.dispatchEvent(new Event("blur"));
    expect(presence.away).toBe(false);
    handler!({ payload: false });
    expect(presence.away).toBe(true);
    handler!({ payload: true });
    expect(presence.away).toBe(false);
    vi.doUnmock("@tauri-apps/api/window");
  });
});

describe("the transcript asks (backlog 347)", () => {
  it("the follow step reads presence.away and the presence is watched", () => {
    expect(transcriptSrc).toContain("followStep(pinned, presence.away, atBottom())");
    expect(transcriptSrc).toContain("watchPresence();");
    // A send's late re-check (item 313) does not jump while away either.
    expect(transcriptSrc).toMatch(/if \(pinned \|\| presence\.away \|\| !viewport/);
  });
});
