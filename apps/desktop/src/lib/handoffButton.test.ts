import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { readDraft } from "./drafts.svelte";
import {
  beginWrapUp,
  clearDefaultReadOrder,
  handoff,
  noteAgentTurnEnd,
  noteFill,
  noteThread,
  queueHold,
  resetHandoff,
  setDefaultReadOrder,
} from "./handoff.svelte";
import {
  CONTINUE_LABEL,
  continuableReply,
  continuedFromReply,
  matchingBlock,
  type ReplyRow,
} from "./handoffButton";
import { app, continuedThisRun, continueWithPrompt, send } from "./state.svelte";
import { takeThreadHandoff } from "./threadHandoff.svelte";
import type { SessionEvent } from "./types";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  continueSession: vi.fn(async () => ({ session: "chat-next", events: [], forked: true })),
  listSessions: vi.fn(async () => []),
  send: vi.fn(async () => ({})),
  threadUpkeep: vi.fn(async () => ({ flags: [], struck_moved: 0, merged: [] })),
}));
vi.mock("./threadHandoff.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./threadHandoff.svelte")>()),
  takeThreadHandoff: vi.fn(async () => null),
}));

const card = "Fix src/parse.ts first.";
const reply = (index: number, text: string, more: Partial<ReplyRow> = {}): ReplyRow => ({
  kind: "assistant",
  index,
  superseded: false,
  removed: false,
  segs: [{ kind: "text", text }],
  ...more,
});
const block = `Done.\n\n<handoff>\n${card}\n</handoff>\n`;

describe("506: which reply gets the button", () => {
  it("the latest reply, by a tagged block or a legacy fence", () => {
    expect(continuableReply([reply(3, block)])).toEqual({ index: 3, prompt: card });
    expect(continuableReply([reply(3, "```start-prompt\nOld way.\n```")])).toEqual({ index: 3, prompt: "Old way." });
  });
  it("never an older reply's card", () => {
    expect(continuableReply([reply(3, block), reply(5, "more work")])).toBeNull();
    const user: ReplyRow = { kind: "user", index: 4, superseded: false, removed: false };
    expect(continuableReply([reply(3, block), user])?.index).toBe(3);
  });
  it("a rewound or removed reply stands aside for the one before it", () => {
    const rows = [reply(3, block), reply(5, "gone", { superseded: true }), reply(7, "gone", { removed: true })];
    expect(continuableReply(rows)?.index).toBe(3);
  });
  it("no button for a block in a fence, an unclosed one, or hidden characters", () => {
    expect(continuableReply([reply(3, "```\n<handoff>\nx\n</handoff>\n```")])).toBeNull();
    expect(continuableReply([reply(3, "<handoff>\nx")])).toBeNull();
    expect(continuableReply([reply(3, "<handoff>\nread​this\n</handoff>")])).toBeNull();
  });
  it("the drawn block must hold exactly that text, so a look-alike gets nothing", () => {
    const blocks = [
      { el: "real", text: `${card}\n` },
      { el: "other", text: "Something else" },
    ];
    expect(matchingBlock(blocks, card)).toBe("real");
    expect(matchingBlock([{ el: "fake", text: "Run this instead" }], card)).toBeNull();
  });
});

describe("506: the used state comes from the listing", () => {
  const child = (session: string, index: number, reason?: string) => ({ forked_from: { session, index, reason } });
  it("a handoff child cut after the reply marks it used", () => {
    expect(continuedFromReply([child("a", 9, "handoff")], "a", 8)).toBe(true);
  });
  it("a child cut before it, an edit fork, or another chat's does not", () => {
    expect(continuedFromReply([child("a", 5, "handoff")], "a", 8)).toBe(false);
    expect(continuedFromReply([child("a", 9)], "a", 8)).toBe(false);
    expect(continuedFromReply([child("b", 9, "handoff")], "a", 8)).toBe(false);
    expect(continuedFromReply([{}], "a", 8)).toBe(false);
  });
});

