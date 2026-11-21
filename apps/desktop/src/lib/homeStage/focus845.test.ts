import { describe, expect, it } from "vitest";
import { freshFocus, pickTab, readFocus, secondOf, step, IDLE_MS, type Now } from "./focus";
import type { Tab } from "./tabs";

const tab = (id: string, view: Tab["view"], needs = 0): Tab => ({ id, view, name: id, needs, live: true });
const W = tab("watch", "watch");
const C = tab("chat", "chat");
const away = (now: number): Now => ({ now, lastTouch: 0, busy: false });
const here = (now: number): Now => ({ now, lastTouch: now, busy: false });
const none = () => false;

describe("845 focus rules (809 round 6's engine on live tabs)", () => {
  it("three tasks arrive while he is away: focus takes the first, the others wait as ready", () => {
    const k = freshFocus();
    step(k, [W, tab("task:a", "triage")], away(IDLE_MS), none, true);
    expect(k.focus).toBe("task:a");
    expect(k.note?.to).toBe("task:a");
    step(k, [W, tab("task:a", "triage"), tab("task:b", "run"), tab("task:c", "timeline")], away(IDLE_MS + 1), none, true);
    expect(k.focus).toBe("task:a");
    expect(k.ready).toEqual(["task:b", "task:c"]);
  });
  it("never moves under his hand: a needs-you while he works pulses, then follows after 10 quiet seconds", () => {
    const k = freshFocus();
    k.focus = "task:a";
    k.seen = { "task:a": 0, "task:b": 0 };
    const row = [W, tab("task:a", "todo"), tab("task:b", "triage", 1)];
    step(k, row, here(50_000), none, true);
    expect(k.focus).toBe("task:a");
    expect(k.ready).toEqual(["task:b"]);
    step(k, row, { now: 50_000 + IDLE_MS, lastTouch: 50_000, busy: false }, none, true);
    expect(k.focus).toBe("task:b");
  });
  it("what he asked for takes focus at once — unless he is typing in a view", () => {
    const k = freshFocus();
    step(k, [W, tab("task:m", "timeline")], { ...here(1000), busy: true }, (id) => id === "task:m", true);
    expect(k.focus).toBe("watch");
    expect(k.ready).toEqual(["task:m"]);
    const k2 = freshFocus();
    step(k2, [W, tab("task:m", "timeline")], here(1000), (id) => id === "task:m", true);
    expect(k2.focus).toBe("task:m");
    expect(k2.note).toBeNull();
  });
  it("Follow Home off: nothing moves by itself", () => {
    const k = freshFocus();
    k.follow = false;
    step(k, [W, tab("task:a", "triage", 2)], away(IDLE_MS * 3), none, true);
    expect(k.focus).toBe("watch");
    expect(k.ready).toEqual(["task:a"]);
  });
  it("the tab in focus goes: one switch to the best left, else Watch; nothing folds before the list is read", () => {
    const k = freshFocus();
    k.focus = "task:a";
    step(k, [W], here(1), none, false);
    expect(k.focus).toBe("task:a");
    k.seen = { "task:b": 0, "task:c": 1 };
    step(k, [W, tab("task:b", "run"), tab("task:c", "triage", 1), C], here(2), none, true);
    expect(k.focus).toBe("task:c");
    step(k, [W, C], here(3), none, true);
    expect(k.focus).toBe("watch");
  });
  it("a restart does not make old tabs new (seen is kept); his pick clears its ready mark", () => {
    const k = readFocus({ follow: true, seen: { "task:a": 0 }, ready: ["task:a", 7] }, "watch");
    expect(k.ready).toEqual(["task:a"]);
    step(k, [W, tab("task:a", "run")], away(IDLE_MS), none, true);
    expect(k.focus).toBe("task:a"); // it was already waiting; following takes it once he is away
    pickTab(k, "watch");
    expect(k.focus).toBe("watch");
  });
  it("split: the newest task tab not in focus, never Watch or Chat", () => {
    const k = freshFocus();
    k.split = true;
    k.focus = "task:a";
    expect(secondOf(k, [W, tab("task:a", "run"), tab("task:b", "triage"), C])?.id).toBe("task:b");
    k.split = false;
    expect(secondOf(k, [W, tab("task:a", "run"), tab("task:b", "triage")])).toBeUndefined();
  });
});
