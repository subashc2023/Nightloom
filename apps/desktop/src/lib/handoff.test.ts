import { describe, expect, it } from "vitest";
import {
  AWAY_MS,
  RE_ASK,
  WRAP_UP,
  autoQueues,
  extractStartPrompt,
  isAway,
  lastReplyText,
  nextStage,
  parseStored,
  queueHold,
} from "./handoff.svelte";
import type { SessionEvent } from "./types";

// The context-full hand-off (nightshift backlog 086; pass 2 per blocker
// 120): the stage machine that decides when the wrap-up is asked, the away
// rule, and the start prompt read out of the reply — tested as the pure
// functions they are, since the running app could not be driven the day
// they were built.

describe("nextStage", () => {
  it("arms once the fill crosses the chat's threshold, and not before", () => {
    expect(nextStage("idle", 0.69, 0.7, 0)).toBe("idle");
    expect(nextStage("idle", 0.7, 0.7, 0)).toBe("due");
    expect(nextStage("idle", 0.95, 0.7, 0)).toBe("due");
  });

  it("holds due until the wrap-up goes, then wrapped after that turn", () => {
    expect(nextStage("due", 0.99, 0.7, 0)).toBe("due");
    expect(nextStage("wrapping", 0.8, 0.7, 0)).toBe("wrapped");
    expect(nextStage("wrapped", 0.8, 0.7, 0)).toBe("wrapped");
  });

  it("after Stay here, asks again only past the re-ask mark and higher than where it was dismissed", () => {
    // Dismissed at 72%: the same fill, and anything under 85%, is quiet.
    expect(nextStage("idle", 0.72, 0.7, 0.72)).toBe("idle");
    expect(nextStage("idle", 0.8, 0.7, 0.72)).toBe("idle");
    expect(nextStage("idle", RE_ASK, 0.7, 0.72)).toBe("due");
    // Dismissed at 90%: 88% does not re-ask, 91% does.
    expect(nextStage("idle", 0.88, 0.7, 0.9)).toBe("idle");
    expect(nextStage("idle", 0.91, 0.7, 0.9)).toBe("due");
  });

  it("respects a per-chat threshold lower or higher than the default", () => {
    expect(nextStage("idle", 0.05, 0.03, 0)).toBe("due");
    expect(nextStage("idle", 0.8, 0.9, 0)).toBe("idle");
  });
});

describe("the wrap-up text", () => {
  it("names the file, its contents, the start-prompt fence and the stop", () => {
    expect(WRAP_UP).toContain("HANDOFF.md");
    for (const part of ["what we were doing", "what is done", "what is next", "files that matter"]) {
      expect(WRAP_UP).toContain(part);
    }
    expect(WRAP_UP).toContain("start-prompt");
    expect(WRAP_UP).toMatch(/Then stop/);
  });

  it("is a message of its own: nothing marks it as appended (pass 1's rule and marker are gone)", () => {
    expect(WRAP_UP).not.toMatch(/^---/);
    expect(WRAP_UP).not.toContain("Added by Nightloom");
  });
});

// The away rule (blocker 120): no send and no keystroke for a minute, and
// the window not in front (or the chat not the open one). Both halves.
describe("isAway", () => {
  const t0 = 1_000_000;
  it("is present while he typed or sent within the minute, whatever the window", () => {
    expect(isAway(t0 + AWAY_MS - 1, t0, false, true)).toBe(false);
    expect(isAway(t0 + AWAY_MS - 1, t0, false, false)).toBe(false);
  });
  it("is present after a quiet minute when the window is in front on this chat", () => {
    expect(isAway(t0 + AWAY_MS, t0, true, true)).toBe(false);
  });
  it("is away after a quiet minute with the window behind, or the chat not the open one", () => {
    expect(isAway(t0 + AWAY_MS, t0, false, true)).toBe(true);
    expect(isAway(t0 + AWAY_MS, t0, true, false)).toBe(true);
    expect(isAway(t0 + 3 * AWAY_MS, t0, false, false)).toBe(true);
  });
});

