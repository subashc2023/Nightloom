// Item 638 (2026-11-11): the `?` tips did nothing. Swaraag: hovering or
// clicking the `?` marks in the Model tab does nothing; "check if that is the
// case all around". Two causes, each pinned here:
// - `Hint.svelte` drew its tip `fixed` inside the Model · Tasks card, whose
//   Filament glass (`backdrop-filter`, item 620) made the card its containing
//   block, so the tip landed off the card and was clipped. It is portalled to
//   `document.body` now.
// - A click shut what hover had opened (Hint toggled; `use:tip` dismissed on
//   every press). A click now pins a `?` tip open.
// The suite runs in node, so the action is driven through a small stand-in
// DOM; the harness shots (notes/runner-design/638-harness) are the proof in
// WebKit that the pill is drawn where it can be seen.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import hintSrc from "./Hint.svelte?raw";
import approvalSrc from "./ApprovalPrompt.svelte?raw";
import subagentSrc from "./SubagentView.svelte?raw";
import settingRowSrc from "./settings/SettingRow.svelte?raw";
import { HINT_CLOSED, hintOpen, hintStep, type HintEvent, type HintState } from "./hintState";

const run = (events: HintEvent[], from: HintState = HINT_CLOSED) => events.reduce(hintStep, from);

describe("the Model tab's `?` (Hint): hover, click and keyboard focus open it", () => {
  it("hover opens it and leaving closes it", () => {
    expect(hintOpen(run(["enter"]))).toBe(true);
    expect(hintOpen(run(["enter", "leave"]))).toBe(false);
  });

  it("a click on a hovered `?` keeps it open (it used to toggle it shut), and it stays after the pointer leaves", () => {
    expect(hintOpen(run(["enter", "click"]))).toBe(true);
    expect(hintOpen(run(["enter", "click", "leave"]))).toBe(true);
  });

  it("a click with no hover (touch, a trackpad tap) opens it; a second click closes it", () => {
    expect(hintOpen(run(["click"]))).toBe(true);
    expect(hintOpen(run(["enter", "click", "click"]))).toBe(false);
  });

  it("keyboard focus opens it, blur closes it", () => {
    expect(hintOpen(run(["focus"]))).toBe(true);
    expect(hintOpen(run(["focus", "blur"]))).toBe(false);
  });

  it("Escape or a press elsewhere closes a pinned tip", () => {
    expect(hintOpen(run(["click", "escape"]))).toBe(false);
    expect(hintOpen(run(["enter", "click", "outside"]))).toBe(false);
  });

  it("the tip is portalled to the body, so no card's glass or overflow can place or clip it", () => {
    expect(hintSrc).toMatch(/class="tip"[^>]*use:portal/);
    expect(hintSrc).not.toContain("open = !open");
  });
});

// ---- a stand-in DOM, just enough for `use:tip` --------------------------
class FakeEl extends EventTarget {
  attrs: Record<string, string> = {};
  classList = (() => {
    const set = new Set<string>();
    return {
      add: (c: string) => void set.add(c),
      remove: (c: string) => void set.delete(c),
      contains: (c: string) => set.has(c),
    };
  })();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = "";
  hidden = false;
  className = "";
  id = "";
  isConnected = true;
  offsetWidth = 120;
  offsetHeight = 24;
  focusVisible = false;
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k: string) {
    return k in this.attrs;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  append() {}
  appendChild() {}
  contains(n: unknown) {
    return n === this;
  }
  matches(sel: string) {
    return sel === ":focus-visible" ? this.focusVisible : false;
  }
  getBoundingClientRect() {
    return { top: 400, bottom: 415, left: 900, right: 915 };
  }
}

type TipMod = typeof import("./tip");
let mod: TipMod;
let pillEl: FakeEl | null = null;
const doc = new EventTarget() as EventTarget & Record<string, unknown>;

beforeAll(async () => {
  doc.body = new FakeEl();
  doc.createElement = () => {
    const el = new FakeEl();
    if (!pillEl) pillEl = el;
    return el;
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1440, innerHeight: 900 }));
  mod = await import("./tip");
});

