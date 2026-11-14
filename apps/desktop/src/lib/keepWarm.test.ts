import { describe, expect, it, vi } from "vitest";
import { cacheState } from "./cache";
import {
  HOLD_PRESS_MS,
  POINTS_PER_PING,
  capOf,
  clockTime,
  holdPress,
  holdRows,
  holdWords,
  idleWords,
  isKeeping,
  isOn,
  noticeLine,
  noticeRow,
  rowToggle,
  perHourWords,
  pingsUnder,
  switchLabel,
  switchTitle,
  touchedUntil,
  type KeepWarmStatus,
} from "./keepWarm";
import type { SessionEvent } from "./types";
import noticeSrc from "./KeepWarmNotice.svelte?raw";

const HOUR = 3_600_000;
const MIN = 60_000;
// 5:00 PM local on a fixed day, so the clock words are his.
const T0 = new Date(2026, 10, 10, 17, 0, 0).getTime();

function status(over: Partial<KeepWarmStatus> = {}): KeepWarmStatus {
  return {
    chat: "c1",
    mode: "on",
    scheduled: true,
    warm_until_ms: T0 + 390 * MIN,
    touched_ms: null,
    next_ping_ms: T0 + 55 * MIN,
    why: null,
    spent: { pings: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: 0 },
    policy: { every_ms: 55 * MIN, cap_ms: 6 * HOUR, min_context: 50_000 },
    ...over,
  };
}

describe("keep-warm words (backlog 582)", () => {
  it("reads the clock in 12-hour time", () => {
    expect(clockTime(T0 + 390 * MIN)).toBe("11:30 PM");
  });

  it("labels the switch off, running, and on-but-idle", () => {
    expect(switchLabel(null, T0)).toBe("keep warm");
    expect(switchLabel(status({ mode: "off", scheduled: false, why: "off" }), T0)).toBe("keep warm");
    expect(switchLabel(status(), T0)).toBe("warm until 11:30 PM");
    expect(switchLabel(status({ mode: "once" }), T0)).toBe("warm until 11:30 PM");
    const idle = (why: KeepWarmStatus["why"]) => switchLabel(status({ scheduled: false, why, next_ping_ms: null }), T0);
    expect(idle("small")).toBe("keep warm · starts at 50k tokens");
    expect(idle("noreply")).toBe("keep warm · starts after the next reply");
    expect(idle("cap")).toBe("keep warm · ended — 6 h since the last reply");
    expect(idle("cold")).toContain("went cold");
    expect(idle("missed")).toContain("missed the cache");
    expect(idle("busy")).toBe("keep warm on");
  });

  it("says nothing under his message unless the cache is being kept", () => {
    expect(noticeLine(status(), T0)).toBe("Keeping warm until ~11:30 PM");
    expect(noticeLine(null, T0)).toBeNull();
    expect(noticeLine(status({ mode: "off" }), T0)).toBeNull();
    expect(noticeLine(status({ scheduled: false, why: "cap" }), T0)).toBeNull();
    // Past the schedule's end the line is gone.
    expect(noticeLine(status(), T0 + 391 * MIN)).toBeNull();
    expect(isKeeping(status(), T0)).toBe(true);
    expect(isOn(status({ scheduled: false, why: "small" }))).toBe(true);
  });

  it("tells the whole rule and what was spent in the tooltip", () => {
    const off = switchTitle(null, T0);
    expect(off).toContain("every 55 min");
    expect(off).toContain("up to 6 h");
    expect(off).toContain("50k tokens or more");
    expect(off).toContain("Off — click to switch on");
    const on = switchTitle(status({ spent: { pings: 2, cache_read: 240_000, cache_write: 600, output: 8, cost_usd: 0.05 } }), T0);
    expect(on).toContain("warm until about 11:30 PM, next request 5:55 PM");
    expect(on).toContain("2 pings, 240k tokens read from the cache, 600 written, about $0.05");
    // A retuned cap shows as set, not as shipped.
    expect(switchTitle(status({ policy: { every_ms: 55 * MIN, cap_ms: 4 * HOUR, min_context: 50_000 } }), T0)).toContain("up to 4 h");
    expect(idleWords(status({ why: "cap", policy: { every_ms: 55 * MIN, cap_ms: 4 * HOUR, min_context: 50_000 } }))).toContain("4 h");
  });

  it("says whether the switch is the default's or his (item 608)", () => {
    const byDefault = switchTitle(status({ chosen: false, default_on: true }), T0);
    expect(byDefault).toContain("on by default for every chat — Settings → Subscription → Keeping caches warm");
    expect(byDefault).toContain("Click to switch off for this chat.");
    expect(switchTitle(status({ chosen: true, default_on: true }), T0)).toContain("switched on for this chat");
    const hisOff = switchTitle(status({ mode: "off", scheduled: false, why: "off", chosen: true, default_on: true }), T0);
    expect(hisOff).toContain("Off for this chat — you switched it off");
    expect(hisOff).toContain("click to switch on for this chat");
    const defaultOff = switchTitle(status({ mode: "off", scheduled: false, why: "off", chosen: false, default_on: false }), T0);
    expect(defaultOff).toContain("Off — the default is off");
    // A new chat on by default reads on before its first reply.
    const fresh = status({ scheduled: false, why: "noreply", next_ping_ms: null, warm_until_ms: null, chosen: false, default_on: true });
    expect(isOn(fresh)).toBe(true);
    expect(switchLabel(fresh, T0)).toBe("keep warm · starts after the next reply");
  });

  it("moves the cache timer to the last ping's hour", () => {
    const events = [
      { event: "user_message", text: "q", at: new Date(T0).toISOString() },
      {
        event: "assistant_message",
        model: "m",
        blocks: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 100_000, output_tokens: 10 },
        at: new Date(T0 + MIN).toISOString(),
        sent_at: new Date(T0).toISOString(),
        cache_ttl: "1h",
      },
    ] as unknown as SessionEvent[];
    // Without a ping: cold at 70 minutes.
    expect(cacheState(events, T0 + 70 * MIN)?.warm).toBe(false);
    // A ping at 55 minutes: warm until 115.
    const kept = touchedUntil(status({ touched_ms: T0 + 55 * MIN }));
    expect(kept).toBe(T0 + 115 * MIN);
    const c = cacheState(events, T0 + 70 * MIN, kept);
    expect(c?.warm).toBe(true);
    expect(c?.warmUntil).toBe(T0 + 115 * MIN);
    // An older touch never shortens the reply's own hour; off ignores it.
    expect(cacheState(events, T0, T0 - MIN)?.warmUntil).toBe(T0 + HOUR);
    expect(touchedUntil(status({ mode: "off", touched_ms: T0 }))).toBeNull();
  });
});