// What puts the wrap-up in the queue by itself: the crossing, away, and
// never after a Stay here (blocker 121's default) — a notice he has seen
// never queues.
describe("autoQueues", () => {
  it("queues at the crossing when he is away", () => {
    expect(autoQueues("idle", "due", true, 0)).toBe(true);
  });
  it("only shows the notice when he is present", () => {
    expect(autoQueues("idle", "due", false, 0)).toBe(false);
  });
  it("never queues while a notice is already open, or on the wrap-up's own turn", () => {
    expect(autoQueues("due", "due", true, 0)).toBe(false);
    expect(autoQueues("wrapping", "wrapped", true, 0)).toBe(false);
    expect(autoQueues("idle", "idle", true, 0)).toBe(false);
  });
  it("never queues after a Stay here, even at the re-ask crossing", () => {
    expect(autoQueues("idle", "due", true, 0.72)).toBe(false);
  });
});

// The composer's queue (backlog 089) at a turn's end. ~~F11: due holds~~ —
// since pass 2 the wrap-up rides no message, so a notice holds nothing and
// the queued wrap-up goes through the queue; what holds is a Stop (F12) and
// the wrap-up's own turn having ended.
describe("queueHold", () => {
  it("lets the queue send itself when nothing was stopped and no hand-off just happened", () => {
    expect(queueHold("idle", false)).toBeNull();
    expect(queueHold("due", false)).toBeNull();
    expect(queueHold("wrapping", false)).toBeNull();
  });

  it("holds once HANDOFF.md is written, so no more work lands in the full chat unasked", () => {
    expect(queueHold("wrapped", false)).toBe("wrapped");
  });

  it("holds after a Stop, and names the hand-off first when both apply", () => {
    expect(queueHold("idle", true)).toBe("stopped");
    expect(queueHold("wrapped", true)).toBe("wrapped");
  });
});

// The start prompt: the last fenced block tagged start-prompt in the reply.
describe("extractStartPrompt", () => {
  it("takes the block's text, trimmed", () => {
    const reply = "Handoff written.\n\n```start-prompt\nRead HANDOFF.md, then notes/q5.md. Start with the correction.\n```\n";
    expect(extractStartPrompt(reply)).toBe("Read HANDOFF.md, then notes/q5.md. Start with the correction.");
  });

  it("takes the last block when there are several, and keeps its inner lines", () => {
    const reply = "```start-prompt\nfirst\n```\nthen, revised:\n```start-prompt\nRead A.\nRead B.\n\nDo C.\n```";
    expect(extractStartPrompt(reply)).toBe("Read A.\nRead B.\n\nDo C.");
  });

  it("accepts the tag beside other words on the fence line, and a closing fence without a newline", () => {
    expect(extractStartPrompt("```md start-prompt\nRead X.```")).toBe("Read X.");
    expect(extractStartPrompt("```text start-prompt title\nRead Y.\n```")).toBe("Read Y.");
  });

  it("finds nothing in an untagged block, an empty block, or plain text", () => {
    expect(extractStartPrompt("```\nRead HANDOFF.md\n```")).toBeNull();
    expect(extractStartPrompt("```start-prompt\n\n```")).toBeNull();
    expect(extractStartPrompt("Read HANDOFF.md and continue.")).toBeNull();
    expect(extractStartPrompt("")).toBeNull();
  });
});

describe("lastReplyText", () => {
  const at = "2026-09-16T12:00:00Z";
  const usage = { input_tokens: 1, output_tokens: 1 };
  it("joins the text blocks of the last assistant message and skips tool blocks", () => {
    const events = [
      { event: "user_message", text: "hi", at },
      {
        event: "assistant_message",
        model: "m",
        blocks: [{ type: "text", text: "old" }],
        stop_reason: null,
        usage,
        at,
      },
      { event: "user_message", text: "wrap up", at },
      {
        event: "assistant_message",
        model: "m",
        blocks: [
          { type: "text", text: "Handoff written." },
          { type: "tool_use", id: "t", name: "Write", input: {} },
          { type: "text", text: "```start-prompt\nRead HANDOFF.md.\n```" },
        ],
        stop_reason: null,
        usage,
        at,
      },
    ] as unknown as SessionEvent[];
    expect(lastReplyText(events)).toBe("Handoff written.\n```start-prompt\nRead HANDOFF.md.\n```");
    expect(extractStartPrompt(lastReplyText(events))).toBe("Read HANDOFF.md.");
  });
  it("is empty with no reply", () => {
    expect(lastReplyText([{ event: "user_message", text: "hi", at }] as SessionEvent[])).toBe("");
  });
});

