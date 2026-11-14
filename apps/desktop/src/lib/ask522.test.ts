import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Nightshift item 522 (2026-11-09): the model's question must never trap him. His report: a Claude Code chat
 * asked an AskUserQuestion; the message he typed to give it context only queued ("goes when this turn ends",
 * no Send now); Skip took the card away and for ~25 s nothing said so. The window's half, against a stubbed
 * backend — the service's half (the refusal on disk, the resume, the log) is tested in Rust (agent_turn.rs).
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  approveCall: vi.fn(async () => null),
  injectMessage: vi.fn(async () => false),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

const api = await import("./api");
const { drafts, enqueueMessage, loadDrafts, readDraft, serializeDrafts } = await import("./drafts.svelte");
const { app, applyTurnEvent, injectIntoTurn, openChatKey, replyToPending, resolveApproval, send } = await import("./state.svelte");
const { handBack, handBackLine, SLOW_MS } = await import("./handBack.svelte");
const { offersChoice, offersReply, pendingLabel, pendingRows, pendingState, sendAsReply } = await import("./pendingBubble.svelte");
const { askKind, carriesAlone, FOLLOWS, pendingFor } = await import("./askReply");

const CHAT = "chat-522";
const ASK = { id: "toolu_q", name: "AskUserQuestion", input: { questions: [] }, effect: "mutating", chat: CHAT } as never;
const approve = vi.mocked(api.approveCall);
const sendAgent = vi.mocked(api.sendAgent);
let finish: (r: unknown) => void = () => {};
let fail: (e: unknown) => void = () => {};
let going: Promise<void> = Promise.resolve();

/** A turn running in the chat on screen, its process gone, a question up. */
async function asked(req = ASK): Promise<string> {
  going = send("hello");
  await vi.waitFor(() => expect(sendAgent).toHaveBeenCalledTimes(1));
  expect(app.busy).toBe(true);
  app.pendingApprovals.push(req);
  return openChatKey();
}

beforeEach(async () => {
  finish({ delivered: [], notices: [], is_error: false, refused: [] });
  await going;
  vi.clearAllMocks();
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.project = { id: "p1", name: "P" } as never;
  app.activeSessionId = CHAT;
  app.sessions = [{ id: CHAT, title: "PoC thread" }] as never;
  app.events = [];
  app.busy = false;
  app.parked = null;
  app.error = null;
  app.toasts = [];
  app.pendingApprovals = [];
  app.limitPause = null;
  app.view = "chat";
  handBack.current = null;
  app.draft.engine = "claude-code";
  app.connection = { engine: "claude-code", provider: "claude-code", model: "m", tools: [] } as never;
  sendAgent.mockImplementation(
    () =>
      new Promise((res, rej) => {
        finish = res as never;
        fail = rej;
      }) as never,
  );
  approve.mockImplementation(async () => null);
});

describe("522: Skip resumes the turn, says so meanwhile, and the chat ends idle", () => {
  it("the refusal goes to the backend, a line stands in the card's place until the call's result, then the turn ends", async () => {
    await asked();
    const ok = await resolveApproval("toolu_q", "AskUserQuestion", "deny", "the user skipped the question; decide yourself");
    expect(ok).toBe(true);
    expect(approve).toHaveBeenCalledWith("toolu_q", "AskUserQuestion", "deny", "the user skipped the question; decide yourself", undefined, undefined, undefined, undefined);
    expect(app.pendingApprovals).toEqual([]);
    // Not silence: the hand-back line, in this chat.
    expect(handBack.current).toMatchObject({ id: "toolu_q", chat: CHAT, how: "skipped" });
    const at = handBack.current!.at;
    expect(handBackLine(handBack.current!, at + 3_000)).toMatchObject({ slow: false, text: "Skipped — handing the turn back to Claude…" });
    // Past 20 s it says how long, and offers Stop (the component draws the button when `slow`).
    const late = handBackLine(handBack.current!, at + SLOW_MS + 5_000);
    expect(late.slow).toBe(true);
    expect(late.text).toContain("Skipped 25 s ago");
    expect(late.text).toContain("Your answer is saved");
    // The resumed process reports the call's result: the line goes.
    applyTurnEvent({ type: "tool_result", tool_use_id: "toolu_q", name: "AskUserQuestion", content: "hook error: skipped", is_error: true, chat: CHAT } as never);
    expect(handBack.current).toBeNull();
    finish({ delivered: [], notices: [], is_error: false, refused: [] });
    await going;
    expect(app.busy).toBe(false);
    expect(app.error).toBeNull();
  });

  it("the line never outlives its turn", async () => {
    await asked();
    await resolveApproval("toolu_q", "AskUserQuestion", "allow", undefined, { answers: {} });
    expect(handBack.current?.how).toBe("answered");
    finish({ delivered: [], notices: [], is_error: false, refused: [] });
    await going;
    expect(handBack.current).toBeNull();
  });
});

