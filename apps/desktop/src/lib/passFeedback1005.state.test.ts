/*
 * Items 1005 + 1007 (verify sweep 2): every memory pass says it started, shows it is working, and says what
 * it saved, saved nothing, or failed — in the toast corner, the one place every surface shares. Driven
 * through the real state functions against a stubbed backend whose capture and dream wait until the test
 * lets them end, so the toast is read while the pass runs and again after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { DREAM_ENGINE, app, runCapture, runDailyPass, runDream, saveMemoryFromChat } from "./state.svelte";
import { maybeAutoDream } from "./state/passes.svelte";
import { runBatch2, type BoxActions } from "./appCommands967";
import { APP_COMMANDS } from "./appCommands";
import type { CaptureReport, PlanUsage } from "./types";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  planUsage: vi.fn(),
  planUsageRefresh: vi.fn(),
  captureStatus: vi.fn(async () => 2),
  dreamStatus: vi.fn(async () => 0),
  capture: vi.fn(),
  cancelCapture: vi.fn(async () => {}),
  dream: vi.fn(),
  outsideSync: vi.fn(async () => {}),
  macIdleMs: vi.fn(async () => 60 * 60_000),
  devScratchHome: vi.fn(async () => false),
  tidyMemory: vi.fn(async () => []),
  tidyThreads: vi.fn(async () => []),
  listNotes: vi.fn(async () => []),
  centreProposals: vi.fn(async () => []),
  centreDreamCommits: vi.fn(async () => []),
  centreApplied: vi.fn(async () => []),
  centreClaudeMemory: vi.fn(async () => []),
  flatCanary: vi.fn(async () => []),
  nightshiftProjects: vi.fn(async () => []),
  buildStamp: vi.fn(async () => null),
  notify: vi.fn(async () => {}),
}));

const capture = vi.mocked(api.capture);
const dream = vi.mocked(api.dream);
const dreamStatus = vi.mocked(api.dreamStatus);

function report(observations: number, over: Partial<CaptureReport> = {}): CaptureReport {
  return {
    observations,
    logs_read: 1,
    skipped: 0,
    refused: 0,
    deferred: 0,
    remaining: 0,
    incognito: 0,
    per_project: observations ? [{ project: "STATS 67", observations }] : [],
    interrupted: false,
    cost_usd: null,
    ...over,
  };
}

/** A backend call that ends when the test says. */
function held<T>(): { promise: Promise<T>; end: (v: T) => void; fail: (e: unknown) => void } {
  let end!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    end = res;
    fail = rej;
  });
  return { promise, end, fail };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function usage(): PlanUsage {
  return {
    five_hour: 10,
    seven_day: 10,
    sampled_at_ms: Date.now(),
    age_seconds: 0,
    stale: false,
    five_hour_resets_at: null,
    seven_day_resets_at: null,
    source: "turn",
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  capture.mockReset();
  dream.mockReset();
  dreamStatus.mockReset();
  dreamStatus.mockResolvedValue(0);
  app.toasts = [];
  app.capturing = false;
  app.dreaming = false;
  app.centre.dailyRunning = false;
  app.capturePending = 0;
  app.dreamPending = 0;
  app.planUsage = usage();
  app.dreamPrefs = { auto: true, provider: DREAM_ENGINE, model: "haiku", limitFiveHour: 50, limitWeek: 80, backfill: false, backfillCap: 30 };
});
afterEach(() => vi.useRealTimers());

/** The box actions /remember needs; the rest are never reached. */
function box(aside: boolean): BoxActions {
  const part: Partial<BoxActions> = {
    aside,
    toast: (m: string) => void app.toasts.push({ id: 9999, text: m }),
    clear: () => {},
    engine: () => "claude-code",
    busy: () => false,
    sessionId: () => "chat-1",
    lastLiveUser: () => -1,
    capturing: () => app.capturing,
    saveMemory: (id: string) => saveMemoryFromChat(id),
  };
  return part as BoxActions;
}
const REMEMBER = { cmd: APP_COMMANDS.find((c) => c.name === "remember")!, arg: "" };