// The stored preference: pass 1's shape (default, perChat) reads back
// unchanged, and pass 2's message fields default to the built-in text.
describe("parseStored", () => {
  it("reads pass 1's shape and fills the message fields", () => {
    const s = parseStored(JSON.stringify({ default: 0.5, perChat: { a: 0.9 } }));
    expect(s.default).toBe(0.5);
    expect(s.perChat).toEqual({ a: 0.9 });
    expect(s.message).toBeNull();
    expect(s.messages).toEqual({});
  });
  it("drops a bad ratio, a blank message and a malformed store", () => {
    const s = parseStored(JSON.stringify({ default: 3, perChat: { a: 0, b: 0.4 }, message: "  ", messages: { c: "", d: "Wrap." } }));
    expect(s.default).toBe(0.7);
    expect(s.perChat).toEqual({ b: 0.4 });
    expect(s.message).toBeNull();
    expect(s.messages).toEqual({ d: "Wrap." });
    expect(parseStored("{not json").default).toBe(0.7);
    expect(parseStored(null).messages).toEqual({});
  });
});

// The readings, end to end against the stores: the crossing while away
// puts the wrap-up in the chat's queue, Stay here takes it back, the
// wrap-up's own turn keeps the start prompt, a raised mark puts the notice
// away. `windowFocused` is false under node (no document), so `awayNow`
// depends on the activity clock alone here.
import {
  abortWrapUp,
  beginWrapUp,
  defaultMessage,
  handoff,
  hasOwnMessage,
  message,
  noteActivity,
  noteAgentTurnEnd,
  noteFill,
  reconsider,
  resetHandoff,
  setDefaultMessage,
  setMessage,
  setThreshold,
  stayHere,
  threshold,
} from "./handoff.svelte";
import { readDraft } from "./drafts.svelte";

