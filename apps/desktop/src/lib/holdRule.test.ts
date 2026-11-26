import { describe, expect, it } from "vitest";
import type { HoldView } from "./api";
import { boardWords, liveOvertake, nameIn, overtakeToast, overtakeWords, ruleWords, sleepSource } from "./holdRule";
import { holdRows, hourWords, idleWords, noticeRow, sleepWords, switchLabel, type KeepWarmStatus } from "./keepWarm";

const line = (id: string, half: number, selectable = true) => ({
  id,
  name: id === "sleep-cut-8h" ? "stop at your sleep, up to 8 h awake" : id,
  selectable,
  weeks: [],
  window: { avoided: 0, pings: 0, usd: 0, half },
});

const view = (over: Partial<HoldView> = {}): HoldView => ({
  active: "sleep-cut-8h",
  active_name: "stop at your sleep, up to 8 h awake",
  sleep: { start: 2, end: 9 },
  sleep_manual: false,
  learned_sleep: { start: 2, end: 9 },
  cap_ms: 8 * 3_600_000,
  scoring: false,
  board: {
    computed_ms: 0,
    moments: 474,
    weeks: [0, 1, 2, 3, 4].map(() => ({ start_ms: 0, end_ms: 0, train: 1, test: 1 })),
    table: [line("flat-6", 70.62), line("sleep-cut-8h", 77.35), line("foresight", 165.06, false)],
    active: "sleep-cut-8h",
    leader: "sleep-cut-8h",
    learned_sleep: { start: 2, end: 9 },
    overtake: null,
  },
  ...over,
});

const status = (now: number): KeepWarmStatus => ({
  chat: "c",
  mode: "on",
  scheduled: true,
  warm_until_ms: now + 3 * 3_600_000,
  touched_ms: null,
  next_ping_ms: now + 600_000,
  why: null,
  spent: { pings: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: 0 },
  policy: { every_ms: 55 * 60_000, cap_ms: 8 * 3_600_000, min_context: 50_000 },
  sleep_cut: true,
  sleep: { start: 2, end: 9 },
});

describe("item 878: the hold rule's words", () => {
  it("says his sleep in 12-hour words", () => {
    expect(hourWords(0)).toBe("12 AM");
    expect(hourWords(14)).toBe("2 PM");
    expect(sleepWords({ start: 2, end: 9 })).toBe("2–9 AM");
    expect(sleepWords({ start: 23, end: 6 })).toBe("11 PM–6 AM");
  });

  it("names the rule, its sleep and its place on the board", () => {
    const v = view();
    expect(ruleWords(v)).toBe("Stop at your sleep, up to 8 h awake · your sleep 2–9 AM");
    expect(sleepSource(v)).toBe("learned from when you reply and come back");
    expect(boardWords(v)).toBe(
      "Best of 2 rules on your last 4 weeks: $77.35 saved (perfect foresight: $165.06). Re-scored daily, 474 idle moments.",
    );
    expect(sleepSource(view({ sleep_manual: true, sleep: { start: 1, end: 8 } }))).toBe("set by you (your replies say 2–9 AM)");
    expect(boardWords(view({ board: null }))).toBeNull();
  });

  it("tells an overtake only against the rule in force", () => {
    const o = { id: "x", active: "sleep-cut-8h", challenger: "flat-6", active_usd: 70, challenger_usd: 80, weeks: 4 };
    const v = view();
    v.board!.overtake = o;
    expect(liveOvertake(v)).toBe(o);
    expect(overtakeWords(o, nameIn(v))).toBe("“flat-6” now beats it: $80.00 vs $70.00 over your last 4 weeks.");
    expect(overtakeToast(o, nameIn(v))).toContain("Switch in Settings");
    expect(liveOvertake(view({ active: "flat-6" }))).toBeNull();
  });

  it("the chip, the notice and the hold menu say when the run stops for his sleep", () => {
    const now = Date.parse("2026-11-23T23:30:00");
    const s = status(now);
    expect(switchLabel(s, now)).toMatch(/^warm until .* · you're usually asleep$/);
    expect(noticeRow(s, now)?.text).toMatch(/you're usually asleep then$/);
    const idle = { ...s, scheduled: false, why: "sleep" as const, sleep_cut: false };
    expect(idleWords(idle)).toBe("ended — no pings in your sleep (2–9 AM)");
    expect(holdRows(s)[0]).toMatchObject({ hours: 8, label: "8 h (default)", detail: "8 pings at most, none 2–9 AM" });
  });
});
