import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import topBarSrc from "./TopBar.svelte?raw";
import composerSrc from "./Composer.svelte?raw";
import appSrc from "../App.svelte?raw";
import mathSrc from "./math.ts?raw";
import linksSrc from "./links.ts?raw";
import noteEditorSrc from "./noteEditor.ts?raw";
import { coolTips, delegateTarget, placeTip, sendTip, TIP_DELAY_MS, TIP_WARM_MS, tipTimer } from "./tip";

// Every component's source, for the pass-2 lint (backlog 171).
const components = import.meta.glob("./**/*.svelte", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

// Nightshift backlog 171 pass 1: the pill's placement and its timing.

const VW = 1200;
const VH = 800;
const box = (left: number, top: number, w = 40, h = 24) => ({ left, top, right: left + w, bottom: top + h });

describe("placeTip", () => {
  it("sits above the anchor, centred, when there is room", () => {
    const p = placeTip(box(500, 400), 200, 30, VW, VH);
    expect(p.side).toBe("above");
    expect(p.top).toBe(400 - 6 - 30);
    expect(p.left).toBe(520 - 100);
  });

  it("goes below an anchor at the top of the window (the top bar)", () => {
    const p = placeTip(box(500, 10), 200, 30, VW, VH);
    expect(p.side).toBe("below");
    expect(p.top).toBe(34 + 6);
  });

  it("stays above an anchor at the bottom of the window (the composer)", () => {
    const p = placeTip(box(500, VH - 30), 200, 60, VW, VH);
    expect(p.side).toBe("above");
    expect(p.top + 60).toBeLessThanOrEqual(VH - 30);
  });

  it("is clamped inside either edge", () => {
    expect(placeTip(box(2, 400), 300, 30, VW, VH).left).toBe(8);
    const right = placeTip(box(VW - 20, 400, 18), 300, 30, VW, VH);
    expect(right.left + 300).toBeLessThanOrEqual(VW - 8);
  });

  it("starts at the margin when wider than the window", () => {
    expect(placeTip(box(100, 400), 2000, 30, VW, VH).left).toBe(8);
  });

  it("with no room either side, takes the roomier one and keeps its top on screen", () => {
    const tall = placeTip(box(500, 300), 200, 700, VW, VH);
    expect(tall.side).toBe("below");
    expect(tall.top).toBeGreaterThanOrEqual(8);
    expect(tall.top + 700).toBeLessThanOrEqual(VH - 8);
  });
});

describe("tipTimer", () => {
  let t = 0;
  const now = () => t;
  beforeEach(() => {
    vi.useFakeTimers();
    coolTips();
    t = 10_000;
  });
  afterEach(() => vi.useRealTimers());

  function make() {
    const log: string[] = [];
    const timer = tipTimer({ show: () => log.push("show"), hide: () => log.push("hide"), now });
    return { timer, log };
  }
  const advance = (ms: number) => {
    t += ms;
    vi.advanceTimersByTime(ms);
  };

  it("hover shows after the delay, not before", () => {
    const { timer, log } = make();
    timer.enter();
    advance(TIP_DELAY_MS - 1);
    expect(log).toEqual([]);
    advance(1);
    expect(log).toEqual(["show"]);
    expect(timer.shown).toBe(true);
  });

  it("the delay is well under the OS's second", () => {
    expect(TIP_DELAY_MS).toBeLessThanOrEqual(350);
  });

  it("leaving before the delay shows nothing", () => {
    const { timer, log } = make();
    timer.enter();
    advance(50);
    timer.leave();
    advance(1000);
    expect(log).toEqual([]);
  });

  it("keyboard focus shows at once", () => {
    const { timer, log } = make();
    timer.focus();
    expect(log).toEqual(["show"]);
  });

  it("a press hides it and cancels a pending show", () => {
    const { timer, log } = make();
    timer.enter();
    advance(TIP_DELAY_MS);
    timer.dismiss();
    expect(log).toEqual(["show", "hide"]);
    timer.enter();
    timer.dismiss();
    advance(1000);
    expect(log).toEqual(["show", "hide"]);
  });

  it("the next control within the warm window shows at once", () => {
    const a = make();
    const b = make();
    a.timer.enter();
    advance(TIP_DELAY_MS);
    a.timer.leave();
    advance(TIP_WARM_MS - 10);
    b.timer.enter();
    expect(b.log).toEqual(["show"]);
  });

  it("after the warm window, the next waits the delay again", () => {
    const a = make();
    const b = make();
    a.timer.enter();
    advance(TIP_DELAY_MS);
    a.timer.leave();
    advance(TIP_WARM_MS + 10);
    b.timer.enter();
    expect(b.log).toEqual([]);
    advance(TIP_DELAY_MS);
    expect(b.log).toEqual(["show"]);
  });

  it("a press cools the run", () => {
    const a = make();
    const b = make();
    a.timer.enter();
    advance(TIP_DELAY_MS);
    a.timer.dismiss();
    b.timer.enter();
    expect(b.log).toEqual([]);
  });
});

describe("sendTip (the disabled Send says why)", () => {
  it("names the reason Send is disabled, and the key when it is not", () => {
    expect(sendTip(false, true).text).toMatch(/no model is connected/);
    expect(sendTip(true, true)).toEqual({ text: "Type a message or attach a file to send", keys: "↵" });
    expect(sendTip(true, false)).toEqual({ text: "Send this message", keys: "↵" });
  });
});

describe("the top bar and the composer", () => {
  // Pass 1's surfaces carry no native `title=` (the OS box would double
  // the pill); pass 2 extends this to every file.
  for (const [file, src] of [
    ["TopBar.svelte", topBarSrc],
    ["Composer.svelte", composerSrc],
  ] as const) {
    it(`${file} has no title= attribute`, () => {
      expect(src.match(/\stitle=["{]/g) ?? []).toEqual([]);
      expect(src).toContain("use:tip=");
    });
  }
  it("Composer's Send carries a tip (walk 2026-09-25: the disabled Send showed none)", () => {
    expect(composerSrc).toMatch(/class="ns-btn accent send act"\s+use:tip=\{sendTip\(/);
  });
});

/**
 * Every native `title=` left in a component's template, as `file:tag`. A
 * `title=` on a component (`<ConfirmDialog title=…>`, its heading) is a
 * prop, not a tooltip; on `<embed>`/`<iframe>`/`<object>` it names the
 * embedded content for a screen reader and WebKit draws no box over it.
 */
function nativeTitles(file: string, src: string): string[] {
  const template = src.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, (m) => " ".repeat(m.length));
  const out: string[] = [];
  for (const m of template.matchAll(/\s(title=["{]|\{title\})/g)) {
    const before = template.slice(0, m.index);
    const tags = [...before.matchAll(/<([A-Za-z][\w.:-]*)/g)];
    const tag = tags.length ? tags[tags.length - 1][1] : "?";
    if (/^[A-Z]/.test(tag) || tag.includes(".") || ["embed", "iframe", "object"].includes(tag)) continue;
    out.push(`${file}:<${tag}>`);
  }
  return out;
}

describe("no native title= anywhere (171 pass 2)", () => {
  it("every component uses the pill, not the OS box", () => {
    const all = { "../App.svelte": appSrc, ...components };
    expect(Object.keys(all).length).toBeGreaterThan(60);
    const left = Object.entries(all).flatMap(([f, s]) => nativeTitles(f, s));
    expect(left).toEqual([]);
  });

  it("the lint sees a native title and lets a component prop and an embed through", () => {
    expect(nativeTitles("x", `<button\n  class="a"\n  title={t}>x</button>`)).toEqual(["x:<button>"]);
    expect(nativeTitles("x", `<button {title}>x</button>`)).toEqual(["x:<button>"]);
    expect(nativeTitles("x", `<ConfirmDialog title="Delete?" />`)).toEqual([]);
    expect(nativeTitles("x", `<embed src={s} title={name} />`)).toEqual([]);
    expect(nativeTitles("x", `<script>const a = '<b title="x">';</script><i>y</i>`)).toEqual([]);
  });

  it("HTML built as a string carries data-tip, not title", () => {
    expect(mathSrc).not.toMatch(/\stitle="/);
    expect(mathSrc).toContain('data-tip="');
    expect(linksSrc).not.toMatch(/\stitle="/);
    expect(linksSrc).toContain('data-tip="');
    expect(noteEditorSrc).not.toMatch(/\.title = /);
    expect(noteEditorSrc).toContain("el.dataset.tip = ");
  });
});

/** Just enough of an element for `delegateTarget`. */
interface FakeEl {
  tagName: string;
  attrs: Record<string, string>;
  parent: FakeEl | null;
  getAttribute(n: string): string | null;
  hasAttribute(n: string): boolean;
  setAttribute(n: string, v: string): void;
  removeAttribute(n: string): void;
  closest(sel: string): FakeEl | null;
}
function fakeEl(tagName: string, attrs: Record<string, string>, parent: FakeEl | null = null): FakeEl {
  const el: FakeEl = {
    tagName,
    attrs: { ...attrs },
    parent,
    getAttribute: (n: string) => (n in el.attrs ? el.attrs[n] : null),
    hasAttribute: (n: string) => n in el.attrs,
    setAttribute: (n: string, v: string) => void (el.attrs[n] = v),
    removeAttribute: (n: string) => void delete el.attrs[n],
    closest(_sel: string) {
      // The selector is always "[data-tip], [title]".
      for (let e: FakeEl | null = el; e; e = e.parent) if ("data-tip" in e.attrs || "title" in e.attrs) return e;
      return null;
    },
  };
  return el;
}

describe("delegateTarget (string-built HTML and stray titles)", () => {
  it("finds a data-tip ancestor", () => {
    const a = fakeEl("A", { "data-tip": "notes/x.md" });
    const inner = fakeEl("SPAN", {}, a);
    expect(delegateTarget(inner as unknown as EventTarget)).toBe(a);
  });

  it("moves a stray native title to data-tip so the OS box never shows", () => {
    const a = fakeEl("A", { href: "https://x", title: "A markdown link title" });
    expect(delegateTarget(a as unknown as EventTarget)).toBe(a);
    expect(a.attrs).toEqual({ href: "https://x", "data-tip": "A markdown link title" });
  });

  it("leaves a frame's title alone and ignores untipped elements", () => {
    const e = fakeEl("EMBED", { title: "file.pdf" });
    expect(delegateTarget(e as unknown as EventTarget)).toBeNull();
    expect(e.attrs.title).toBe("file.pdf");
    expect(delegateTarget(fakeEl("DIV", {}) as unknown as EventTarget)).toBeNull();
    expect(delegateTarget(null)).toBeNull();
  });

  it("an empty title tips nothing but is still removed", () => {
    const s = fakeEl("SPAN", { title: "" });
    expect(delegateTarget(s as unknown as EventTarget)).toBeNull();
    expect(s.attrs.title).toBeUndefined();
  });
});