describe("hold longer (item 643)", () => {
  it("offers 6 h (default), 12 h and 24 h with the extra pings and their cost", () => {
    const rows = holdRows(status());
    expect(rows.map((r) => [r.hours, r.label, r.detail, r.on])).toEqual([
      [6, "6 h (default)", "6 pings at most", true],
      [12, "12 h", "+7 pings ≈ 0.14 pts", false],
      [24, "24 h", "+20 pings ≈ 0.40 pts", false],
    ]);
    expect(holdRows(status({ hold_hours: 24 })).map((r) => r.on)).toEqual([false, false, true]);
    // No status yet: the shipped numbers.
    expect(holdRows(null).map((r) => r.hours)).toEqual([6, 12, 24]);
    expect(pingsUnder(24 * HOUR, 55 * MIN)).toBe(26);
    expect(POINTS_PER_PING).toBe(0.02);
    expect(perHourWords(status())).toContain("≈ 0.02 points of the 5-hour window per extra hour");
    expect(perHourWords(status())).toContain("item 541");
  });

  it("says the hold in the tooltip and uses its cap", () => {
    const held = status({ cap_ms: 24 * HOUR, hold_hours: 24, hold_until_ms: T0 + 24 * HOUR });
    const t = switchTitle(held, T0);
    expect(t).toContain("for up to 24 h");
    expect(t).toContain("Held 24 h for this chat (until ~Wed 5:00 PM unless you reply again), then back to 6 h.");
    expect(idleWords({ ...held, why: "cap" })).toBe("ended — 24 h since the last reply");
    expect(capOf(held)).toBe(24 * HOUR);
    expect(capOf(status())).toBe(6 * HOUR);
    expect(holdWords(status(), T0)).toBe("");
    // Discoverable: every tooltip, on or off, ends with the hint.
    expect(switchTitle(status(), T0)).toContain("Right-click or press and hold to keep it warm for 12 h or 24 h.");
    expect(switchTitle(null, T0)).toContain("Right-click or press and hold");
  });

  it("opens on a right-click or a 500 ms press, and swallows the click that ends a long press", () => {
    vi.useFakeTimers();
    const on: Record<string, ((e: unknown) => void)[]> = {};
    const node = {
      addEventListener: (k: string, f: (e: unknown) => void) => (on[k] ??= []).push(f),
      removeEventListener: (k: string, f: (e: unknown) => void) => (on[k] = (on[k] ?? []).filter((g) => g !== f)),
    } as unknown as HTMLElement;
    const fire = (k: string, e: Record<string, unknown> = {}) => {
      const ev = { button: 0, defaultPrevented: false, stopped: false, preventDefault() { ev.defaultPrevented = true; }, stopImmediatePropagation() { ev.stopped = true; }, ...e };
      for (const f of on[k] ?? []) f(ev);
      return ev;
    };
    let opened = 0;
    const action = holdPress(node, () => opened++);
    // A plain click: nothing opens, the click goes through.
    fire("pointerdown");
    vi.advanceTimersByTime(200);
    fire("pointerup");
    expect(fire("click").stopped).toBe(false);
    expect(opened).toBe(0);
    // A held press opens at 500 ms; its click is swallowed (the switch does not flip).
    fire("pointerdown");
    vi.advanceTimersByTime(HOLD_PRESS_MS);
    expect(opened).toBe(1);
    fire("pointerup");
    expect(fire("click").stopped).toBe(true);
    expect(fire("click").stopped).toBe(false);
    // A right-click opens at once, without the system menu.
    expect(fire("contextmenu").defaultPrevented).toBe(true);
    expect(opened).toBe(2);
    // A press with the right button does not start the timer.
    fire("pointerdown", { button: 2 });
    vi.advanceTimersByTime(1000);
    expect(opened).toBe(2);
    action.destroy();
    expect(Object.values(on).every((l) => l.length === 0)).toBe(true);
    vi.useRealTimers();
  });
});

