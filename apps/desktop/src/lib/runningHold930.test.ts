// Item 930: the "running" power hold — taken when anything runs, released after 30 s of nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_NAME, RELEASE_MS, RunningHold } from "./runningHold";
import appSrc from "../App.svelte?raw";

const calls: string[] = [];
const mk = () => new RunningHold(async (n, on) => void calls.push(`${n}:${on}`));
beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("930: running hold", () => {
  it("a turn starts: the named hold is taken once", () => {
    const h = mk();
    h.note(true);
    h.note(true);
    expect(calls).toEqual([`${HOLD_NAME}:true`]);
    expect(h.on).toBe(true);
  });
  it("all idle: released only after 30 s", () => {
    const h = mk();
    h.note(true);
    h.note(false);
    vi.advanceTimersByTime(RELEASE_MS - 1);
    expect(h.on).toBe(true);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["running:true", "running:false"]);
    expect(h.on).toBe(false);
  });
  it("back-to-back turns do not flap", () => {
    const h = mk();
    h.note(true);
    h.note(false);
    vi.advanceTimersByTime(10_000);
    h.note(true);
    vi.advanceTimersByTime(RELEASE_MS * 2);
    expect(calls).toEqual(["running:true"]);
  });
  it("is the name 912's hold is not", () => {
    expect(HOLD_NAME).not.toBe("handoff");
    expect(RELEASE_MS).toBe(30000);
  });
  it("App watches everything the running list shows", () => {
    expect(appSrc).toMatch(/runningHold\.note\(allRunning\(\)\.length > 0 \|\| turnsRunning\(\)\)/);
  });
});
