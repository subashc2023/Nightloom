import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Item 703 (2026-11-15, chat e1f2156b): Send now on a queued row took item 536's Stop + send while the
 * turn's agents could still run — a Stop ends the turn's Claude Code process and every agent in it — and
 * nothing in the transcript said a session had been cut. Now Send now never stops while this chat's agents
 * run (the row goes in plain, or is held, and a toast says which), and a turn that ends with agents still
 * running leaves a yellow Nightloom notice naming them, "resumed" once a later turn ran.
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(async () => null),
  injectMessage: vi.fn(async () => false),
  sendNowInjected: vi.fn(async () => "sent"),
  takeBackInjected: vi.fn(async () => "cancelled"),
  approveCall: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

const api = await import("./api");
const { drafts, enqueueMessage, readDraft } = await import("./drafts.svelte");
const st = await import("./state.svelte");
const { app, injectIntoTurn, openChatKey, send } = st;
const { sendNow } = await import("./pendingBubble.svelte");

const CHAT = "chat-703";
const sendAgent = vi.mocked(api.sendAgent);
const providerSend = vi.mocked(api.send);
const inject = vi.mocked(api.injectMessage);
const cancel = vi.mocked(api.cancel);
const sendNowInjected = vi.mocked(api.sendNowInjected);
let finish: (r: unknown) => void = () => {};
let going: Promise<void> = Promise.resolve();
const ENDED = { delivered: [], notices: [], is_error: false, refused: [] };

/** A Claude Code turn running in the chat on screen. */
async function running(text = "hello"): Promise<string> {
  going = send(text);
  await vi.waitFor(() => expect(sendAgent).toHaveBeenCalledTimes(1));
  expect(app.busy).toBe(true);
  return openChatKey();
}

beforeEach(async () => {
  finish(ENDED);
  await going;
  vi.clearAllMocks();
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(app.background)) delete app.background[k];
  for (const k of Object.keys(st.handWhy)) delete st.handWhy[k];
  st.stopSend.key = null;
  st.stopSend.qid = null;
  app.project = { id: "p1", name: "P" } as never;
  app.activeSessionId = CHAT;
  app.sessions = [{ id: CHAT, title: "Research" }] as never;
  app.events = [];
  app.busy = false;
  app.parked = null;
  app.error = null;
  app.toasts = [];
  app.pendingApprovals = [];
  app.limitPause = null;
  app.view = "chat";
  app.draft.engine = "claude-code";
  app.connection = { engine: "claude-code", provider: "claude-code", model: "m", tools: [] } as never;
  inject.mockImplementation(async () => false);
  sendNowInjected.mockImplementation(async () => "sent");
  cancel.mockImplementation(async () => null);
  const pending = () =>
    new Promise((res) => {
      finish = res as never;
    });
  sendAgent.mockImplementation(pending as never);
  providerSend.mockImplementation(pending as never);
});


const { cutsOf, cutText, placeCuts, noteCut, besideAgentsToast, shortName, CUTS_KEY } = await import("./sessionCut");
const transcriptSrc = (await import("./Transcript.svelte?raw")).default as string;
const classicSrc = (await import("./TranscriptClassic.svelte?raw")).default as string;

function agentRow(description: string, status = "running") {
  return { session: CHAT, status, description, tool_use_id: description, task_id: description, turn: 0, startedAt: 0, updatedAt: 0, segments: [] } as never;
}

afterEach(() => {
  vi.useRealTimers();
  app.subagents = [];
  localStorage.removeItem(CUTS_KEY);
});

