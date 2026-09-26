import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_EVERY_MS,
  checkDue,
  cliNoticeDetail,
  cliNoticeId,
  cliNoticeTitle,
  coldReading,
  costLine,
  formatTokens,
  modelGap,
  offersUpdate,
  parseCliPrefs,
  resultLine,
  waitLine,
} from "./cliUpdate";
import { buildNotices } from "./centre";
// Imported here, not inside the hooks: the first import of the app's state
// transforms most of the app, and under a busy machine that alone ran past
// the 10 s hook limit (nightshift backlog 168, 2026-09-23 — 2 timeouts seen
// by another builder, 1 reproduced here with the file run alone). Module
// loading at collection is not timed; the tests then measure the flow.
import { app, refreshCentre } from "./state.svelte";
import { checkCli, cli, setAutoUpdate, tickCli, updateNow, updateWhenCold } from "./cliUpdate.svelte";
import type { CliStatus, CliUpdateResult, SessionEvent } from "./types";

// The backend as far as the update flow reaches it: the check, the update,
// the peek at a background chat's log, and the bell's four sources.
const calls: string[] = [];
let checkAnswer: CliStatus;
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  cliVersionCheck: vi.fn(async () => {
    calls.push("check");
    return checkAnswer;
  }),
  cliUpdate: vi.fn(async (): Promise<CliUpdateResult> => {
    calls.push("update");
    checkAnswer = { ...checkAnswer, installed: "2.1.280", behind: false, new_models: [] };
    return { ok: true, before: "2.1.263", after: "2.1.280", output: "Successfully updated", seconds: 31 };
  }),
  peekSession: vi.fn(async () => peeked),
  centreProposals: vi.fn(async () => []),
  centreDreamCommits: vi.fn(async () => []),
  nightshiftProjects: vi.fn(async () => []),
  buildStamp: vi.fn(async () => null),
}));
let peeked: SessionEvent[] = [];

const OPUS55 = { id: "claude-opus-5-5", name: "Opus 5.5", version: "2.1.280", has_price: true, has_window: true };
const FABLE51 = { id: "claude-fable-5-1", name: "Fable 5.1", version: "2.1.257", has_price: false, has_window: false };

function status(over: Partial<CliStatus> = {}): CliStatus {
  return {
    binary: "/Users/x/.local/bin/claude",
    installed: "2.1.263",
    latest: "2.1.280",
    channel: "latest",
    behind: true,
    new_models: [OPUS55],
    notes_read: true,
    checked_at: "2026-09-22T19:00:00Z",
    error: null,
    updates_disabled: null,
    ...over,
  };
}

describe("the notice", () => {
  it("names both versions and the new model", () => {
    expect(cliNoticeTitle(status())).toBe("Claude Code 2.1.263 → 2.1.280 · new model: Opus 5.5");
    expect(cliNoticeTitle(status({ new_models: [OPUS55, FABLE51] }))).toBe(
      "Claude Code 2.1.263 → 2.1.280 · new models: Opus 5.5, Fable 5.1",
    );
    expect(cliNoticeTitle(status({ new_models: [] }))).toBe("Claude Code 2.1.263 → 2.1.280");
    expect(cliNoticeId(status())).toBe("cli:2.1.263->2.1.280");
  });

  it("names what Nightloom's tables lack for a new model", () => {
    expect(modelGap(OPUS55, ["claude-opus-5-5"])).toBeNull();
    expect(modelGap(FABLE51, ["claude-opus-5-5"])).toBe(
      "no price or context window in Nightloom yet; not in the Anthropic model list",
    );
    expect(modelGap({ ...FABLE51, has_window: true }, ["claude-fable-5-1"])).toBe("no price in Nightloom yet");
    expect(cliNoticeDetail(status({ new_models: [OPUS55, FABLE51] }), ["claude-opus-5-5"])).toBe(
      "Opus 5.5 (claude-opus-5-5) — Nightloom's tables already know it. Fable 5.1 (claude-fable-5-1) — no price or context window in Nightloom yet; not in the Anthropic model list.",
    );
    expect(cliNoticeDetail(status({ new_models: [], notes_read: false }), [])).toBe(
      "The release notes could not be read, so no new model is named.",
    );
  });

  it("is in the bell only while an update is offered", () => {
    const base = { proposals: [], commits: [], rows: [], read: {}, stamp: null, seenStamp: null, dismissed: [] };
    const n = buildNotices({ ...base, cli: status(), curated: ["claude-opus-5-5"] });
    expect(n.map((x) => [x.kind, x.title])).toEqual([["cli", "Claude Code 2.1.263 → 2.1.280 · new model: Opus 5.5"]]);
    expect(buildNotices({ ...base, cli: status({ behind: false, installed: "2.1.280" }) })).toEqual([]);
    expect(buildNotices({ ...base, cli: status({ updates_disabled: "DISABLE_UPDATES is set" }) })).toEqual([]);
    expect(buildNotices({ ...base, cli: status(), dismissed: ["cli:2.1.263->2.1.280"] })).toEqual([]);
    expect(offersUpdate(status({ installed: null }))).toBe(false);
  });
});

