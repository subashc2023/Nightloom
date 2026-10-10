import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(true)) }));

import { Prewarmer, prewarmAfterTurn, turnEnded, wantsWarm, wantsWarmAtTurnEnd } from "./prewarm";

describe("wantsWarm (item 256)", () => {
  const base = { engine: "claude-code", busy: false, aside: false, text: "hello" };
  it("asks for a draft in the chat's own box on the agent engine", () => {
    expect(wantsWarm(base)).toBe(true);
  });
  it("does not while a turn runs, in an aside, on a provider, or with no draft", () => {
    expect(wantsWarm({ ...base, busy: true })).toBe(false);
    expect(wantsWarm({ ...base, aside: true })).toBe(false);
    expect(wantsWarm({ ...base, engine: "anthropic" })).toBe(false);
    expect(wantsWarm({ ...base, engine: null })).toBe(false);
    expect(wantsWarm({ ...base, text: "   " })).toBe(false);
  });
  it("does not for a slash command, which goes on argv", () => {
    expect(wantsWarm({ ...base, text: " /compact" })).toBe(false);
  });
});

describe("Prewarmer (item 256)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("asks at once, then at most once per window, keeping the last poke", () => {
    let t = 0;
    const ask = vi.fn();
    const p = new Prewarmer(ask, 1000, () => t);
    p.poke();
    expect(ask).toHaveBeenCalledTimes(1);
    t = 200;
    p.poke();
    t = 400;
    p.poke();
    expect(ask).toHaveBeenCalledTimes(1);
    // The trailing ask, at the window's end.
    t = 1000;
    vi.advanceTimersByTime(800);
    expect(ask).toHaveBeenCalledTimes(2);
    // Quiet afterwards.
    vi.advanceTimersByTime(5000);
    expect(ask).toHaveBeenCalledTimes(2);
    t = 2500;
    p.poke();
    expect(ask).toHaveBeenCalledTimes(3);
  });
});

describe("turn-end prewarm (blocker 1240)", () => {
  it("is a turn end only when the same chat stops running", () => {
    expect(turnEnded({ busy: true, chat: "a" }, { busy: false, chat: "a" })).toBe(true);
    // A new chat's first turn: its id comes after.
    expect(turnEnded({ busy: true, chat: null }, { busy: false, chat: null })).toBe(true);
    // Sent to the background because he opened another chat.
    expect(turnEnded({ busy: true, chat: "a" }, { busy: false, chat: "b" })).toBe(false);
    expect(turnEnded({ busy: false, chat: "a" }, { busy: false, chat: "a" })).toBe(false);
    expect(turnEnded({ busy: false, chat: "a" }, { busy: true, chat: "a" })).toBe(false);
  });

  it("wants a process for an empty box, not for an aside, another engine or a slash command", () => {
    const base = { engine: "claude-code", aside: false, text: "" };
    expect(wantsWarmAtTurnEnd(base)).toBe(true);
    expect(wantsWarmAtTurnEnd({ ...base, text: "half a thought" })).toBe(true);
    expect(wantsWarmAtTurnEnd({ ...base, aside: true })).toBe(false);
    expect(wantsWarmAtTurnEnd({ ...base, engine: "anthropic" })).toBe(false);
    expect(wantsWarmAtTurnEnd({ ...base, text: " /compact" })).toBe(false);
  });

  it("asks again while the backend skips, and stops at the first start", async () => {
    const answers = [false, true, true];
    const ask = vi.fn(() => Promise.resolve(answers.shift() as boolean));
    const sleep = vi.fn(() => Promise.resolve());
    expect(await prewarmAfterTurn(ask, 3, 400, sleep)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(400);
  });

  it("gives up after its tries, and at once on an error", async () => {
    const no = vi.fn(() => Promise.resolve(false));
    expect(await prewarmAfterTurn(no, 3, 0, () => Promise.resolve())).toBe(false);
    expect(no).toHaveBeenCalledTimes(3);
    const err = vi.fn(() => Promise.reject(new Error("not connected")));
    expect(await prewarmAfterTurn(err, 3, 0, () => Promise.resolve())).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
  });
});
