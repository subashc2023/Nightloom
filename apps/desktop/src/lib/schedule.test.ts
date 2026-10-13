import { beforeEach, describe, expect, it } from "vitest";
import {
  RESET_MARGIN_MS,
  RETRY_EVERY_MS,
  RETRY_FOR_MS,
  atTime,
  deliverTo,
  dueAt,
  isLimited,
  readScheduled,
  tickOne,
  writeScheduled,
  type DeliverEnv,
  type Delivery,
  type Scheduled,
  type TickDeps,
} from "./schedule";
import {
  cancelScheduled,
  keepScheduled,
  reloadScheduled,
  runScheduleTick,
  scheduleSend,
  scheduled,
  scheduledFor,
  sendScheduledNow,
} from "./scheduled.svelte";
import { drafts, readDraft, setDraftText } from "./drafts.svelte";

const RESET = Date.parse("2026-09-26T14:00:00Z");

function entry(over: Partial<Scheduled> = {}): Scheduled {
  return {
    key: "chat-1",
    text: "write the summary",
    kind: "five_hour",
    at: RESET,
    state: "waiting",
    firstTryAt: null,
    nextTryAt: null,
    note: null,
    persist: true,
    ...over,
  };
}

/** A fake clock and app: `limited` and `deliver` answer from flags. */
function fake(start: number) {
  const f = {
    t: start,
    limited: false,
    sent: [] as string[],
    deliverAnswer: { ok: true } as Delivery,
    limitChecks: 0,
  };
  const deps: TickDeps = {
    now: () => f.t,
    limited: async () => {
      f.limitChecks++;
      return f.limited;
    },
    deliver: async (s) => {
      if (f.deliverAnswer.ok) f.sent.push(s.text);
      return f.deliverAnswer;
    },
  };
  return { f, deps };
}

describe("scheduled send — the clock (backlog 224)", () => {
  it("fires at the reset plus 60 s, not before", async () => {
    const { f, deps } = fake(RESET);
    const s = entry();
    expect(dueAt(s)).toBe(RESET + RESET_MARGIN_MS);
    expect(await tickOne(s, deps)).toBe("kept");
    f.t = RESET + RESET_MARGIN_MS - 1;
    expect(await tickOne(s, deps)).toBe("kept");
    expect(f.sent).toEqual([]);
    f.t = RESET + RESET_MARGIN_MS;
    expect(await tickOne(s, deps)).toBe("sent");
    expect(f.sent).toEqual(["write the summary"]);
  });

  it("a set time fires at the time itself", async () => {
    const { f, deps } = fake(RESET - 1);
    const s = entry({ kind: "time" });
    expect(await tickOne(s, deps)).toBe("kept");
    f.t = RESET;
    expect(await tickOne(s, deps)).toBe("sent");
  });

  it("fires on the first check after a sleep past the time", async () => {
    const { f, deps } = fake(RESET + 3 * 60 * 60_000);
    expect(await tickOne(entry(), deps)).toBe("sent");
    expect(f.sent).toHaveLength(1);
  });

  it("retries once a minute while still limited and stops after ten minutes", async () => {
    const due = RESET + RESET_MARGIN_MS;
    const { f, deps } = fake(due);
    f.limited = true;
    const s = entry();
    expect(await tickOne(s, deps)).toBe("kept");
    expect(s.state).toBe("retrying");
    expect(s.nextTryAt).toBe(due + RETRY_EVERY_MS);
    // A check inside the minute does not even read the usage.
    f.t = due + 30_000;
    await tickOne(s, deps);
    expect(f.limitChecks).toBe(1);
    // Every 15 s for twenty minutes, as the app's clock would.
    for (f.t = due; f.t <= due + 20 * 60_000; f.t += 15_000) await tickOne(s, deps);
    expect(s.state).toBe("limited");
    expect(s.note).toBe("not sent — still limited");
    expect(f.sent).toEqual([]);
    // Eleven reads of the usage at most: the first and ten retries. Never a loop.
    expect(f.limitChecks).toBe(1 + RETRY_FOR_MS / RETRY_EVERY_MS);
    // And it stays stopped.
    f.limited = false;
    f.t += 60 * 60_000;
    expect(await tickOne(s, deps)).toBe("kept");
    expect(f.sent).toEqual([]);
  });

  it("sends on a retry once the limit lifts", async () => {
    const due = RESET + RESET_MARGIN_MS;
    const { f, deps } = fake(due);
    f.limited = true;
    const s = entry();
    await tickOne(s, deps);
    f.limited = false;
    f.t = due + RETRY_EVERY_MS;
    expect(await tickOne(s, deps)).toBe("sent");
  });

  it("a delivery that must wait says why and tries again a minute later", async () => {
    const { f, deps } = fake(RESET + RESET_MARGIN_MS);
    f.deliverAnswer = { ok: false, why: "waiting — another chat is running a turn" };
    const s = entry();
    expect(await tickOne(s, deps)).toBe("kept");
    expect(s.note).toBe("waiting — another chat is running a turn");
    expect(s.nextTryAt).toBe(f.t + RETRY_EVERY_MS);
    f.deliverAnswer = { ok: true };
    f.t += RETRY_EVERY_MS;
    expect(await tickOne(s, deps)).toBe("sent");
  });
});

