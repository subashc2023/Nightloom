import { beforeEach, describe, expect, it } from "vitest";
import {
  AWAY_MS,
  handoff,
  IDLE_AWAY_MS,
  isAway,
  isUnattended,
  mark,
  markAt,
  markAttended,
  markShare,
  markText,
  markUnattended,
  NEVER,
  neverHandsOff,
  noteActivity,
  noteChatProject,
  noteFill,
  noteThread,
  ownMark,
  parseMark,
  parseStored,
  pickMark,
  queuesAtTurnEnd,
  resetHandoff,
  setMarkAt,
  threadKey,
  UNFILED,
} from "./handoff.svelte";
import { drafts, readDraft } from "./drafts.svelte";

// Items 544 and 545, the pure half.

const NOW = 1_800_000_000_000;

describe("544 — away, with the window in front", () => {
  it("as before: a minute without typing and the window not in front, or the chat not open", () => {
    expect(isAway(NOW, NOW - AWAY_MS, false, true)).toBe(true);
    expect(isAway(NOW, NOW - AWAY_MS, true, false)).toBe(true);
    expect(isAway(NOW, NOW - AWAY_MS, true, true)).toBe(false);
    expect(isAway(NOW, NOW - 1000, false, false)).toBe(false);
  });
  it("a Mac nobody has touched for ten minutes is away even with Nightloom in front on that chat", () => {
    expect(isAway(NOW, NOW - AWAY_MS, true, true, IDLE_AWAY_MS)).toBe(true);
    expect(isAway(NOW, NOW - AWAY_MS, true, true, IDLE_AWAY_MS - 1)).toBe(false);
  });
});

describe("544 — a chat already past its mark is wrapped up at a turn's end only when it runs unattended", () => {
  it("the pure rule", () => {
    expect(queuesAtTurnEnd("due", true, 0, 0, true)).toBe(true);
    expect(queuesAtTurnEnd("due", true, 0, 0, false)).toBe(false); // he is driving it: the notice waits
    expect(queuesAtTurnEnd("due", false, 0, 0, true)).toBe(false); // he is here
    expect(queuesAtTurnEnd("due", true, 0.8, 0, true)).toBe(false); // he chose Stay here
    expect(queuesAtTurnEnd("due", true, 0, 7, true)).toBe(false); // already queued
    expect(queuesAtTurnEnd("idle", true, 0, 0, true)).toBe(false);
  });

  beforeEach(() => {
    resetHandoff();
    for (const k of Object.keys(drafts)) delete drafts[k];
    for (const c of ["u1", "u2", "n1"]) {
      markAttended(c);
      setMarkAt("chat", c, null);
    }
    noteActivity(0);
  });

  it("present at the crossing, gone later: an unattended chat's next turn end queues the wrap-up; a chat he drives is left", () => {
    // Present at the crossing (mid-turn): the notice, nothing queued.
    noteFill("u1", 150_000, 200_000, false);
    expect(handoff.stage).toBe("due");
    expect(readDraft("u1").queue).toEqual([]);
    // Away at a later turn's end, but he is driving it: still nothing.
    noteFill("u1", 155_000, 200_000, true, null, true);
    expect(readDraft("u1").queue).toEqual([]);
    // Nightloom resumed it (a limit resume, an asked continuation): now it queues, once.
    markUnattended("u1");
    noteFill("u1", 156_000, 200_000, true, null, true);
    expect(readDraft("u1").queue).toHaveLength(1);
    noteFill("u1", 157_000, 200_000, true, null, true);
    expect(readDraft("u1").queue).toHaveLength(1);
  });

  it("the crossing while away marks the chat unattended; a mid-turn reading never queues a seen notice", () => {
    noteFill("u2", 150_000, 200_000, true);
    expect(readDraft("u2").queue).toHaveLength(1);
    expect(isUnattended("u2")).toBe(true);
    markAttended("u2");
    expect(isUnattended("u2")).toBe(false);
  });

  it("545: a chat whose mark is never is not wrapped up while he is away", () => {
    setMarkAt("chat", "n1", NEVER);
    markUnattended("n1");
    noteFill("n1", 199_000, 200_000, true);
    noteFill("n1", 199_500, 200_000, true, null, true);
    expect(handoff.stage).toBe("idle");
    expect(readDraft("n1").queue).toEqual([]);
    expect(neverHandsOff("n1")).toBe(true);
  });
});

