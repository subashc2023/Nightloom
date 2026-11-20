import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "./state.svelte";
import type { Aside } from "./state.svelte";
import * as tabs from "./tabs";
import { allRunning } from "./running.svelte";
import { asideRun, chatRun } from "./runGroups";
import type { RunEntry } from "./running";
import { tabStripLogic } from "./tabStrip/logic.svelte";
import { BoxHistory, forgetHistories, boxHistoryFor } from "./boxHistory";
import topBarSrc from "./TopBar.svelte?raw";
import topBarClassicSrc from "./TopBarClassic.svelte?raw";
import cardSrc from "./AsideCard.svelte?raw";
import composerSrc from "./Composer.svelte?raw";

/**
 * Item 886 (2026-11-19, his "aside does not have the running label showing
 * that something is running … doesn't have the little dot on the tab", then
 * "command z and undos and redos … don't seem to save when I switch to
 * another tab and switch back"): an aside shows the chat's running sign and
 * tab dot, read from the same state, and every box's undo history is its
 * draft's, kept across a tab switch.
 */

const asking = (id: number): Aside => ({
  id,
  uid: `uid-${id}`,
  quote: null,
  draft: false,
  anchor: null,
  turns: [
    { seq: 1, question: "first", partial: "a", answer: "a", error: null, cancelled: false, cacheRead: 0 },
    { seq: 2, question: "does B go left?", partial: "", answer: null, error: null, cancelled: false, cacheRead: 0, startedAt: Date.now() - 5000 },
  ],
});
const answered = (id: number): Aside => ({ ...asking(id), turns: [asking(id).turns[0]!] });

describe("an aside's running sign (item 886)", () => {
  const row = (over: Partial<RunEntry>): RunEntry =>
    ({ id: "x", kind: "turn", project: null, where: "", session: "s1", chat: "", doing: "", startedAt: 1, onScreen: true, waiting: false, survivesQuit: false, ...over }) as RunEntry;

  it("reads the aside's own row: running with its clock, idle without", () => {
    const runs = [row({ id: "aside:7:2", kind: "aside", doing: "does B go left?", startedAt: 42 })];
    expect(asideRun(runs, "s1", 7)).toEqual({ state: "running", startedAt: 42, agents: 0, doing: "does B go left?" });
    expect(asideRun(runs, "s1", 8).state).toBe("idle");
    // Another chat's aside of the same id is not this one.
    expect(asideRun(runs, "s2", 7).state).toBe("idle");
    // And an aside is not its chat's turn (556's rule, unchanged).
    expect(chatRun(runs, "s1").state).toBe("idle");
  });

  it("is on in the live running list while the aside asks, off once answered", () => {
    const saved = { asides: app.asides, active: app.activeSessionId };
    try {
      app.activeSessionId = "s1";
      app.asides = [asking(7), answered(8)];
      const runs = allRunning();
      expect(asideRun(runs, "s1", 7).state).toBe("running");
      expect(asideRun(runs, "s1", 8).state).toBe("idle");
    } finally {
      app.asides = saved.asides;
      app.activeSessionId = saved.active;
    }
  });

  it("is drawn on the aside tab's bar in both layouts, and on its card's head", () => {
    for (const src of [topBarSrc, topBarClassicSrc]) {
      expect(src).toContain('<ChatRunSign aside={T.aside} session={T.asideChat} />');
      expect(src).toContain('T.asideRunSign !== "idle"');
    }
    expect(cardSrc).toContain("<ChatRunSign {aside} session={owner} />");
  });
});

describe("an aside tab's running dot (item 886)", () => {
  let saved: { asides: Aside[]; tabs: typeof app.tabs; active: string | null };
  beforeEach(() => {
    saved = { asides: app.asides, tabs: app.tabs, active: app.activeSessionId };
    app.activeSessionId = "s1";
  });
  afterEach(() => {
    app.asides = saved.asides;
    app.tabs = saved.tabs;
    app.activeSessionId = saved.active;
  });

  it("lights while the tab's thread asks, as a chat's tab does, and not for a sibling thread", () => {
    app.asides = [asking(7), answered(8)];
    const pane = tabs.focusedPane(app.tabs);
    const t7 = tabs.land(app.tabs, pane, { kind: "aside", session: "s1", thread: 7 }, "new");
    const t8 = tabs.land(app.tabs, pane, { kind: "aside", session: "s1", thread: 8 }, "new");
    const T = tabStripLogic(() => ({ pane }));
    expect(T.running(t7)).toBe(true);
    expect(T.running(t8)).toBe(false);
    app.asides[0]!.turns[1]!.answer = "yes";
    expect(T.running(t7)).toBe(false);
  });
});

describe("a box's undo history survives a switch (item 886)", () => {
  beforeEach(() => forgetHistories());

  it("gives a key back its history, apart from every other key's", () => {
    let t = 0;
    const h = boxHistoryFor("aside:uid-7", "", () => (t += 1000));
    h.before({ text: "", start: 0, end: 0 });
    h.input("type", { text: "first", start: 5, end: 5 });
    h.before({ text: "first", start: 5, end: 5 });
    h.input("type", { text: "first second", start: 12, end: 12 });
    // The chat's box takes its own key meanwhile.
    const c = boxHistoryFor("s1", "");
    expect(c.canUndo).toBe(false);
    // Back on the aside: the same steps.
    const back = boxHistoryFor("aside:uid-7", "first second");
    expect(back).toBe(h);
    expect(back.undo()?.text).toBe("first");
    expect(back.redo()?.text).toBe("first second");
  });

  it("takes a change made while the box was away as a step, and an emptied draft fresh", () => {
    const h = boxHistoryFor("s1", "abc");
    expect(boxHistoryFor("s1", "abcd").undo()?.text).toBe("abc");
    expect(h.canUndo).toBe(false);
    boxHistoryFor("s1", "x");
    expect(boxHistoryFor("s1", "").canUndo).toBe(false);
  });

  it("is what the composer uses, for the chat's box and an aside's alike", () => {
    expect(composerSrc).toContain("let hist = boxHistoryFor(untrack(() => key), untrack(() => text));");
    expect(composerSrc).toContain("hist = boxHistoryFor(k, t);");
    expect(composerSrc).not.toMatch(/=\s*new BoxHistory\(/);
    expect(new BoxHistory("a").current.text).toBe("a");
  });
});