describe("scheduled send — still limited means a reset still ahead", () => {
  const now = RESET + RESET_MARGIN_MS;
  it("a pre-reset reading at 100 % with its reset now past is not limited", () => {
    expect(
      isLimited(
        { five_hour: 100, seven_day: 40, five_hour_resets_at: new Date(RESET).toISOString(), seven_day_resets_at: null },
        now,
      ),
    ).toBe(false);
  });
  it("100 % with the reset ahead is limited; so is the weekly window", () => {
    const ahead = new Date(now + 3600_000).toISOString();
    expect(isLimited({ five_hour: 100, seven_day: 10, five_hour_resets_at: ahead, seven_day_resets_at: null }, now)).toBe(true);
    expect(isLimited({ five_hour: 5, seven_day: 100, five_hour_resets_at: null, seven_day_resets_at: ahead }, now)).toBe(true);
    expect(isLimited({ five_hour: 99, seven_day: 10, five_hour_resets_at: ahead, seven_day_resets_at: ahead }, now)).toBe(false);
    expect(isLimited(null, now)).toBe(false);
  });
});

describe("scheduled send — the typed time", () => {
  it("is today when still ahead, tomorrow when passed", () => {
    const now = new Date(2026, 8, 26, 13, 30).getTime();
    const later = atTime("14:05", now)!;
    expect(later.tomorrow).toBe(false);
    expect(new Date(later.at).getHours()).toBe(14);
    const passed = atTime("09:00", now)!;
    expect(passed.tomorrow).toBe(true);
    expect(new Date(passed.at).getDate()).toBe(27);
    expect(atTime("25:00", now)).toBeNull();
    expect(atTime("", now)).toBeNull();
  });
});

describe("scheduled send — delivery into the chat", () => {
  function env(over: Partial<{ connected: boolean; active: string | null; busy: boolean; opens: boolean }> = {}) {
    const st = { connected: true, active: "chat-1" as string | null, busy: false, opens: true, ...over };
    const log: string[] = [];
    const e: DeliverEnv = {
      connected: () => st.connected,
      activeKey: () => st.active,
      busy: () => st.busy,
      open: async (k) => {
        log.push(`open ${k}`);
        if (st.opens) st.active = k;
      },
      enqueue: (k, t) => void log.push(`queue ${k}: ${t}`),
      drain: async () => void log.push("drain"),
    };
    return { st, log, e };
  }

  it("a busy chat queues it behind the running turn and does not drain", async () => {
    const { log, e } = env({ busy: true });
    expect(await deliverTo(entry(), e)).toEqual({ ok: true });
    expect(log).toEqual(["queue chat-1: write the summary"]);
  });

  it("an idle open chat queues and drains at once", async () => {
    const { log, e } = env();
    expect(await deliverTo(entry(), e)).toEqual({ ok: true });
    expect(log).toEqual(["queue chat-1: write the summary", "drain"]);
  });

  it("opens its chat when nothing runs; waits when another chat's turn runs", async () => {
    const idle = env({ active: "chat-2" });
    expect(await deliverTo(entry(), idle.e)).toEqual({ ok: true });
    expect(idle.log[0]).toBe("open chat-1");
    const busy = env({ active: "chat-2", busy: true });
    const r = await deliverTo(entry(), busy.e);
    expect(r.ok).toBe(false);
    expect(busy.log).toEqual([]);
  });

  it("waits with no engine connected", async () => {
    const { log, e } = env({ connected: false });
    expect((await deliverTo(entry(), e)).ok).toBe(false);
    expect(log).toEqual([]);
  });
});