describe("545 — the mark of a chat, its thread and its project", () => {
  beforeEach(() => {
    for (const [scope, key] of [
      ["chat", "c1"],
      ["thread", threadKey("p1", "alpha")],
      ["project", "p1"],
      ["project", UNFILED],
    ] as const)
      setMarkAt(scope, key, null);
    noteChatProject("c1", "p1");
    noteThread("c1", "alpha");
  });

  it("what he types: a percent, tokens, never; blank clears; nonsense changes nothing", () => {
    expect(parseMark("60")).toBe(0.6);
    expect(parseMark("60%")).toBe(0.6);
    expect(parseMark("0.45")).toBe(0.45);
    expect(parseMark("300k")).toBe(300_000);
    expect(parseMark("250,000")).toBe(250_000);
    expect(parseMark("1.2m")).toBe(1_200_000);
    expect(parseMark("Never")).toBe(NEVER);
    expect(parseMark("  ")).toBeNull();
    expect(parseMark("soon")).toBeUndefined();
    expect(parseMark("150%")).toBeUndefined();
    expect(parseMark("0")).toBeUndefined();
    expect([markText(0.6), markText(300_000), markText(NEVER)]).toEqual(["60%", "300k", "never"]);
  });

  it("precedence: chat, then thread, then project, then the Settings default", () => {
    expect(pickMark(0.5, 0.6, 0.7)).toEqual({ scope: "chat", value: 0.5 });
    expect(pickMark(undefined, 0.6, 0.7)).toEqual({ scope: "thread", value: 0.6 });
    expect(pickMark(undefined, undefined, 0.7)).toEqual({ scope: "project", value: 0.7 });
    expect(pickMark(undefined, undefined, undefined)).toBeNull();

    const base = mark("c1", 1_000_000);
    expect(ownMark("c1")).toBeNull();
    setMarkAt("project", "p1", 0.4);
    expect(mark("c1", 1_000_000)).toBe(0.4);
    setMarkAt("thread", threadKey("p1", "alpha"), 500_000);
    expect(mark("c1", 1_000_000)).toBe(0.5); // tokens over the window
    expect(ownMark("c1")?.scope).toBe("thread");
    setMarkAt("chat", "c1", NEVER);
    expect(mark("c1", 1_000_000)).toBe(NEVER);
    expect(neverHandsOff("c1")).toBe(true);
    setMarkAt("chat", "c1", null);
    setMarkAt("thread", threadKey("p1", "alpha"), null);
    setMarkAt("project", "p1", null);
    expect(mark("c1", 1_000_000)).toBe(base);
    // Another project's mark, or another thread's, is not this chat's.
    setMarkAt("project", "p2", 0.2);
    setMarkAt("thread", threadKey("p2", "alpha"), 0.2);
    expect(mark("c1", 1_000_000)).toBe(base);
    setMarkAt("project", "p2", null);
    setMarkAt("thread", threadKey("p2", "alpha"), null);
  });

  it("a mark is set before the chat reaches it, and kept in the store", () => {
    setMarkAt("project", "p1", 0.3);
    expect(markAt("project", "p1")).toBe(0.3);
    resetHandoff();
    noteFill("c1", 70_000, 200_000, false); // 35%: past the project's 30%, under the default
    expect(handoff.stage).toBe("due");
    resetHandoff();
    const kept = parseStored(JSON.stringify({ perThread: { "p1/alpha": 300_000, bad: -1 }, perProject: { p1: 2, q: "x" }, perChat: { c: 0.5, n: 2 } }));
    expect(kept.perThread).toEqual({ "p1/alpha": 300_000 });
    expect(kept.perProject).toEqual({ p1: 2 });
    expect(kept.perChat).toEqual({ c: 0.5, n: 2 });
    expect(markShare(300_000, null)).toBe(1);
    expect(markShare(300_000, 1_000_000)).toBe(0.3);
  });
});