describe("noteFill and the queue", () => {
  const at = "2026-09-16T12:00:00Z";
  const reply = (text: string): SessionEvent[] =>
    [
      { event: "user_message", text: "wrap up", at },
      { event: "assistant_message", model: "m", blocks: [{ type: "text", text }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 }, at },
    ] as unknown as SessionEvent[];

  it("shows only the notice at the crossing when he is present", () => {
    resetHandoff();
    noteFill("chat-p", 75, 100, false);
    expect(handoff.stage).toBe("due");
    expect(handoff.queuedId).toBe(0);
    expect(readDraft("chat-p").queue).toHaveLength(0);
  });

  it("queues the wrap-up at the crossing when he is away, and Stay here takes it back", () => {
    resetHandoff();
    noteFill("chat-a", 60, 100, true);
    expect(handoff.stage).toBe("idle");
    noteFill("chat-a", 72, 100, true);
    expect(handoff.stage).toBe("due");
    const q = readDraft("chat-a").queue;
    expect(q).toHaveLength(1);
    expect(q[0].id).toBe(handoff.queuedId);
    expect(q[0].text).toBe(message("chat-a"));
    // A later reading, still away, queues nothing more.
    noteFill("chat-a", 80, 100, true);
    expect(readDraft("chat-a").queue).toHaveLength(1);
    stayHere();
    expect(handoff.stage).toBe("idle");
    expect(handoff.dismissedAt).toBe(0.8);
    expect(readDraft("chat-a").queue).toHaveLength(0);
    // The re-ask crossing, away: the notice only (blocker 121's default).
    noteFill("chat-a", 0.9 * 100, 100, true);
    expect(handoff.stage).toBe("due");
    expect(readDraft("chat-a").queue).toHaveLength(0);
  });

  it("keeps the start prompt out of the wrap-up's reply at its turn's end, and not from a mid-turn reading", () => {
    resetHandoff();
    noteFill("chat-w", 75, 100, false);
    beginWrapUp("chat-w");
    expect(handoff.stage).toBe("wrapping");
    // The reading a usage event triggers while the wrap-up's turn runs.
    noteFill("chat-w", 78, 100, false);
    expect(handoff.stage).toBe("wrapping");
    noteAgentTurnEnd("chat-w", 80, 100, reply("Done.\n```start-prompt\nRead HANDOFF.md, then src/a.ts.\n```"));
    expect(handoff.stage).toBe("wrapped");
    expect(handoff.startPrompt).toBe("Read HANDOFF.md, then src/a.ts.");
  });

  it("keeps a chat's wrapped stage and start prompt across a reading for another chat (backlog 137)", () => {
    resetHandoff();
    noteFill("chat-x", 75, 100, false);
    beginWrapUp("chat-x");
    noteAgentTurnEnd("chat-x", 80, 100, reply("```start-prompt\nRead HANDOFF.md.\n```"));
    expect(handoff.stage).toBe("wrapped");
    // He opens chat Y to check something; its turn ends at a low fill.
    noteAgentTurnEnd("chat-y", 10, 100, reply("fine"));
    expect(handoff.chat).toBe("chat-y");
    expect(handoff.stage).toBe("idle");
    expect(handoff.startPrompt).toBeNull();
    // Back on X: still wrapped, the start prompt still found — no second
    // wrap-up is asked for, and nothing is queued while he is away.
    noteAgentTurnEnd("chat-x", 82, 100, reply("more"));
    expect(handoff.stage).toBe("wrapped");
    expect(handoff.startPrompt).toBe("Read HANDOFF.md.");
    expect(readDraft("chat-x").queue).toHaveLength(0);
    // Stay here on Y is Y's alone.
    noteFill("chat-y", 75, 100, false);
    expect(handoff.stage).toBe("due");
    stayHere();
    expect(handoff.dismissedAt).toBe(0.75);
    noteFill("chat-x", 82, 100, false);
    expect(handoff.stage).toBe("wrapped");
    expect(handoff.dismissedAt).toBe(0);
  });

  it("leaves the start prompt null when the reply has no block, and a failed wrap-up returns to the notice", () => {
    resetHandoff();
    noteFill("chat-n", 75, 100, false);
    beginWrapUp("chat-n");
    noteAgentTurnEnd("chat-n", 80, 100, reply("Handoff written."));
    expect(handoff.stage).toBe("wrapped");
    expect(handoff.startPrompt).toBeNull();
    abortWrapUp("chat-n");
    expect(handoff.stage).toBe("due");
  });

  it("puts the notice away when the chat's mark is raised above the fill, without counting as Stay here", () => {
    resetHandoff();
    noteFill("chat-r", 72, 100, true);
    expect(handoff.stage).toBe("due");
    expect(readDraft("chat-r").queue).toHaveLength(1);
    setThreshold("chat-r", 0.8);
    reconsider("chat-r");
    expect(handoff.stage).toBe("idle");
    expect(handoff.dismissedAt).toBe(0);
    expect(readDraft("chat-r").queue).toHaveLength(0);
    // Past the new mark it asks again, and queues again since nothing was dismissed.
    noteFill("chat-r", 81, 100, true);
    expect(handoff.stage).toBe("due");
    expect(readDraft("chat-r").queue).toHaveLength(1);
    setThreshold("chat-r", 0);
    expect(threshold("chat-r")).toBe(threshold(null));
  });

  it("counts a recent keystroke as present", () => {
    resetHandoff();
    noteActivity(Date.now());
    noteAgentTurnEnd("chat-k", 75, 100, reply("x"));
    expect(handoff.stage).toBe("due");
    expect(readDraft("chat-k").queue).toHaveLength(0);
  });
});

describe("the message, global and per chat", () => {
  it("falls back from the chat's own text to the Settings default to the built-in", () => {
    setDefaultMessage(WRAP_UP);
    expect(defaultMessage()).toBe(WRAP_UP);
    expect(message("chat-m")).toBe(WRAP_UP);
    setDefaultMessage("Wrap it up, my way.");
    expect(message("chat-m")).toBe("Wrap it up, my way.");
    setMessage("chat-m", "This chat's own.");
    expect(hasOwnMessage("chat-m")).toBe(true);
    expect(message("chat-m")).toBe("This chat's own.");
    expect(message("chat-other")).toBe("Wrap it up, my way.");
    // Typing the default back clears the chat's own; the built-in clears Settings'.
    setMessage("chat-m", "Wrap it up, my way.");
    expect(hasOwnMessage("chat-m")).toBe(false);
    setDefaultMessage("");
    expect(defaultMessage()).toBe("");
    setDefaultMessage(WRAP_UP);
    expect(message("chat-m")).toBe(WRAP_UP);
  });

  it("never queues a blank wrap-up", () => {
    resetHandoff();
    setMessage("chat-b", "");
    noteFill("chat-b", 75, 100, true);
    expect(handoff.stage).toBe("due");
    expect(readDraft("chat-b").queue).toHaveLength(0);
    setMessage("chat-b", WRAP_UP);
  });
});