describe("the cold moment", () => {
  const now = 1_000_000_000;
  it("is cold only with nothing running and no open chat warm", () => {
    const chats = [
      { session: "a", title: "Alpha", warmUntil: now + 4 * 60_000, tokens: 57_400 },
      { session: "b", title: "Beta", warmUntil: now + 90_000, tokens: 120_000 },
      { session: "c", title: "Cold", warmUntil: now - 1, tokens: 900_000 },
      { session: "d", title: "No timer", warmUntil: null, tokens: 10 },
    ];
    const r = coldReading([], chats, now);
    expect(r.cold).toBe(false);
    expect(r.warm.map((c) => c.session)).toEqual(["b", "a"]);
    expect(r.rewriteTokens).toBe(177_400);
    expect(r.coldAt).toBe(now + 4 * 60_000);
    expect(waitLine(r)).toBe("Waiting for a cold moment: 2 open chats' caches are warm — cold in 4 min.");
    expect(costLine(r)).toBe(
      "Updating now makes 2 warm chats rewrite ~177k tokens of cache on the next message (Beta ~120k, Alpha ~57k); waiting 4 min costs nothing extra.",
    );
    const cold = coldReading([], chats.slice(2), now);
    expect(cold.cold).toBe(true);
    expect(cold.rewriteTokens).toBe(0);
    expect(costLine(cold)).toBe("Every open chat's cache is already cold: updating now rewrites nothing extra.");
    const busy = coldReading(["a turn"], chats.slice(2), now);
    expect(busy.cold).toBe(false);
    expect(waitLine(busy)).toBe("Waiting: a turn is running.");
  });

  it("formats tokens and results plainly", () => {
    expect(formatTokens(57_400)).toBe("57k");
    expect(formatTokens(1_240_000)).toBe("1.2M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(812)).toBe("812");
    expect(resultLine({ ok: true, before: "2.1.263", after: "2.1.280", output: "", seconds: 31.4 })).toBe(
      "Updated Claude Code 2.1.263 → 2.1.280 (31 s).",
    );
    expect(resultLine({ ok: true, before: "2.1.263", after: "2.1.263", output: "Successfully updated", seconds: 7 })).toMatch(
      /^claude update reported success, but this CLI still answers 2\.1\.263/,
    );
    expect(resultLine({ ok: false, before: "2.1.263", after: "2.1.263", output: "Checking…\nError: EACCES", seconds: 2 })).toBe(
      "claude update did not finish (still 2.1.263): Error: EACCES",
    );
  });
});

describe("the switch and the cadence", () => {
  it("is on by default (blocker 291) and survives a broken store", () => {
    // On by default (blocker 291); only an explicit false turns it off.
    expect(parseCliPrefs(null)).toEqual({ auto: true, lastCheck: null, autoFailedFor: null });
    expect(parseCliPrefs("{bad")).toEqual({ auto: true, lastCheck: null, autoFailedFor: null });
    expect(parseCliPrefs('{"auto":false,"lastCheck":5}')).toEqual({ auto: false, lastCheck: 5, autoFailedFor: null });
    expect(parseCliPrefs('{"auto":true}').auto).toBe(true);
  });
  it("checks every six hours", () => {
    expect(checkDue(null, 0)).toBe(true);
    expect(checkDue(0, CHECK_EVERY_MS - 1)).toBe(false);
    expect(checkDue(0, CHECK_EVERY_MS)).toBe(true);
  });
});

// The flow, against the mocked backend: Update waits for a cold moment,
// never runs under a turn, and the notice clears after; the switch does the
// same by itself.
describe("the update flow", () => {
  const AT = new Date(Date.now()).toISOString();
  const warmChat: SessionEvent[] = [
    { event: "session_created", id: "w", at: AT } as SessionEvent,
    { event: "user_message", text: "hi", at: AT } as SessionEvent,
    {
      event: "assistant_message",
      at: AT,
      sent_at: AT,
      cache_ttl: "5m",
      blocks: [{ type: "text", text: "hello" }],
      usage: { input_tokens: 57_000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as SessionEvent,
  ];

  beforeEach(() => {
    calls.length = 0;
    checkAnswer = status();
    peeked = [];
    app.busy = false;
    app.activeSessionId = null;
    app.events = [];
    app.tabs.panes[0].tabs = [{ id: "t1", content: { kind: "chat", session: "w" } }];
    app.centre.notices = [];
    cli.status = null;
    cli.waiting = false;
    cli.result = null;
    cli.updating = false;
    cli.prefs = { auto: false, lastCheck: null, autoFailedFor: null };
  });

  it("waits for a turn and a warm cache, then updates and the notice clears", async () => {
    await checkCli(true);
    await refreshCentre();
    expect(app.centre.notices.map((n) => n.kind)).toEqual(["cli"]);

    // A turn is running: Update waits, nothing runs.
    app.busy = true;
    await updateWhenCold();
    expect(cli.waiting).toBe(true);
    expect(calls).not.toContain("update");
    expect(cli.reading?.running).toEqual(["a turn"]);

    // The turn ended but the open chat's cache is warm: still waiting,
    // with the cost of going now on hand.
    app.busy = false;
    peeked = warmChat;
    await tickCli();
    expect(calls).not.toContain("update");
    expect(cli.reading?.warm.map((w) => w.tokens)).toEqual([57_400]);

    // Cold: the update runs, the re-check agrees, the notice goes.
    peeked = [];
    await tickCli();
    expect(calls.filter((c) => c === "update")).toHaveLength(1);
    expect(cli.waiting).toBe(false);
    expect(cli.status?.behind).toBe(false);
    await refreshCentre();
    expect(app.centre.notices).toEqual([]);
  });

  it("does nothing by itself with the switch off, and updates at a cold moment with it on", async () => {
    await checkCli(true);
    peeked = [];
    await tickCli();
    expect(calls).not.toContain("update");

    setAutoUpdate(true);
    app.busy = true;
    await tickCli();
    expect(calls).not.toContain("update");
    app.busy = false;
    await tickCli();
    expect(calls.filter((c) => c === "update")).toHaveLength(1);
    expect(cli.status?.installed).toBe("2.1.280");
  });

  it("Now never runs under a turn", async () => {
    await checkCli(true);
    app.busy = true;
    await updateNow();
    expect(calls).not.toContain("update");
    app.busy = false;
    peeked = warmChat;
    await updateNow();
    expect(calls.filter((c) => c === "update")).toHaveLength(1);
  });
});