describe("scheduled send — the store (blockers 466, 468)", () => {
  beforeEach(() => {
    reloadScheduled(null, 0);
    for (const k of Object.keys(drafts)) delete drafts[k];
  });

  it("round-trips, and a relaunch after the time asks rather than sends", () => {
    const raw = writeScheduled({ "chat-1": entry() });
    const before = readScheduled(raw, RESET);
    expect(before["chat-1"]!.state).toBe("waiting");
    expect(before["chat-1"]!.text).toBe("write the summary");
    const after = readScheduled(raw, RESET + RESET_MARGIN_MS + 1);
    expect(after["chat-1"]!.state).toBe("missed");
  });

  it("an incognito chat's entry is never written", () => {
    expect(JSON.parse(writeScheduled({ a: entry({ key: "a", persist: false }) }))).toEqual({});
  });

  it("a malformed store costs the bad entry only", () => {
    const raw = JSON.stringify({ a: { text: "", at: 1 }, b: "x", c: { text: "keep me", at: RESET, kind: "time" } });
    expect(Object.keys(readScheduled(raw, 0))).toEqual(["c"]);
    expect(readScheduled("{not json", 0)).toEqual({});
  });

  it("one per chat; Cancel puts the words back in front of anything typed since", () => {
    expect(scheduleSend("chat-1", "first words", "time", RESET, true)).toBe(true);
    expect(scheduleSend("chat-1", "second", "time", RESET, true)).toBe(false);
    setDraftText("chat-1", "typed since");
    expect(cancelScheduled("chat-1")).toBe("first words");
    expect(scheduledFor("chat-1")).toBeNull();
    expect(readDraft("chat-1").text).toBe("first words\ntyped since");
  });

  it("the text survives a relaunch and comes back on Cancel", () => {
    scheduleSend("chat-1", "persisted words", "five_hour", RESET, true);
    const raw = writeScheduled(scheduled);
    reloadScheduled(raw, RESET + 1);
    expect(scheduledFor("chat-1")!.text).toBe("persisted words");
    cancelScheduled("chat-1");
    expect(readDraft("chat-1").text).toBe("persisted words");
  });

  it("a missed one is not sent by a tick; Keep holds it; Send now sends it", async () => {
    scheduleSend("chat-1", "late words", "time", RESET, true);
    reloadScheduled(writeScheduled(scheduled), RESET + 3600_000);
    const { f, deps } = fake(RESET + 3600_000);
    await runScheduleTick(deps);
    expect(f.sent).toEqual([]);
    expect(scheduledFor("chat-1")!.state).toBe("missed");
    keepScheduled("chat-1");
    await runScheduleTick(deps);
    expect(scheduledFor("chat-1")!.state).toBe("held");
    expect(f.sent).toEqual([]);
    await sendScheduledNow("chat-1", deps);
    expect(f.sent).toEqual(["late words"]);
    expect(scheduledFor("chat-1")).toBeNull();
  });

  it("a tick sends a due entry and drops it only once sent", async () => {
    scheduleSend("chat-1", "due words", "five_hour", RESET, true);
    const { f, deps } = fake(RESET + RESET_MARGIN_MS);
    f.deliverAnswer = { ok: false, why: "waiting — no engine is connected" };
    await runScheduleTick(deps);
    expect(scheduledFor("chat-1")!.note).toBe("waiting — no engine is connected");
    f.deliverAnswer = { ok: true };
    f.t += RETRY_EVERY_MS;
    await runScheduleTick(deps);
    expect(f.sent).toEqual(["due words"]);
    expect(scheduledFor("chat-1")).toBeNull();
  });
});