describe("1005: /remember says it started, runs with a clock and Stop, and ends on its result", () => {
  for (const aside of [false, true]) {
    it(`${aside ? "in an aside's box" : "in the main box"}: nothing found reads as nothing new, and stays until closed`, async () => {
      const call = held<CaptureReport>();
      capture.mockReturnValue(call.promise);
      const run = runBatch2(REMEMBER, box(aside));
      await flush();
      // Was: no toast at all while it ran (~2.5 min in the sweep).
      expect(app.toasts).toHaveLength(1);
      const t = app.toasts[0];
      expect(t.text).toBe("saving memory from this chat — reading it on Haiku for what is worth keeping");
      expect(typeof t.since).toBe("number");
      expect(t.action?.label).toBe("Stop");
      // Still there minutes later: a running toast has no timer.
      vi.advanceTimersByTime(150_000);
      expect(app.toasts.map((x) => x.id)).toEqual([t.id]);
      call.end(report(0));
      await run;
      // Was: "saved 0 observations from this chat" for 8 s, gone before he looked.
      expect(app.toasts).toHaveLength(1);
      expect(app.toasts[0].id).toBe(t.id);
      expect(app.toasts[0].text).toBe("nothing new to keep from this chat — saved 0 observations");
      expect(app.toasts[0].since).toBeUndefined();
      vi.advanceTimersByTime(10 * 60_000);
      expect(app.toasts).toHaveLength(1);
    });
  }

  it("found something: how many, and Dream offered, in the same place", async () => {
    const call = held<CaptureReport>();
    capture.mockReturnValue(call.promise);
    const run = saveMemoryFromChat("chat-1");
    await flush();
    const id = app.toasts[0].id;
    call.end(report(3));
    await run;
    expect(app.toasts).toHaveLength(1);
    expect(app.toasts[0].id).toBe(id);
    expect(app.toasts[0].text).toBe("saved 3 observations from this chat — Dream files them into memory");
    expect(app.toasts[0].action?.label).toBe("Dream");
  });

  it("a cut-off turn (item 1002's error) is the result, and stays", async () => {
    const call = held<CaptureReport>();
    capture.mockReturnValue(call.promise);
    const run = saveMemoryFromChat("chat-1");
    await flush();
    call.fail("the capture's Claude Code turn was cut off before its reply ended — nothing was saved");
    await run;
    expect(app.toasts).toHaveLength(1);
    expect(app.toasts[0].text).toBe("save memory failed: the capture's Claude Code turn was cut off before its reply ended — nothing was saved");
    vi.advanceTimersByTime(10 * 60_000);
    expect(app.toasts).toHaveLength(1);
  });

  it("Stop on the running toast cancels the capture; the interrupted result still shows", async () => {
    const call = held<CaptureReport>();
    capture.mockReturnValue(call.promise);
    const run = saveMemoryFromChat("chat-1");
    await flush();
    app.toasts[0].action!.run();
    expect(api.cancelCapture).toHaveBeenCalled();
    call.end(report(0, { interrupted: true }));
    await run;
    expect(app.toasts.at(-1)!.text).toBe("save interrupted — saved 0 observations from this chat");
  });
});

describe("1005's class: the Capture and Dream buttons, the daily pass, the automatic pass", () => {
  it("Capture: started with its count and model, then the result in place", async () => {
    app.capturePending = 2;
    const call = held<CaptureReport>();
    capture.mockReturnValue(call.promise);
    const run = runCapture();
    await flush();
    expect(app.toasts[0].text).toBe("capture: reading 2 chats into the memory inbox on Haiku");
    call.end(report(4, { logs_read: 2 }));
    await run;
    expect(app.toasts).toHaveLength(1);
    expect(app.toasts[0].text).toMatch(/^capture: captured 4 observations from 1 chat|^capture: captured 4 observations from 2 chats/);
    expect(app.toasts[0].since).toBeUndefined();
  });

  it("Dream: started, then the result in place", async () => {
    app.dreamPending = 5;
    const call = held<Awaited<ReturnType<typeof api.dream>>>();
    dream.mockReturnValue(call.promise);
    const run = runDream();
    await flush();
    expect(app.toasts[0].text).toBe("dream: sorting 5 observations into memory on Haiku");
    call.end({ consolidated: 5, remaining: 0, filed: [], git: "committed", proposed: null, refused: 0, interrupted: false, cost_usd: null } as never);
    await run;
    expect(app.toasts).toHaveLength(1);
    expect(app.toasts[0].text).toContain("dream: consolidated 5 observations");
  });

  it("Run now: one toast names each step, then holds the day's summary", async () => {
    vi.mocked(api.captureStatus).mockResolvedValue(1);
    const call = held<CaptureReport>();
    capture.mockReturnValue(call.promise);
    const run = runDailyPass();
    await flush();
    const running = app.toasts.filter((t) => t.since !== undefined);
    expect(running).toHaveLength(1);
    expect(running[0].text).toBe("daily memory pass — capturing");
    call.end(report(1));
    await run;
    const day = app.toasts.find((t) => t.id === running[0].id)!;
    expect(day.text).toMatch(/^daily pass: captured 1 observation from 1 chat, nothing to dream, /);
    // One toast for the pass: the capture's own result folds into its line.
    expect(app.toasts).toHaveLength(1);
  });

  it("a hand-off's automatic pass says so at once, names its step, and ends on what it did (item 1007)", async () => {
    vi.mocked(api.captureStatus).mockResolvedValue(1);
    const call = held<CaptureReport>();
    capture.mockReturnValue(call.promise);
    const run = maybeAutoDream("hand-off");
    await flush();
    // Was: a capture with no word anywhere but the Running list.
    expect(app.toasts.map((t) => t.text)).toEqual(["saving memory from the chat you handed off — capturing"]);
    expect(app.toasts[0].text).toBe("saving memory from the chat you handed off — capturing");
    expect(app.toasts[0].action?.label).toBe("Stop");
    call.end(report(0));
    await run;
    expect(app.toasts).toHaveLength(1);
    expect(app.toasts[0].text).toBe("memory from the chat you handed off: nothing new to keep");
  });
});