// Item 681: the line after a reply is one switch, the whole row the button.
describe("the keep-warm row is a toggle (item 681)", () => {
  it("on: keeping, its end, and a click switches it off", () => {
    const row = noticeRow(status(), T0)!;
    expect(row).toEqual({ on: true, text: "Keeping warm until ~11:30 PM" });
    expect(rowToggle(row)).toBe("off");
    expect(noticeRow(status({ mode: "once" }), T0)!.text).toBe("Keeping warm until ~11:30 PM or your next message");
  });

  it("off by his switch while the cache is still warm: stays, says so, and a click switches it back on", () => {
    // What the backend reports after a switch-off: nothing scheduled, the reply's own hour left.
    const off = status({ mode: "off", chosen: true, scheduled: false, next_ping_ms: null, why: "off", warm_until_ms: T0 + 40 * MIN });
    const row = noticeRow(off, T0)!;
    expect(row.on).toBe(false);
    expect(row.text).toBe("Not keeping warm — warm until ~5:40 PM; click to keep it");
    expect(rowToggle(row)).toBe("on");
    // Back on, the row reads on again; toggled twice is where it began.
    expect(rowToggle(noticeRow(status(), T0)!)).toBe("off");
  });

  it("is gone with nothing to keep: no status, the cache cold, or on but not running", () => {
    expect(noticeRow(null, T0)).toBeNull();
    expect(noticeRow(status({ mode: "off", scheduled: false, warm_until_ms: T0 - 1 }), T0)).toBeNull();
    expect(noticeRow(status({ mode: "off", scheduled: false, warm_until_ms: null }), T0)).toBeNull();
    expect(noticeRow(status({ scheduled: false, why: "cap" }), T0)).toBeNull();
  });

  it("is one button with role switch, the switch first, keyboard by the button itself", () => {
    const markup = noticeSrc.slice(noticeSrc.indexOf("{#if row}"), noticeSrc.indexOf("{/if}"));
    expect(markup).toMatch(/^\{#if row\}\s*<button\s+type="button"/);
    expect(markup).toContain('role="switch"');
    expect(markup).toContain("aria-checked={on}");
    expect(markup).toContain("onclick={() => void flip()}");
    expect(markup.indexOf("kw-switch")).toBeLessThan(markup.indexOf("kw-line"));
    expect((markup.match(/<button/g) ?? []).length).toBe(1);
    expect(noticeSrc).toContain("const mode = rowToggle(row);");
    expect(noticeSrc).toContain("await setKeepWarm(chat, mode)");
    // Motion only without Reduce motion.
    expect(noticeSrc).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.kw-knob \{\s*transition/);
  });
});