describe("522: a message sent while a prompt waits goes at once, as his reply", () => {
  it("the composer's send refuses the question with his words and the row leaves the queue when the turn reports it", async () => {
    const key = await asked();
    const row = enqueueMessage(key, "  you lack context: nothing is decided yet  ", []);
    await injectIntoTurn(key, row);
    // No process runs to take a message: nothing is handed to stdin.
    expect(api.injectMessage).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledTimes(1);
    const args = approve.mock.calls[0]!;
    expect(args.slice(0, 3)).toEqual(["toolu_q", "AskUserQuestion", "deny"]);
    expect(args[3]).toBeUndefined();
    const reply = args[7] as { text: string; id: string };
    expect(reply.text).toBe("you lack context: nothing is decided yet");
    expect(app.pendingApprovals).toEqual([]);
    expect(handBack.current?.how).toBe("replied");
    // Still in the queue, marked, until the turn says it has it.
    const held = readDraft(key).queue[0]!;
    expect(held.inject).toMatchObject({ id: reply.id, reply: true });
    expect(pendingState(held, false)).toBe("replying");
    expect(pendingLabel("replying")).toBe("sending — in place of an answer");
    expect(offersChoice("replying", false)).toBe(false);
    applyTurnEvent({ type: "tool_result", tool_use_id: "toolu_q", name: "AskUserQuestion", content: "…", is_error: true, chat: CHAT } as never);
    applyTurnEvent({ type: "message_delivered", id: reply.id, text: reply.text, after: "in place of an answer to AskUserQuestion", chat: CHAT } as never);
    expect(readDraft(key).queue).toEqual([]);
    expect(app.live?.segments.some((g) => g.kind === "notice" && (g as { delivered?: { text: string } }).delivered?.text === reply.text)).toBe(true);
  });

  it("every Ask-position kind takes a reply: question, plan, permission prompt, browser prompt", async () => {
    expect(["AskUserQuestion", "ExitPlanMode", "Bash", "mcp__playwright__browser_click"].map(askKind)).toEqual(["question", "plan", "call", "browser"]);
    for (const name of ["ExitPlanMode", "Bash", "mcp__playwright__browser_click"]) {
      finish({ delivered: [], notices: [], is_error: false, refused: [] });
      await going;
      vi.clearAllMocks();
      for (const k of Object.keys(drafts)) delete drafts[k];
      const key = await asked({ id: `toolu_${name}`, name, input: {}, effect: "mutating", chat: CHAT } as never);
      const row = enqueueMessage(key, "do it the other way", []);
      expect(await replyToPending(key, row)).toBe("sent");
      expect(approve.mock.calls[0]!.slice(0, 3)).toEqual([`toolu_${name}`, name, "deny"]);
      expect((approve.mock.calls[0]![7] as { text: string }).text).toBe("do it the other way");
    }
  });

  it("the provider engine's prompt is not a deferred call: nothing is refused on a message's account", async () => {
    expect(pendingFor([ASK], "provider")).toBeNull();
    expect(pendingFor([ASK], "claude-code")).toBe(ASK);
    expect(pendingFor([], "claude-code")).toBeNull();
  });

  it("a row already queued shows Send now while the chat waits on him, and it sends the reply", async () => {
    const key = await asked();
    const row = enqueueMessage(key, "queued before the build", []);
    // Waiting on him, no process: not "goes when this turn ends".
    const st = pendingState(row, true);
    expect(st).toBe("waiting");
    expect(offersReply(st)).toBe(true);
    expect(pendingLabel(st)).toContain("Claude is waiting on your answer");
    expect(pendingLabel(st)).not.toContain("goes when this turn ends");
    // A turn that is running a process keeps its old states.
    expect(pendingState(row, false)).toBe("turn-end");
    expect(offersReply("turn-end")).toBe(false);
    expect(offersReply("next-step")).toBe(false);
    expect(pendingRows(readDraft(key).queue, true).map((r) => r.id)).toEqual([row.id]);
    await sendAsReply(key, row.id);
    expect(approve).toHaveBeenCalledTimes(1);
    expect((approve.mock.calls[0]![7] as { text: string }).text).toBe("queued before the build");
  });

  it("a message with files: the call is refused saying a message follows, and the row is handed to the resumed process whole", async () => {
    const key = await asked();
    const image = { id: 1, kind: "image", media_type: "image/png", name: "shot.png", data: "AAAA" } as never;
    const row = enqueueMessage(key, "see the screenshot", [image]);
    expect(carriesAlone(row)).toBe(false);
    expect(await replyToPending(key, row)).toBe("follows");
    const args = approve.mock.calls[0]!;
    expect(args.slice(0, 4)).toEqual(["toolu_q", "AskUserQuestion", "deny", FOLLOWS]);
    expect(args[7]).toBeUndefined();
    expect(handBack.current?.how).toBe("replied");
    expect(readDraft(key).queue.map((r) => r.text)).toEqual(["see the screenshot"]);
    // The resume's process starts: the row goes in, files and all.
    vi.mocked(api.injectMessage).mockImplementation(async () => true);
    applyTurnEvent({ type: "agent_init", model: "m", tools: [], mcp_servers: [], slash_commands: [], chat: CHAT } as never);
    await vi.waitFor(() => expect(api.injectMessage).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(api.injectMessage).mock.calls[0]!;
    expect(sent[2]).toBe("see the screenshot");
    expect(sent[3]).toEqual([{ media_type: "image/png", data: "AAAA" }]);
  });
});

describe("522: a failure on the way is said, and the chat comes back idle with the message still his", () => {
  it("an answer the backend does not take puts the card back and leaves the row queued", async () => {
    const key = await asked();
    approve.mockImplementation(async () => {
      throw "that prompt is no longer waiting: its turn has ended";
    });
    const row = enqueueMessage(key, "more context", []);
    expect(await replyToPending(key, row)).toBe("failed");
    expect(app.pendingApprovals.map((r) => r.id)).toEqual(["toolu_q"]);
    expect(handBack.current).toBeNull();
    expect(readDraft(key).queue.map((r) => [r.text, r.inject])).toEqual([["more context", undefined]]);
    expect(app.toasts.map((t) => t.text).join(" ")).toContain("Your answer was not taken");
    // Skip fails the same way: never a card that silently left.
    app.toasts = [];
    expect(await resolveApproval("toolu_q", "AskUserQuestion", "deny", "skip")).toBe(false);
    expect(app.pendingApprovals.map((r) => r.id)).toEqual(["toolu_q"]);
    expect(app.toasts.length).toBe(1);
  });

  it("a resume that fails ends the turn with its error; the reply is an ordinary held message again, sendable", async () => {
    const key = await asked();
    const row = enqueueMessage(key, "more context", []);
    expect(await replyToPending(key, row)).toBe("sent");
    expect(readDraft(key).queue[0]!.inject?.reply).toBe(true);
    // The resumed process dies: the turn's send rejects, nothing was delivered.
    fail("claude exited with status 1");
    await going;
    expect(app.busy).toBe(false);
    expect(app.error).toContain("claude exited with status 1");
    expect(app.pendingApprovals).toEqual([]);
    expect(handBack.current).toBeNull();
    const left = readDraft(key).queue;
    expect(left.map((r) => r.text)).toEqual(["more context"]);
    expect(left[0]!.inject).toBeUndefined();
    // Idle: no pending bubble; the composer's queue row offers it (its Send next).
    expect(pendingRows(left, app.busy)).toEqual([]);
  });
});

describe("522: a chat stuck in this state recovers on relaunch", () => {
  it("the queue is read back with no mark of the dead turn, so its rows are sendable in an idle chat", () => {
    const key = "chat-stuck";
    const stored = serializeDrafts({
      [key]: {
        text: "",
        attachments: [],
        queue: [
          { id: 4, text: "typed while the question waited", attachments: [] },
          { id: 5, text: "sent as a reply, never delivered", attachments: [], inject: { id: "w-1", turn: "turn:dead-1", reply: true } },
        ],
      },
    });
    const back = loadDrafts({ getItem: () => stored });
    expect(back[key]!.queue.map((r) => [r.text, r.inject])).toEqual([
      ["typed while the question waited", undefined],
      ["sent as a reply, never delivered", undefined],
    ]);
    // A fresh launch has no turn and no card: nothing is drawn as pending, nothing waits on an answer.
    expect(pendingRows(back[key]!.queue, false)).toEqual([]);
    expect(app.pendingApprovals).toEqual([]);
  });
});
