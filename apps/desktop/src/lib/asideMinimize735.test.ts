import { beforeEach, describe, expect, it } from "vitest";
import { ASIDES_KEY, asideDraftKey, loadAsides, saveAsides } from "./asides";
import { app, switchAside } from "./state.svelte";
import type { Aside } from "./state.svelte";
import { expandAside, minimizeAside, noteAsideReply } from "./state/asides.svelte";
import { readDraft, setDraftText } from "./drafts.svelte";
import cardSrc from "./AsideCard.svelte?raw";
import layerSrc from "./AsideLayer.svelte?raw";

/**
 * Item 735 (blocker 2008, his "yes for the minimize plan"): an aside in the
 * main chat gets a minimize control; minimized, it is one line of its first
 * words in place, with a dot when an answer lands; a click opens it again.
 * Kept per thread across a chat switch and a relaunch; nothing he typed in
 * it is lost.
 */

class Mem {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const answered = (id: number, over: Partial<Aside> = {}): Aside => ({
  id,
  uid: `uid735-${id}`,
  quote: { text: "the passage", role: "assistant", ordinal: 2 },
  draft: false,
  turns: [{ seq: 7350 + id, question: "What does scored at the submit action mean?", partial: "x", answer: "x", error: null, cancelled: false, cacheRead: 0 }],
  anchor: { turn: 3, block: 0, start: 12, end: 40, side: "below" },
  ...over,
});

describe("735: minimize and expand", () => {
  beforeEach(() => {
    switchAside(null);
    app.activeSessionId = null;
  });

  it("minimize makes it one line; a click opens it again, in place", () => {
    const moved = { left: 160, top: -60, width: 440, from: "passage" as const };
    app.activeSessionId = "c735";
    app.asides = [answered(1, { moved })];
    const a = app.asides[0]!;
    minimizeAside(a);
    expect(a.minimized).toBe(true);
    expect(a.moved).toEqual(moved); // a moved card stays where it was moved
    expandAside(a);
    expect(a.minimized).toBe(false);
    expect(a.moved).toEqual(moved);
  });

  it("an answer landing while minimized lights the dot; opening clears it", () => {
    app.activeSessionId = "c735";
    app.asides = [answered(1), answered(2)];
    const [a, b] = app.asides as [Aside, Aside];
    minimizeAside(a);
    noteAsideReply(7351);
    noteAsideReply(7352); // b is open: no dot
    expect(a.newReply).toBe(true);
    expect(b.newReply).toBeFalsy();
    expandAside(a);
    expect(a.newReply).toBe(false);
  });

  it("the dot lights for a minimized thread in a chat he is not looking at", () => {
    app.activeSessionId = "c735";
    app.asides = [answered(3)];
    minimizeAside(app.asides[0]!);
    switchAside("other");
    app.activeSessionId = "other";
    noteAsideReply(7353);
    switchAside("c735");
    app.activeSessionId = "c735";
    expect(app.asides[0]!.newReply).toBe(true);
  });

  it("minimizing never loses what he typed in the aside's box", () => {
    app.activeSessionId = "c735";
    app.asides = [answered(4)];
    const a = app.asides[0]!;
    const key = asideDraftKey(a);
    setDraftText(key, "a half-typed follow-up");
    minimizeAside(a);
    expect(readDraft(key).text).toBe("a half-typed follow-up");
    expandAside(a);
    expect(readDraft(key).text).toBe("a half-typed follow-up");
  });

  it("a minimized card does not count as open for the three-card cap", () => {
    app.activeSessionId = "c735";
    app.asides = [answered(5), answered(6), answered(7), answered(8)];
    const list = app.asides as Aside[];
    minimizeAside(list[3]!);
    expandAside(list[0]!);
    // Three open (0,1,2) and one minimized: nothing folds.
    expect(list.filter((x) => x.folded).length).toBe(0);
  });
});

describe("735: kept across a chat switch and a relaunch", () => {
  beforeEach(() => {
    switchAside(null);
    app.activeSessionId = null;
  });

  it("a chat switch keeps it minimized", () => {
    app.activeSessionId = "c735";
    app.asides = [answered(9)];
    minimizeAside(app.asides[0]!);
    switchAside("other");
    app.activeSessionId = "other";
    switchAside("c735");
    app.activeSessionId = "c735";
    expect(app.asides[0]!.minimized).toBe(true);
  });

  it("is written with the thread and read back, dot and all", () => {
    const s = new Mem();
    saveAsides(
      new Map([["c1", [answered(1, { minimized: true, newReply: true }), answered(2, { minimized: true }), answered(3)]]]),
      s,
    );
    const back = loadAsides(s).get("c1")!;
    expect(back[0]!.minimized).toBe(true);
    expect(back[0]!.newReply).toBe(true);
    expect(back[1]!.minimized).toBe(true);
    expect(back[1]!.newReply).toBeUndefined();
    expect(back[2]!.minimized).toBeUndefined();
    // An open card stores no dot.
    const raw = JSON.parse(s.getItem(ASIDES_KEY)!) as Record<string, { newReply?: true }[]>;
    expect(raw.c1![2]!.newReply).toBeUndefined();
  });
});

describe("735: the card's markup", () => {
  it("has a minimize control in the head of a main-chat card, not the panel's", () => {
    expect(cardSrc).toMatch(/\{#if !panel\}\s*<!-- Item 735: minimize[\s\S]*?onclick=\{\(\) => minimizeMoving\(\)\}/);
    // Item 755: through the fold motion, which still calls minimizeAside.
    expect(cardSrc).toMatch(/function minimizeMoving\(\)[\s\S]*?minimizeAside\(aside\)/);
  });
  it("draws the one line with its first words and the dot, and opens on click or Enter", () => {
    expect(cardSrc).toMatch(/asideLabel\(aside, 40\)/);
    expect(cardSrc).toMatch(/class="aside-mini-dot"/);
    expect(cardSrc).toMatch(/onclick=\{\(\) => expandMoving\(\)\}/);
    expect(cardSrc).toMatch(/function expandMoving\(\)[\s\S]*?expandAside\(aside\)/);
    expect(cardSrc).toMatch(/e\.key !== "Enter" && e\.key !== " "/);
  });
  it("styles it for both looks", () => {
    expect(cardSrc).toMatch(/\.aside-card\.minimized \{/);
    expect(cardSrc).toMatch(/:root:not\(\[data-layout="classic"\]\)\)\) \.aside-card\.minimized/);
  });
  it("a stray Escape never closes a minimized line", () => {
    expect(layerSrc).toMatch(/!a\.folded && !a\.minimized/);
  });
});
