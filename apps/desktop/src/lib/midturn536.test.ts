import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Nightshift item 536 (his report, 2026-11-09): a message he sent while a turn ran showed "not sent yet —
 * goes when this turn ends" with only Edit and Cancel — no Send now — while he needed to stop a runaway turn.
 * The row had not been handed to the turn, and the only retry was the turn's next CLI `init`, which a
 * one-process turn never sends again. Now: every un-handed row says why, is tried again while the turn runs,
 * and every pending row offers Send now — Claude Code's own (priority "now") when the row is handed in, or
 * Stop + send at once (exactly once, into its own chat) when it cannot be. Against a stubbed backend.
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
const { app, applyTurnEvent, injectIntoTurn, openChatKey, send, remoteSend, takeQueued, takeStopSend, frontQueued, handReason, sendNowPlan, RETRY_HAND_MS, turnWasStopped } = st;
const { offersSendNow, pendingLabel, pendingState, sendNow, sendNowTip } = await import("./pendingBubble.svelte");
const composerSrc = (await import("./Composer.svelte?raw")).default as string;

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

describe("536: the root cause — an un-handed row waited for a CLI init that never came", () => {
  it("the reason is recorded, and the turn's next event (not its end) hands the row in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const key = await running();
    const row = enqueueMessage(key, "stop spawning subagents", []);
    await injectIntoTurn(key, row);
    expect(handReason(key, row.id)).toBe("no-inbox");
    expect(pendingState(readDraft(key).queue[0]!, false)).toBe("turn-end");
    // The bubble offers Send now even so.
    expect(sendNowPlan(key, row.id)).toBe("hand");
    expect(offersSendNow("turn-end", "hand")).toBe(true);
    expect(pendingLabel("turn-end")).toContain("or send it now");
    // The turn's stdin opens; an ordinary event comes (no new `init`).
    inject.mockImplementation(async () => true);
    applyTurnEvent({ type: "thinking_delta", text: "…", chat: CHAT } as never);
    await vi.advanceTimersByTimeAsync(RETRY_HAND_MS + 10);
    expect(inject).toHaveBeenCalledTimes(2);
    expect(readDraft(key).queue[0]!.inject).toBeDefined();
    expect(pendingState(readDraft(key).queue[0]!, false)).toBe("next-step");
    expect(handReason(key, row.id)).toBeNull();
  });

  it("with no event at all (a long Bash), the row is still tried again while the turn runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const key = await running();
    const row = enqueueMessage(key, "x", []);
    await injectIntoTurn(key, row);
    await vi.advanceTimersByTimeAsync(RETRY_HAND_MS + 10);
    await vi.advanceTimersByTimeAsync(RETRY_HAND_MS + 10);
    expect(inject.mock.calls.length).toBeGreaterThanOrEqual(3);
    // At the turn's end the retries stop.
    finish(ENDED);
    await going;
    const n = inject.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RETRY_HAND_MS * 3);
    expect(inject.mock.calls.length).toBe(n);
  });
});

describe("536: Send now on a row handed in — Claude Code's own send now", () => {
  it("goes with priority now; the turn is not stopped", async () => {
    inject.mockImplementation(async () => true);
    const key = await running();
    const row = enqueueMessage(key, "look here", []);
    await injectIntoTurn(key, row);
    expect(sendNowPlan(key, row.id)).toBe("now");
    expect(sendNowTip("now")).toContain("Claude Code's own send now");
    await sendNow(key, row.id);
    expect(sendNowInjected).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    expect(readDraft(key).queue[0]!.inject?.now).toBe(true);
  });

  it("Let it arrive no longer hides Send now (only Send now while going hides it)", () => {
    expect(offersSendNow("next-step", "now")).toBe(true);
    expect(offersSendNow("now", "now")).toBe(false);
    expect(offersSendNow("replying", "none")).toBe(false);
  });

  it("the turn's inbox closed meanwhile: Stop + send instead, once", async () => {
    inject.mockImplementation(async () => true);
    const key = await running();
    const row = enqueueMessage(key, "urgent", []);
    await injectIntoTurn(key, row);
    sendNowInjected.mockImplementation(async () => "not_running");
    await sendNow(key, row.id);
    expect(cancel).toHaveBeenCalledTimes(1);
    finish({ ...ENDED, stop_reason: "stopped" });
    await going;
    await drainLikeComposer();
    await drainLikeComposer();
    expect(sendAgent).toHaveBeenCalledTimes(2);
    expect(sendAgent.mock.calls[1]![0]).toBe("urgent");
  });
});

