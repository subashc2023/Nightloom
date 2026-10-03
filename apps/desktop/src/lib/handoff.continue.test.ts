import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { readDraft } from "./drafts.svelte";
import {
  READ_ORDER,
  beginWrapUp,
  clearDefaultReadOrder,
  handoff,
  noteAgentTurnEnd,
  noteFill,
  readOrder,
  resetHandoff,
  setDefaultReadOrder,
  setReadOrder,
} from "./handoff.svelte";
import { app, continueChat } from "./state.svelte";
import type { SessionEvent } from "./types";

/**
 * The automated hand-off end to end against a scripted engine (nightshift
 * backlog 193): the engine's side is a script — usage readings as the
 * window fills, the wrap-up's reply with its `start-prompt` block — and the
 * backend's `continue_session` is a stub that answers with a new linked
 * chat. What is checked is what he would see: the new chat's box holds the
 * read order and then the model's start prompt, not sent.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  continueSession: vi.fn(async () => ({ session: "chat-next", events: [], forked: true })),
  listSessions: vi.fn(async () => []),
}));

const at = "2026-09-25T03:00:00Z";

/** One scripted engine turn: his message and the model's reply. */
function turn(user: string, reply: string): SessionEvent[] {
  return [
    { event: "user_message", text: user, at },
    {
      event: "assistant_message",
      model: "claude-haiku-4-5",
      blocks: [{ type: "text", text: reply }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      at,
    },
  ] as unknown as SessionEvent[];
}

/** The script, up to the wrap-up's reply: the fill climbs past the mark,
 *  the wrap-up goes, the reply ends with the block (or without one). */
function runScript(chat: string, reply: string): void {
  resetHandoff();
  app.activeSessionId = chat;
  app.busy = false;
  const limit = 200_000;
  // Ordinary turns: usage events mid-turn, then the turn's end.
  noteFill(chat, 60_000, limit, false);
  noteAgentTurnEnd(chat, 90_000, limit, turn("go on", "working"));
  expect(handoff.stage).toBe("idle");
  noteFill(chat, 130_000, limit, false);
  noteAgentTurnEnd(chat, 145_000, limit, turn("go on", "more work"));
  expect(handoff.stage).toBe("due");
  // Wrap up now: the wrap-up's own turn.
  beginWrapUp(chat);
  noteFill(chat, 150_000, limit, false);
  expect(handoff.stage).toBe("wrapping");
  noteAgentTurnEnd(chat, 152_000, limit, turn("wrap up", reply));
  expect(handoff.stage).toBe("wrapped");
}

const REPLY =
  "Added the STATE section to HANDOFF.md.\n\n```start-prompt\nChanged since: the parser test is red. First fix src/parse.ts.\n```\n";

describe("the automated hand-off against a scripted engine", () => {
  beforeEach(() => {
    vi.mocked(api.continueSession).mockClear();
    clearDefaultReadOrder();
  });

  it("opens the linked chat with the read order above the model's start prompt, unsent", async () => {
    runScript("chat-full", REPLY);
    await continueChat();
    expect(vi.mocked(api.continueSession)).toHaveBeenCalledTimes(1);
    expect(app.activeSessionId).toBe("chat-next");
    const box = readDraft("chat-next").text;
    expect(box).toBe(`${READ_ORDER}\n\nChanged since: the parser test is red. First fix src/parse.ts.`);
    // Nothing sent: the new chat's log is what the backend returned.
    expect(app.events).toEqual([]);
    expect(readDraft("chat-next").queue).toHaveLength(0);
    expect(handoff.stage).toBe("idle");
  });

  it("uses the Settings default, and a chat's own read order over it, which the new chat keeps", async () => {
    setDefaultReadOrder("Read PLAN.md first.");
    runScript("chat-own", REPLY);
    setReadOrder("chat-own", "Read NOTES.md, then PLAN.md.");
    await continueChat();
    expect(readDraft("chat-next").text.startsWith("Read NOTES.md, then PLAN.md.\n\nChanged since:")).toBe(true);
    expect(readOrder("chat-next")).toBe("Read NOTES.md, then PLAN.md.");
  });

  it("opens with the read order alone when the reply had no block, and says so", async () => {
    runScript("chat-noblock", "HANDOFF.md written.");
    expect(handoff.startPrompt).toBeNull();
    await continueChat();
    expect(readDraft("chat-next").text).toBe(READ_ORDER);
    expect(handoff.noStartPromptChat).toBe("chat-next");
  });

  it("opens with the start prompt alone when the read order is blank", async () => {
    setDefaultReadOrder("");
    runScript("chat-blank", REPLY);
    await continueChat();
    expect(readDraft("chat-next").text).toBe("Changed since: the parser test is red. First fix src/parse.ts.");
  });
});