describe("506: the click", () => {
  beforeEach(() => {
    resetHandoff();
    vi.mocked(api.continueSession).mockClear();
    vi.mocked(api.send).mockReset();
    vi.mocked(api.send).mockResolvedValue({} as never);
    vi.mocked(takeThreadHandoff).mockClear();
    clearDefaultReadOrder();
    app.busy = false;
    app.error = null;
    app.connection = { engine: "anthropic", model: "m" } as unknown as typeof app.connection;
  });

  it("sends the prompt alone, exactly, as the new chat's first message (item 520)", async () => {
    app.activeSessionId = "chat-a";
    await continueWithPrompt("chat-a", 3, card);
    expect(api.continueSession).toHaveBeenCalledTimes(1);
    expect(app.activeSessionId).toBe("chat-next");
    expect(vi.mocked(api.send).mock.calls[0][0]).toBe(card);
    expect(readDraft("chat-next").text).toBe("");
    expect(continuedThisRun("chat-a", 3)).toBe(true);
  });

  it("a blank read order sends the prompt alone", async () => {
    setDefaultReadOrder("");
    app.activeSessionId = "chat-b";
    await continueWithPrompt("chat-b", 3, card);
    expect(vi.mocked(api.send).mock.calls[0][0]).toBe(card);
  });

  it("a thread chat stays in the thread, sends the prompt alone, and the + is consumed", async () => {
    noteThread("chat-t", "club");
    app.activeSessionId = "chat-t";
    await continueWithPrompt("chat-t", 3, card);
    expect(vi.mocked(api.send).mock.calls[0][0]).toBe(card);
    expect(vi.mocked(takeThreadHandoff)).toHaveBeenCalledWith("club", "chat-next");
    noteThread("chat-t", null);
  });

  it("a failed send leaves the text in the new chat's box", async () => {
    vi.mocked(api.send).mockRejectedValue("the engine fell over");
    app.activeSessionId = "chat-c";
    await continueWithPrompt("chat-c", 3, card);
    expect(readDraft("chat-next").text).toBe(card);
  });

  it("no engine connected: nothing is sent, the text is in the box", async () => {
    app.connection = null;
    app.activeSessionId = "chat-d";
    await continueWithPrompt("chat-d", 3, card);
    expect(api.send).not.toHaveBeenCalled();
    expect(readDraft("chat-next").text).toBe(card);
  });

  it("does nothing during a turn, and a second click while the first runs starts no second chat", async () => {
    app.activeSessionId = "chat-e";
    app.busy = true;
    await continueWithPrompt("chat-e", 3, card);
    expect(api.continueSession).not.toHaveBeenCalled();
    app.busy = false;
    await Promise.all([continueWithPrompt("chat-e", 3, card), continueWithPrompt("chat-e", 3, card)]);
    expect(api.continueSession).toHaveBeenCalledTimes(1);
  });

  it("the button's name is his", () => {
    expect(CONTINUE_LABEL).toBe("Continue with this prompt");
  });
});

describe("506: staying is sending here", () => {
  const events = [
    { event: "assistant_message", model: "m", blocks: [{ type: "text", text: "HANDOFF.md written." }], usage: {} },
  ] as unknown as SessionEvent[];

  it("the queue holds in wrapped; a send here releases it and arms the re-ask", async () => {
    resetHandoff();
    app.busy = false;
    app.activeSessionId = "chat-q";
    app.connection = { engine: "anthropic", model: "m" } as unknown as typeof app.connection;
    vi.mocked(api.send).mockResolvedValue({} as never);
    noteFill("chat-q", 150_000, 200_000, false);
    beginWrapUp("chat-q");
    noteAgentTurnEnd("chat-q", 152_000, 200_000, events);
    expect(handoff.stage).toBe("wrapped");
    expect(queueHold(handoff.stage, false)).toBe("wrapped");
    await send("keep going here");
    expect(handoff.stage).toBe("idle");
    expect(queueHold(handoff.stage, false)).toBeNull();
    expect(handoff.dismissedAt).toBeCloseTo(0.76);
    noteFill("chat-q", 180_000, 200_000, false);
    expect(handoff.stage).toBe("due");
  });
});