describe("536: Send now on an un-handed row — Stop the turn, send this at once, exactly once, into its own chat", () => {
  it("Stop, then one send of this row (not the queue's older head), into this chat", async () => {
    const key = await running();
    const older = enqueueMessage(key, "an older held message", []);
    const row = enqueueMessage(key, "STOP spawning helpers", []);
    await injectIntoTurn(key, older);
    await injectIntoTurn(key, row);
    expect(sendNowTip("hand", "no-inbox")).toContain("stops the turn instead");
    await sendNow(key, row.id);
    // It tried the hand-in first, then stopped.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]![0]).toBe(CHAT);
    expect(app.toasts.some((t) => t.text.includes("the reply so far stays"))).toBe(true);
    expect(readDraft(key).queue[0]!.id).toBe(row.id);
    finish({ ...ENDED, stop_reason: "stopped" });
    await going;
    // The composer's own drain and its effect both run: one send.
    await drainLikeComposer(key);
    await drainLikeComposer(key);
    expect(sendAgent).toHaveBeenCalledTimes(2);
    expect(sendAgent.mock.calls[1]![0]).toBe("STOP spawning helpers");
    expect(app.activeSessionId).toBe(CHAT);
    // The older row is still held, unsent.
    expect(readDraft(key).queue.map((q) => q.text)).toEqual(["an older held message"]);
  });

  it("racing the turn's own end: the turn ends before the Stop lands — still exactly one send", async () => {
    const key = await running();
    const row = enqueueMessage(key, "race", []);
    await injectIntoTurn(key, row);
    let landed: () => void = () => {};
    cancel.mockImplementation(() => new Promise((r) => (landed = () => r(null))) as never);
    const pressing = sendNow(key, row.id);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    // The turn ends on its own first.
    finish(ENDED);
    await going;
    await drainLikeComposer(key);
    landed();
    await pressing;
    await drainLikeComposer(key);
    expect(sendAgent).toHaveBeenCalledTimes(2);
    expect(sendAgent.mock.calls[1]![0]).toBe("race");
  });

  it("a row the turn took before the Stop landed is not sent again", async () => {
    const key = await running();
    const row = enqueueMessage(key, "taken", []);
    await injectIntoTurn(key, row);
    await sendNow(key, row.id);
    // Gone from the queue (taken, or cancelled by him) before the turn ended.
    st.stopSend.qid = row.id;
    delete drafts[key];
    finish({ ...ENDED, stop_reason: "stopped" });
    await going;
    await drainLikeComposer(key);
    expect(sendAgent).toHaveBeenCalledTimes(1);
  });

  it("a Stop that fails forces nothing", async () => {
    const key = await running();
    const row = enqueueMessage(key, "x", []);
    await injectIntoTurn(key, row);
    cancel.mockImplementation(async () => {
      throw new Error("no turn");
    });
    await sendNow(key, row.id);
    expect(st.stopSend.qid).toBeNull();
  });
});

describe("536: the class — every kind of running turn", () => {
  it("a `/` command turn (no stdin): Send now tries the hand-in, then Stop + send", async () => {
    const key = await running("/review");
    const row = enqueueMessage(key, "never mind", []);
    await injectIntoTurn(key, row);
    expect(sendNowPlan(key, row.id)).toBe("hand");
    await sendNow(key, row.id);
    expect(inject).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("the provider engine (no inbox): no hand-in attempted; Send now is Stop + send", async () => {
    app.draft.engine = "openai" as never;
    app.connection = { engine: "openai", provider: "openai", model: "m", tools: [] } as never;
    going = send("hello");
    await vi.waitFor(() => expect(providerSend).toHaveBeenCalledTimes(1));
    const key = openChatKey();
    const row = enqueueMessage(key, "stop", []);
    await injectIntoTurn(key, row);
    expect(inject).not.toHaveBeenCalled();
    expect(handReason(key, row.id)).toBe("provider");
    expect(sendNowPlan(key, row.id)).toBe("stop");
    expect(sendNowTip("stop", "provider")).toContain("this engine cannot take a message");
    await sendNow(key, row.id);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("a row with a file chip: Stop + send", async () => {
    const key = await running();
    const row = enqueueMessage(key, "with a file", [{ id: 1, kind: "file", name: "a.pdf", media_type: "application/pdf", data: "x" } as never]);
    await injectIntoTurn(key, row);
    expect(handReason(key, row.id)).toBe("files");
    expect(sendNowPlan(key, row.id)).toBe("stop");
  });

  it("another chat's row (a background chat's queue): no Send now, never a Stop of this turn", async () => {
    await running();
    const row = enqueueMessage("chat-other", "for the other chat", []);
    await injectIntoTurn("chat-other", row);
    expect(handReason("chat-other", row.id)).toBe("other-chat");
    expect(sendNowPlan("chat-other", row.id)).toBe("none");
    await sendNow("chat-other", row.id);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("the phone's message lands in the same row and gets the same Send now", async () => {
    const key = await running();
    await remoteSend(CHAT, "from the phone");
    const row = readDraft(key).queue[0]!;
    expect(row.text).toBe("from the phone");
    await vi.waitFor(() => expect(handReason(key, row.id)).toBe("no-inbox"));
    expect(sendNowPlan(key, row.id)).toBe("hand");
  });

  it("a prompt waits on him: its own Send now (in place of an answer), not a Stop", async () => {
    const key = await running();
    const row = enqueueMessage(key, "context", []);
    app.pendingApprovals.push({ id: "toolu_q", name: "AskUserQuestion", input: {}, effect: "mutating", chat: CHAT } as never);
    expect(sendNowPlan(key, row.id)).toBe("reply");
    expect(offersSendNow("waiting", "reply")).toBe(false);
  });

  it("the composer's drain sends the forced row first and holds a second drain (source check)", () => {
    const at = composerSrc.indexOf("async function drain(");
    const drain = composerSrc.slice(at, composerSrc.indexOf("// Scheduled send (backlog 224)", at));
    expect(drain).toContain("takeStopSend(liveKey())");
    expect(drain).toContain("frontQueued(liveKey(), forced)");
    expect(drain).toContain("if (forcing) return;");
    expect(drain.indexOf("takeStopSend")).toBeLessThan(drain.indexOf("if (!explicit && hold) return;"));
  });
});