beforeEach(() => {
  vi.useFakeTimers();
  mod.coolTips();
});
afterEach(() => {
  vi.useRealTimers();
});

const shown = () => !!pillEl && pillEl.classList.contains("shown");
const fire = (t: EventTarget, type: string, init?: Record<string, unknown>) => {
  const e = new Event(type);
  for (const [k, v] of Object.entries(init ?? {})) Object.defineProperty(e, k, { value: v });
  t.dispatchEvent(e);
};

describe("`use:tip` `?` marks (approval note, subagent why): hover, click and keyboard focus open them", () => {
  it("hover shows the pill after the delay", () => {
    const a = new FakeEl();
    const act = mod.tip(a as unknown as HTMLElement, { text: "Why this asks", click: true });
    fire(a, "pointerenter");
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(mod.TIP_DELAY_MS + 1);
    expect(shown()).toBe(true);
    fire(a, "pointerleave");
    expect(shown()).toBe(false);
    act.destroy();
  });

  it("a click opens it at once and pins it: leaving keeps it, a second click closes it", () => {
    const a = new FakeEl();
    const act = mod.tip(a as unknown as HTMLElement, { text: "Why this asks", click: true });
    fire(a, "pointerdown");
    fire(a, "click");
    expect(shown()).toBe(true);
    fire(a, "pointerleave");
    expect(shown()).toBe(true);
    fire(a, "pointerdown");
    fire(a, "click");
    expect(shown()).toBe(false);
    act.destroy();
  });

  it("a click on a hovered mark keeps the pill (the press no longer dismisses it)", () => {
    const a = new FakeEl();
    const act = mod.tip(a as unknown as HTMLElement, { text: "Why this asks", click: true });
    fire(a, "pointerenter");
    vi.advanceTimersByTime(mod.TIP_DELAY_MS + 1);
    fire(a, "pointerdown");
    fire(a, "click");
    expect(shown()).toBe(true);
    act.destroy();
  });

  it("a press elsewhere or Escape closes a pinned pill", () => {
    const a = new FakeEl();
    const act = mod.tip(a as unknown as HTMLElement, { text: "Why this asks", click: true });
    fire(a, "click");
    expect(shown()).toBe(true);
    fire(doc, "pointerdown", { target: new FakeEl() });
    expect(shown()).toBe(false);
    fire(a, "click");
    expect(shown()).toBe(true);
    fire(a, "keydown", { key: "Escape" });
    expect(shown()).toBe(false);
    act.destroy();
  });

  it("keyboard focus shows it at once", () => {
    const a = new FakeEl();
    a.focusVisible = true;
    const act = mod.tip(a as unknown as HTMLElement, { text: "Why this asks", click: true });
    fire(a, "focus");
    expect(shown()).toBe(true);
    fire(a, "blur");
    expect(shown()).toBe(false);
    act.destroy();
  });

  it("an ordinary tip still hides on a press and a click does not open it", () => {
    const a = new FakeEl();
    const act = mod.tip(a as unknown as HTMLElement, "Send this message");
    fire(a, "pointerenter");
    vi.advanceTimersByTime(mod.TIP_DELAY_MS + 1);
    expect(shown()).toBe(true);
    fire(a, "pointerdown");
    fire(a, "click");
    expect(shown()).toBe(false);
    act.destroy();
  });

  it("pinStep: an unpinned pill pins open, a pinned one closes", () => {
    expect(mod.pinStep(false)).toEqual({ pinned: true, open: true });
    expect(mod.pinStep(true)).toEqual({ pinned: false, open: false });
  });
});

describe("every `?` mark in the app opens on click", () => {
  it("the approval note's `?` is a button (keyboard-reachable) in click mode", () => {
    expect(approvalSrc).toMatch(/<button type="button" class="q" use:tip=\{\{ text: NOTE_TIP\[kind\], click: true \}\}/);
  });
  it("the subagent card's `?` is in click mode", () => {
    expect(subagentSrc).toContain("use:tip={{ text: hintLong, click: true }}>?</button>");
  });
  it("Settings' `?` toggles its explanation on click (it always did)", () => {
    expect(settingRowSrc).toContain("onclick={() => setOpen(helpKey, !helpOpen)}>?</button");
  });
});