describe("703: Send now never stops a turn whose agents run", () => {
  it("an un-handed row (536's Stop + send) is held instead, with a toast naming the agents", async () => {
    const key = await running();
    app.subagents = [agentRow("Resolve enterprise vignette 2"), agentRow("Critical review of three vignettes")];
    const row = enqueueMessage(key, "Ehh make it 3-4", []);
    await injectIntoTurn(key, row);
    await sendNow(key, row.id);
    expect(cancel).not.toHaveBeenCalled();
    expect(sendNowInjected).not.toHaveBeenCalled();
    expect(readDraft(key).queue[0]!.id).toBe(row.id);
    expect(app.toasts.some((t) => t.text.startsWith("Held, not sent now — 2 agents are running"))).toBe(true);
    expect(st.stopSend.qid).toBeNull();
  });

  it("a row handed in goes plain (no priority now, no stop) and says so", async () => {
    inject.mockImplementation(async () => true);
    const key = await running();
    app.subagents = [agentRow("Resolve enterprise vignette 2")];
    const row = enqueueMessage(key, "look here", []);
    await injectIntoTurn(key, row);
    await sendNow(key, row.id);
    expect(cancel).not.toHaveBeenCalled();
    expect(sendNowInjected).not.toHaveBeenCalled();
    expect(readDraft(key).queue[0]!.inject).toBeTruthy();
    expect(app.toasts.some((t) => t.text.startsWith("Sent into the turn without stopping it — 1 agent is running"))).toBe(true);
  });

  it("finished agents do not hold it: Send now is 536's as before", async () => {
    const key = await running();
    app.subagents = [agentRow("done one", "completed")];
    const row = enqueueMessage(key, "urgent", []);
    await injectIntoTurn(key, row);
    await sendNow(key, row.id);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("703: a turn that ends with agents running is marked, and the transcript says so", () => {
  it("the turn's end records the running agents under the chat", async () => {
    await running();
    app.subagents = [agentRow("Resolve enterprise vignette 2"), agentRow("old", "completed")];
    finish({ ...ENDED, stop_reason: "stopped" });
    await going;
    const cuts = cutsOf(localStorage, CHAT);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.agents).toEqual(["Resolve enterprise vignette 2"]);
  });

  it("a turn that ends with none running marks nothing", async () => {
    await running();
    app.subagents = [agentRow("old", "completed")];
    finish(ENDED);
    await going;
    expect(cutsOf(localStorage, CHAT)).toHaveLength(0);
  });

  it("the words: what was cut, names cut on a word", () => {
    expect(cutText(["Resolve enterprise vignette 2", "Critical review of three vignettes"])).toBe(
      "Session cut — 2 agents were stopped: Resolve enterprise…, Critical review of three…",
    );
    expect(cutText(["x"])).toBe("Session cut — 1 agent was stopped: x");
    expect(shortName("short")).toBe("short");
    expect(besideAgentsToast(["a"], "held")).toContain("It goes when the turn ends");
  });

  it("placed before his first message after it (resumed), else at the end", () => {
    const users = [
      { index: 0, at: "2026-11-16T06:37:02Z" },
      { index: 4, at: "2026-11-16T06:46:26Z" },
    ];
    const cut = { at: Date.parse("2026-11-16T06:46:25.6Z"), agents: ["a"] };
    const late = { at: Date.parse("2026-11-16T06:50:00Z"), agents: ["b"] };
    const p = placeCuts([cut, late], users);
    expect(p.before.get(4)).toEqual([cut]);
    expect(p.tail).toEqual([late]);
  });

  it("the store keeps 20 a chat and survives junk", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    m.set(CUTS_KEY, "not json");
    expect(cutsOf(s, "c")).toEqual([]);
    for (let i = 0; i < 25; i++) noteCut(s, "c", ["a"], i);
    expect(cutsOf(s, "c").map((c) => c.at)[0]).toBe(5);
    noteCut(s, "c", [], 99);
    expect(cutsOf(s, "c")).toHaveLength(20);
  });

  it("both transcripts draw the notice: before a message and at the end", () => {
    for (const src of [transcriptSrc, classicSrc]) {
      expect(src).toContain("<SessionCutNotice cuts={cutPlaces.before.get(i) ?? []} resumed />");
      expect(src).toContain("<SessionCutNotice cuts={cutPlaces.tail} resumed={false} />");
    }
  });
});
