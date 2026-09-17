import { describe, expect, it } from "vitest";
import {
  RESUME_GRACE_MS,
  SleepWatch,
  WAKE_POLL_MS,
  parseSleepPrefs,
  sleptThrough,
  type TurnEnd,
  type Woke,
} from "./sleep";

// Sleep-safe turns (nightshift backlog 101): the switches' defaults and
// the rule that names the turn sleep cut off.

describe("parseSleepPrefs", () => {
  it("defaults every switch on except ask, and reads each back", () => {
    const d = {
      keepAwake: true,
      keepDisplayAwake: true,
      resumeAfterSleep: true,
      resumeAsks: false,
    };
    expect(parseSleepPrefs(null)).toEqual(d);
    expect(parseSleepPrefs("nonsense")).toEqual(d);
    expect(parseSleepPrefs('{"keepAwake":false}')).toEqual({
      ...d,
      keepAwake: false,
    });
    expect(
      parseSleepPrefs('{"keepDisplayAwake":false,"resumeAsks":true}'),
    ).toEqual({
      ...d,
      keepDisplayAwake: false,
      resumeAsks: true,
    });
    expect(parseSleepPrefs('{"resumeAfterSleep":"yes"}')).toEqual(d);
  });
});

// A minute-long turn, the Mac asleep for an hour in the middle of it, the
// error landing a few seconds after the wake.
const T = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const wake: Woke = {
  slept_from_ms: T + 10_000,
  woke_at_ms: T + 10_000 + HOUR + 25_000,
};
const cut: TurnEnd = {
  startedAtMs: T,
  endedAtMs: wake.woke_at_ms - 20_000,
  errored: true,
  stopped: false,
  chat: "chat-x",
};

describe("sleptThrough", () => {
  it("names a turn that ran into the sleep and errored just after the wake", () => {
    expect(sleptThrough(cut, wake)).toBe(true);
  });

  it("is not a clean end, and not a Stop", () => {
    expect(sleptThrough({ ...cut, errored: false }, wake)).toBe(false);
    expect(sleptThrough({ ...cut, stopped: true }, wake)).toBe(false);
  });

  it("is not a turn that started after the Mac was already asleep", () => {
    expect(
      sleptThrough(
        { ...cut, startedAtMs: wake.slept_from_ms + WAKE_POLL_MS + 1 },
        wake,
      ),
    ).toBe(false);
    // Within one poll of the tick before is still before the sleep.
    expect(
      sleptThrough(
        { ...cut, startedAtMs: wake.slept_from_ms + WAKE_POLL_MS },
        wake,
      ),
    ).toBe(true);
  });

  it("is not an error from before the wake, nor one long after it", () => {
    expect(
      sleptThrough(
        { ...cut, endedAtMs: wake.woke_at_ms - WAKE_POLL_MS - 1 },
        wake,
      ),
    ).toBe(false);
    expect(
      sleptThrough(
        { ...cut, endedAtMs: wake.woke_at_ms + RESUME_GRACE_MS },
        wake,
      ),
    ).toBe(true);
    expect(
      sleptThrough(
        { ...cut, endedAtMs: wake.woke_at_ms + RESUME_GRACE_MS + 1 },
        wake,
      ),
    ).toBe(false);
  });
});

describe("SleepWatch", () => {
  it("matches whichever half arrives first, and only once", () => {
    const seen: TurnEnd[] = [];
    const w = new SleepWatch((t) => seen.push(t));
    // The error before the poll's tick noticed the wake.
    w.turnEnded(cut);
    expect(seen).toHaveLength(0);
    w.woke(wake);
    expect(seen).toHaveLength(1);
    // The same wake again does not re-fire on a stale end.
    w.woke(wake);
    expect(seen).toHaveLength(1);
    // The wake first, while the turn still runs; then its error.
    w.woke(wake);
    w.turnEnded(cut);
    expect(seen).toHaveLength(2);
  });

  it("lets a clean end after a wake go, and does not pair a later turn with it", () => {
    const seen: TurnEnd[] = [];
    const w = new SleepWatch((t) => seen.push(t));
    w.woke(wake);
    w.turnEnded({ ...cut, errored: false });
    expect(seen).toHaveLength(0);
    // A new turn, started after the wake, that fails for its own reasons.
    w.turnEnded({
      startedAtMs: wake.woke_at_ms + 60_000,
      endedAtMs: wake.woke_at_ms + 90_000,
      errored: true,
      stopped: false,
      chat: "chat-x",
    });
    expect(seen).toHaveLength(0);
  });

  it("hands the cut-off turn's chat to the match, so the resume can find it (backlog 137)", () => {
    const seen: TurnEnd[] = [];
    const w = new SleepWatch((t) => seen.push(t));
    w.woke(wake);
    w.turnEnded({ ...cut, chat: "the-one-sleep-cut" });
    expect(seen.map((t) => t.chat)).toEqual(["the-one-sleep-cut"]);
  });
});
