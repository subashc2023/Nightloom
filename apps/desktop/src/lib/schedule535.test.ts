import { beforeEach, describe, expect, it } from "vitest";
import {
  RESET_MARGIN_MS,
  TICK_MS,
  deliverTo,
  dueAt,
  nextCheckAt,
  readScheduled,
  scheduleHead,
  tickOne,
  writeScheduled,
  type ChatProject,
  type Delivery,
  type TickDeps,
} from "./schedule";
import {
  cancelScheduled,
  flushScheduled,
  reloadScheduled,
  restoreScheduled,
  runScheduleTick,
  scheduleSend,
  scheduled,
  scheduledFor,
  sendScheduledNow,
} from "./scheduled.svelte";
import { drafts, readDraft } from "./drafts.svelte";

// Item 535 (his three reports, 2026-11-09): Send later went an hour late,
// into the wrong project's chat, stuck on "could not be opened", and Send
// now sent one message twice. The pure half and the store: every member
// of the class, on a fake clock. The app's half is schedule535.state.test.ts.

const AT = Date.parse("2026-11-09T20:30:00-08:00"); // the 5-hour reset: due 8:31 PM
const DUE = AT + RESET_MARGIN_MS;
const COLLEGE: ChatProject = { id: "02c461cd", name: "College, Transfer Apps, Career" };
const VALUE: ChatProject = { id: "6dfef49a", name: "Value generalization" };
const CHAT = "4f207906-07fc-48af-870f-55f86ffa0cb7";

/** A fake app: which project is open, where chats live, what was started. */
function world(start: number) {
  const w = {
    t: start,
    limited: false,
    open: COLLEGE as ChatProject,
    homes: { [CHAT]: COLLEGE } as Record<string, ChatProject | null>,
    /** Why the chat cannot take a send; null when it can. */
    refuse: null as string | null,
    running: new Set<string>(),
    started: [] as { key: string; project: string | null | undefined; text: string }[],
    queued: [] as string[],
    armed: [] as (number | null)[],
    homeCalls: 0,
    /** Hold `ready` open until released (a delivery in flight). */
    gate: null as Promise<void> | null,
    /** Hold `limited` open until released. */
    limitGate: null as Promise<void> | null,
  };
  const deps: TickDeps = {
    now: () => w.t,
    limited: async () => {
      if (w.limitGate) await w.limitGate;
      return w.limited;
    },
    deliver: (s) =>
      deliverTo(s, {
        running: (k) => w.running.has(k),
        enqueue: (k, text) => void w.queued.push(`${k}: ${text}`),
        ready: async (e): Promise<Delivery> => {
          if (w.gate) await w.gate;
          return w.refuse ? { ok: false, why: `waiting — ${w.refuse}` } : e.project ? { ok: true } : { ok: false, why: "waiting — no project" };
        },
        start: (e) => void w.started.push({ key: e.key, project: e.project?.id, text: e.text }),
      }),
    home: async (k) => {
      w.homeCalls++;
      return w.homes[k] ?? null;
    },
    arm: (at) => void w.armed.push(at),
  };
  return { w, deps };
}

