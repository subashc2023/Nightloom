import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Nightshift item 720 (2026-11-16; his "the default should be slip … make the stop and send option always
 * there (but dimmed or something) and then … more bright … when its actually the better option"): Send now
 * only ever slips a row into the running turn — nothing is stopped; Interrupt and send is beside it on every
 * pending row (Claude Code's own send now in the running process; Stop + send only for a row the turn cannot
 * take), dimmed while a gap is coming and lit when none is. Measured first on CLI 2.1.325
 * (nightshift notes/runner-design/720-measurements/). Scaffolding as midturn536.test.ts; a stubbed backend.
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
const { app, injectIntoTurn, openChatKey, send, takeQueued, takeStopSend, frontQueued, sendNowPlan, turnWasStopped } = st;
const { offersInterrupt, offersSendNow, pendingLabel, pendingHead, pendingState, interruptSend, interruptTip, sendNow, SLIP_TIP } = await import("./pendingBubble.svelte");
const { interruptLit, mainNow, NO_GAP_MS } = await import("./interruptLit");
const { injectChip } = await import("./midTurn");
const bubbleSrc = (await import("./MidTurnBubble.svelte?raw")).default as string;

const CHAT = "chat-536";
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

/** The composer's drain at a turn's end, as Composer.svelte runs it (536's part): a forced row first. */
async function drainLikeComposer(from?: string): Promise<void> {
  if (app.busy || !app.connection) return;
  let explicit = false;
  const forced = takeStopSend(openChatKey());
  if (forced !== null) {
    if (!frontQueued(openChatKey(), forced)) return;
    explicit = true;
    from = undefined;
  }
  if (!explicit && turnWasStopped()) return;
  const q = takeQueued(openChatKey(), false, from);
  if (!q) return;
  going = send(q.text);
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

afterEach(() => {
  vi.useRealTimers();
});

// The 536 scaffolding, whole; this file drains nothing itself.
void drainLikeComposer;

describe("720: Send now slips the row in and never stops anything", () => {
  it("a row not handed in yet is handed in; no priority now, no Stop", async () => {
    const key = await running();
    const row = enqueueMessage(key, "also check the logs", []);
    await injectIntoTurn(key, row);
    expect(readDraft(key).queue[0]!.inject).toBeUndefined();
    expect(offersSendNow("turn-end", sendNowPlan(key, row.id))).toBe(true);
    inject.mockImplementation(async () => true);
    await sendNow(key, row.id);
    expect(readDraft(key).queue[0]!.inject).toBeDefined();
    expect(readDraft(key).queue[0]!.inject?.now).toBeUndefined();
    expect(sendNowInjected).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a turn that cannot take it: the row stays queued for the turn's end, a toast says so, nothing stops", async () => {
    const key = await running();
    const row = enqueueMessage(key, "later then", []);
    await injectIntoTurn(key, row);
    await sendNow(key, row.id);
    expect(readDraft(key).queue.map((q) => q.text)).toEqual(["later then"]);
    expect(cancel).not.toHaveBeenCalled();
    expect(sendNowInjected).not.toHaveBeenCalled();
    expect(app.toasts.some((t) => t.text.includes("goes when this turn ends"))).toBe(true);
  });

  it("a row already handed in has no Send now left: it says it is waiting for a gap", async () => {
    inject.mockImplementation(async () => true);
    const key = await running();
    const row = enqueueMessage(key, "look here", []);
    await injectIntoTurn(key, row);
    const st = pendingState(readDraft(key).queue[0]!);
    expect(st).toBe("next-step");
    expect(offersSendNow(st, sendNowPlan(key, row.id))).toBe(false);
    expect(pendingHead(st)).toContain("waiting for a gap");
    expect(pendingLabel(st)).toContain("waiting for a gap");
    expect(injectChip({}).label).toBe("waiting for a gap");
    expect(SLIP_TIP).toContain("Nothing is stopped");
    // Pressing it anyway (a stale button) changes nothing.
    await sendNow(key, row.id);
    expect(sendNowInjected).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("720: Interrupt and send is always offered, and goes in the running process", () => {
  it("on a row handed in: Claude Code's own send now, no Stop", async () => {
    inject.mockImplementation(async () => true);
    const key = await running();
    const row = enqueueMessage(key, "stop, wrong file", []);
    await injectIntoTurn(key, row);
    expect(offersInterrupt("next-step", sendNowPlan(key, row.id))).toBe(true);
    await interruptSend(key, row.id);
    expect(sendNowInjected).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(readDraft(key).queue[0]!.inject?.now).toBe(true);
    expect(pendingHead("now")).toContain("interrupting");
  });

  it("offered on a row not handed in too, and not once it is going", () => {
    expect(offersInterrupt("turn-end", "hand")).toBe(true);
    expect(offersInterrupt("turn-end", "stop")).toBe(true);
    expect(offersInterrupt("now", "now")).toBe(false);
    expect(offersInterrupt("waiting", "reply")).toBe(false);
  });

  it("agents running and the main agent writing its answer: it goes in the process (measured: a background agent runs on), never a Stop", async () => {
    inject.mockImplementation(async () => true);
    const key = await running();
    app.subagents = [{ session: CHAT, status: "running", description: "survey the logs", task_id: "t1" }] as never;
    app.live = { segments: [{ kind: "text", text: "Here is the long answer so far" }] } as never;
    const row = enqueueMessage(key, "stop, wrong file", []);
    await injectIntoTurn(key, row);
    await interruptSend(key, row.id);
    expect(sendNowInjected).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    // The process cannot take it now: still no Stop beside agents.
    sendNowInjected.mockImplementation(async () => "not_running");
    const second = enqueueMessage(key, "and another", []);
    await injectIntoTurn(key, second);
    await interruptSend(key, second.id);
    expect(cancel).not.toHaveBeenCalled();
    app.subagents = [] as never;
  });

  it("agents running and the main agent inside a call (item 703 stands): slipped in, no send now, no Stop", async () => {
    inject.mockImplementation(async () => true);
    const key = await running();
    app.subagents = [{ session: CHAT, status: "running", description: "survey the logs", task_id: "t1" }] as never;
    app.live = { segments: [{ kind: "tool", call: { id: "c1", name: "Agent", input: {}, result: null } }] } as never;
    const row = enqueueMessage(key, "stop, wrong file", []);
    await injectIntoTurn(key, row);
    await interruptSend(key, row.id);
    expect(sendNowInjected).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    app.subagents = [] as never;
  });
});

describe("720: the interrupt is dimmed while a gap is coming and lit when none is", () => {
  it("what the main agent is doing, from the live reply's last segment", () => {
    expect(mainNow(null)).toBe("idle");
    expect(mainNow([])).toBe("idle");
    expect(mainNow([{ kind: "text" }])).toBe("writing");
    expect(mainNow([{ kind: "thinking" }])).toBe("thinking");
    expect(mainNow([{ kind: "text" }, { kind: "tool", call: { result: null } }])).toBe("calling");
    expect(mainNow([{ kind: "tool", call: { result: { content: "", is_error: false } } }])).toBe("idle");
  });

  it("lit while the answer is being written, or once a row has waited with no gap", () => {
    expect(interruptLit("writing", 0)).toBe("writing");
    expect(interruptLit("calling", 0)).toBeNull();
    expect(interruptLit("thinking", NO_GAP_MS - 1)).toBeNull();
    expect(interruptLit("calling", NO_GAP_MS)).toBe("long");
  });

  it("the tip says which it is", () => {
    expect(interruptTip("now", null, "writing")).toContain("no gap is coming");
    expect(interruptTip("now", null, null)).toContain("A gap is coming");
    expect(interruptTip("now", null, "long")).toContain("No gap has come");
    expect(interruptTip("now")).toContain("background agents keep running");
    expect(interruptTip("stop", "provider")).toContain("Stop this turn");
  });

  it("both themes draw both buttons, the interrupt marked lit or dim", () => {
    const src = bubbleSrc;
    expect(src.match(/data-mt="send-now"/g)).toHaveLength(2);
    expect(src.match(/data-mt="interrupt"/g)).toHaveLength(2);
    expect(src.match(/data-lit=\{lit \?\? "no"\}/g)).toHaveLength(2);
    expect(src).toContain("interruptSend(chatKey, row!.id)");
    expect(src).toContain(">Interrupt and send</button");
    expect(src).toContain('label="Interrupt and send"');
  });
});