/** Let pending microtasks run (a tick reaches its next await). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

beforeEach(() => {
  reloadScheduled(null, 0);
  for (const k of Object.keys(drafts)) delete drafts[k];
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});

describe("535 — an entry carries its project, and goes into that project's chat", () => {
  it("the project is stored with the message and survives the store", () => {
    scheduleSend(CHAT, "Alright, next", "five_hour", AT, true, [], COLLEGE);
    const back = readScheduled(writeScheduled(scheduled), AT - 1000);
    expect(back[CHAT]!.project).toEqual(COLLEGE);
  });

  it("with another project open it is started in its own chat and project; nothing is opened or queued elsewhere", async () => {
    const { w, deps } = world(DUE);
    w.open = VALUE; // he is looking at another project
    scheduleSend(CHAT, "Alright, next", "five_hour", AT, true, [], COLLEGE);
    await runScheduleTick(deps);
    expect(w.started).toEqual([{ key: CHAT, project: COLLEGE.id, text: "Alright, next" }]);
    expect(w.queued).toEqual([]);
    expect(scheduledFor(CHAT)).toBeNull();
  });

  it("an entry made before 535 (no project) finds its own from the chat's log, once, and keeps it", async () => {
    const { w, deps } = world(AT - 60_000);
    reloadScheduled(JSON.stringify({ [CHAT]: { text: "old build", kind: "five_hour", at: AT, state: "waiting", note: null } }), w.t);
    expect(scheduledFor(CHAT)!.project).toBeUndefined();
    await runScheduleTick(deps);
    expect(scheduledFor(CHAT)!.project).toEqual(COLLEGE);
    await runScheduleTick(deps);
    expect(w.homeCalls).toBe(1);
    expect(readScheduled(writeScheduled(scheduled), w.t)[CHAT]!.project).toEqual(COLLEGE);
  });

  it("a chat no project has says so in its row and keeps its words", async () => {
    const { w, deps } = world(DUE);
    w.homes[CHAT] = null;
    reloadScheduled(JSON.stringify({ [CHAT]: { text: "orphan", kind: "time", at: DUE + 5000, state: "waiting", note: null } }), w.t);
    w.t = DUE + 6000;
    await runScheduleTick(deps);
    expect(w.started).toEqual([]);
    expect(scheduledFor(CHAT)!.text).toBe("orphan");
    expect(scheduledFor(CHAT)!.note).toMatch(/^waiting — /);
  });
});

describe("535 — a failed delivery names its cause, retries at every tick, and never sticks", () => {
  it("retries at the next tick, not sooner, and goes the moment the cause clears", async () => {
    const { w, deps } = world(DUE);
    w.refuse = "open the project “College, Transfer Apps, Career” and it sends by itself";
    scheduleSend(CHAT, "Alright, next", "five_hour", AT, true, [], COLLEGE);
    await runScheduleTick(deps);
    const s = scheduledFor(CHAT)!;
    expect(s.note).toBe("waiting — open the project “College, Transfer Apps, Career” and it sends by itself");
    expect(s.nextTryAt).toBe(DUE + TICK_MS);
    expect(w.armed.at(-1)).toBe(DUE + TICK_MS); // the backend's clock is told
    w.t = DUE + TICK_MS - 1;
    await runScheduleTick(deps);
    expect(w.started).toEqual([]);
    // Twenty failed ticks later it is still trying.
    for (let i = 1; i <= 20; i++) {
      w.t = DUE + i * TICK_MS;
      await runScheduleTick(deps);
    }
    expect(scheduledFor(CHAT)!.state).toBe("waiting");
    w.refuse = null; // he opened the project
    w.t += TICK_MS;
    await runScheduleTick(deps);
    expect(w.started.length).toBe(1);
    expect(scheduledFor(CHAT)).toBeNull();
    expect(w.armed.at(-1)).toBeNull();
  });

  it("a delivery that throws is a reason in the row, not an error thrown at whoever ticked", async () => {
    const { w, deps } = world(DUE);
    scheduleSend(CHAT, "x", "five_hour", AT, true, [], COLLEGE);
    const bad: TickDeps = {
      ...deps,
      deliver: async () => {
        throw new Error("no session matching 4f207906 in …/projects/6dfef49a/sessions");
      },
    };
    await expect(runScheduleTick(bad)).resolves.toBeUndefined();
    expect(scheduledFor(CHAT)!.note).toMatch(/^waiting — .*no session matching/);
    expect(scheduledFor(CHAT)!.nextTryAt).toBe(w.t + TICK_MS);
  });

  it("refused by its chat after the hand-off: back as a waiting message with the reason", () => {
    scheduleSend(CHAT, "Alright, next", "five_hour", AT, true, [], COLLEGE);
    const copy = { ...scheduledFor(CHAT)! };
    delete scheduled[CHAT];
    expect(restoreScheduled(copy, "waiting — that chat is not loaded now", DUE)).toBe(true);
    const s = scheduledFor(CHAT)!;
    expect([s.state, s.note, s.nextTryAt, s.text, s.project]).toEqual([
      "waiting",
      "waiting — that chat is not loaded now",
      DUE + TICK_MS,
      "Alright, next",
      COLLEGE,
    ]);
    // The chat has another scheduled message by now: the caller keeps the words another way.
    expect(restoreScheduled(copy, "x", DUE)).toBe(false);
  });
});

describe("535 — exactly once", () => {
  it("two ticks racing send one message", async () => {
    const { w, deps } = world(DUE);
    scheduleSend(CHAT, "once", "five_hour", AT, true, [], COLLEGE);
    const g = gate();
    w.gate = g.wait;
    const a = runScheduleTick(deps);
    const b = runScheduleTick(deps); // the visibilitychange tick, the wake-due tick…
    const c = tickOne(scheduledFor(CHAT)!, deps); // even one that got past the tick guard
    g.open();
    await Promise.all([a, b, c]);
    expect(w.started.map((s) => s.text)).toEqual(["once"]);
  });

  it("Send now while a tick is delivering it: left to the tick, sent once", async () => {
    const { w, deps } = world(DUE);
    scheduleSend(CHAT, "once", "five_hour", AT, true, [], COLLEGE);
    const g = gate();
    w.limitGate = g.wait; // the tick is at its limit check
    const ticking = runScheduleTick(deps);
    await settle();
    expect(scheduledFor(CHAT)!.claimed).toBe(true);
    expect(scheduleHead(scheduledFor(CHAT)!, () => "8:31 PM")).toBe("scheduled · 8:31 PM · sending…");
    expect(await sendScheduledNow(CHAT, deps)).toBeNull();
    g.open();
    await ticking;
    expect(w.started.length).toBe(1);
    expect(scheduledFor(CHAT)).toBeNull();
  });

  it("a tick while Send now is delivering it: skipped, sent once", async () => {
    const { w, deps } = world(DUE);
    scheduleSend(CHAT, "once", "five_hour", AT, true, [], COLLEGE);
    const g = gate();
    w.gate = g.wait;
    const now = sendScheduledNow(CHAT, deps);
    await runScheduleTick(deps);
    await runScheduleTick(deps);
    expect(w.started).toEqual([]);
    g.open();
    expect(await now).toEqual({ ok: true });
    await runScheduleTick(deps);
    expect(w.started.length).toBe(1);
  });

  it("Send now pressed twice sends once", async () => {
    const { w, deps } = world(AT - 60_000);
    scheduleSend(CHAT, "once", "five_hour", AT, true, [], COLLEGE);
    const g = gate();
    w.gate = g.wait;
    const first = sendScheduledNow(CHAT, deps);
    const second = sendScheduledNow(CHAT, deps);
    g.open();
    expect(await second).toBeNull();
    expect(await first).toEqual({ ok: true });
    expect(w.started.length).toBe(1);
  });

  it("Cancel while a delivery is in flight: nothing is sent, the words are back in the box", async () => {
    const { w, deps } = world(DUE);
    scheduleSend(CHAT, "take me back", "five_hour", AT, true, [], COLLEGE);
    const g = gate();
    w.gate = g.wait;
    const ticking = runScheduleTick(deps);
    await settle();
    expect(cancelScheduled(CHAT)).toBe("take me back");
    g.open();
    await ticking;
    expect(w.started).toEqual([]);
    expect(readDraft(CHAT).text).toBe("take me back");
    expect(scheduledFor(CHAT)).toBeNull();
  });

  it("a sent message is out of the store at once, not on a debounce", async () => {
    const { deps } = world(DUE);
    scheduleSend(CHAT, "once", "five_hour", AT, true, [], COLLEGE);
    flushScheduled();
    expect(localStorage.getItem("nightloom.scheduled")).toContain("once");
    await runScheduleTick(deps);
    expect(localStorage.getItem("nightloom.scheduled")).toBe("{}");
  });

  it("a tick that never returns does not stop the clock for good", async () => {
    const { w, deps } = world(DUE);
    scheduleSend(CHAT, "hung", "five_hour", AT, true, [], COLLEGE);
    scheduleSend("other", "goes", "time", DUE + 30_000, true, [], COLLEGE);
    w.gate = new Promise<void>(() => {}); // never
    void runScheduleTick(deps);
    await settle();
    w.gate = null;
    w.t = DUE + 60_000;
    await runScheduleTick(deps); // within two minutes: still one tick
    expect(w.started).toEqual([]);
    w.t = DUE + 121_000;
    await runScheduleTick(deps);
    expect(w.started.map((s) => s.text)).toEqual(["goes"]); // the hung one stays claimed: never twice
  });
});

describe("535 — the backend's clock is told when the next check is", () => {
  it("armed at the due time on a pick, re-armed on change, cleared when nothing waits", async () => {
    const { w, deps } = world(AT - 3600_000);
    await runScheduleTick(deps); // the app's hooks are in
    scheduleSend(CHAT, "a", "five_hour", AT, true, [], COLLEGE);
    expect(nextCheckAt(scheduled)).toBe(DUE);
    scheduleSend("b", "b", "time", AT - 1000, true, [], COLLEGE);
    expect(nextCheckAt(scheduled)).toBe(AT - 1000);
    await runScheduleTick(deps);
    expect(w.armed.at(-1)).toBe(AT - 1000);
    w.t = AT;
    await runScheduleTick(deps);
    expect(w.armed.at(-1)).toBe(DUE);
    w.t = DUE;
    await runScheduleTick(deps);
    expect(w.armed.at(-1)).toBeNull();
  });

  it("held, missed and limited entries arm nothing: they wait for him", () => {
    const base = { key: "k", text: "x", kind: "time" as const, at: 5, firstTryAt: null, nextTryAt: null, note: null, persist: true };
    expect(nextCheckAt({ a: { ...base, state: "held" }, b: { ...base, state: "missed" }, c: { ...base, state: "limited" } })).toBeNull();
    expect(nextCheckAt({ a: { ...base, state: "retrying", nextTryAt: 99 } })).toBe(99);
  });
});

describe("535 — the class: every way a message is scheduled, and every way its time passes", () => {
  it.each([
    ["a set time", "time" as const, 0],
    ["the 5-hour reset", "five_hour" as const, RESET_MARGIN_MS],
    ["the weekly reset", "seven_day" as const, RESET_MARGIN_MS],
  ])("%s goes at its moment, not before", async (_name, kind, margin) => {
    const { w, deps } = world(AT + margin - 1);
    scheduleSend(CHAT, "x", kind, AT, true, [], COLLEGE);
    expect(dueAt(scheduledFor(CHAT)!)).toBe(AT + margin);
    await runScheduleTick(deps);
    expect(w.started).toEqual([]);
    w.t = AT + margin;
    await runScheduleTick(deps);
    expect(w.started.length).toBe(1);
  });

  it("a Mac that slept through the time: the first tick after wake sends it", async () => {
    const { w, deps } = world(AT - 60_000);
    scheduleSend(CHAT, "x", "five_hour", AT, true, [], COLLEGE);
    await runScheduleTick(deps);
    w.t = DUE + 3 * 3600_000; // asleep for three hours
    await runScheduleTick(deps);
    expect(w.started.length).toBe(1);
  });

  it("a chat running a turn at the time: into its own queue, behind that turn", async () => {
    const { w, deps } = world(DUE);
    w.running.add(CHAT);
    scheduleSend(CHAT, "after this turn", "five_hour", AT, true, [], COLLEGE);
    await runScheduleTick(deps);
    expect(w.queued).toEqual([`${CHAT}: after this turn`]);
    expect(w.started).toEqual([]);
    expect(scheduledFor(CHAT)).toBeNull();
  });

  it("a relaunch past the time, untouched while the app was closed: asked, never sent by itself (blocker 468)", async () => {
    const { w, deps } = world(DUE + 3600_000);
    scheduleSend(CHAT, "x", "five_hour", AT, true, [], COLLEGE);
    reloadScheduled(writeScheduled(scheduled), w.t);
    expect(scheduledFor(CHAT)!.state).toBe("missed");
    await runScheduleTick(deps);
    expect(w.started).toEqual([]);
  });

  it("his stuck row — tried while the app ran, 'could not be opened', no project — goes by itself after the relaunch", async () => {
    // What the installed build (83cd52d) left in the store at 9:38 PM.
    const stuck = JSON.stringify({
      [CHAT]: {
        text: "Alright…",
        kind: "five_hour",
        at: AT,
        state: "waiting",
        note: "waiting — this chat could not be opened",
        attachments: [],
      },
    });
    const { w, deps } = world(DUE + 90 * 60_000); // relaunched an hour and a half late
    w.open = VALUE; // into another project
    reloadScheduled(stuck, w.t);
    const s = scheduledFor(CHAT)!;
    expect(s.state).toBe("waiting"); // not "missed": it was being tried
    expect(s.tried).toBe(true);
    await runScheduleTick(deps);
    expect(w.started).toEqual([{ key: CHAT, project: COLLEGE.id, text: "Alright…" }]);
    expect(scheduledFor(CHAT)).toBeNull();
  });

  it("the limit's retry in flight at a relaunch keeps going by itself too", () => {
    const raw = JSON.stringify({ [CHAT]: { text: "x", kind: "five_hour", at: AT, state: "retrying", note: "still limited — trying each minute until 8:41 PM" } });
    const back = readScheduled(raw, DUE + 5 * 60_000)[CHAT]!;
    expect(back.state).toBe("waiting");
    expect(back.tried).toBe(true);
  });

  it("the words are never lost: every path that does not send keeps the entry or gives the text back", async () => {
    const { w, deps } = world(DUE);
    w.refuse = "Claude Code is not connected";
    scheduleSend(CHAT, "precious", "five_hour", AT, true, [], COLLEGE);
    await runScheduleTick(deps);
    expect(await sendScheduledNow(CHAT, deps)).toEqual({ ok: false, why: "waiting — Claude Code is not connected" });
    expect(scheduledFor(CHAT)!.text).toBe("precious");
    reloadScheduled(writeScheduled(scheduled), w.t + 1);
    expect(scheduledFor(CHAT)!.text).toBe("precious");
    expect(cancelScheduled(CHAT)).toBe("precious");
    expect(readDraft(CHAT).text).toBe("precious");
  });
});
