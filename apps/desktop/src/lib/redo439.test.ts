import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "./types";

// As in retry.test.ts: the one outside call is `sendEdit`, stubbed.
const sent: unknown[][] = [];
vi.mock("./state.svelte", async (orig) => {
  const actual = await orig<typeof import("./state.svelte")>();
  return {
    ...actual,
    sendEdit: vi.fn(async (...args: unknown[]) => {
      sent.push(args.slice(0, 4));
      const onForked = args[4] as ((p: string | null, f: string) => void) | null;
      const parent = actual.app.activeSessionId;
      actual.app.activeSessionId = "fork1";
      onForked?.(parent, "fork1");
      return true;
    }),
  };
});

import { app } from "./state.svelte";
import { drafts, readDraft, setDraftText } from "./drafts.svelte";
import { endsTurn, redoOf } from "./retry";
import { retryReply } from "./retry.svelte";
import transcriptSrc from "./Transcript.svelte?raw";
import messageSrc from "./AssistantMessage.svelte?raw";

/**
 * Item 439 (2026-10-27, his words: "why is there no like redo button like
 * there is in claude there's jus rewind which puts it back into the message
 * bar"): Redo in the icon row under his last message, beside Rewind —
 * Claude answers the same message again with no retyping. It is item 333's
 * Retry (a fork before the message, the message sent again; the old reply
 * a version away), which sat as a word in the reply's footer.
 */
type It = { kind: "user" | "assistant" | "compaction"; superseded: boolean; removed?: boolean; index: number };
const item = (kind: It["kind"], index: number, over: Partial<It> = {}): It => ({ kind, superseded: false, index, ...over });

describe("redoOf: which message carries Redo, and which reply it redoes", () => {
  it("the last message, and the reply that ends its turn", () => {
    const items = [item("user", 1), item("assistant", 2), item("user", 4), item("assistant", 5), item("assistant", 6)];
    expect(redoOf(items, endsTurn(items))).toEqual({ prompt: 4, reply: 6 });
  });
  it("none while the last message has no reply standing", () => {
    const pending = [item("user", 1), item("assistant", 2), item("user", 4)];
    expect(redoOf(pending, endsTurn(pending))).toBeNull();
    const removed = [item("user", 1), item("assistant", 2, { removed: true })];
    expect(redoOf(removed, endsTurn(removed))).toBeNull();
    expect(redoOf([], [])).toBeNull();
  });
  it("skips a rewound last exchange: the message still standing carries it", () => {
    const items = [item("user", 1), item("assistant", 2), item("user", 4, { superseded: true }), item("assistant", 5, { superseded: true })];
    expect(redoOf(items, endsTurn(items))).toEqual({ prompt: 1, reply: 2 });
  });
});

const at = "2026-10-27T00:00:00Z";
const log: SessionEvent[] = [
  { event: "session_created", id: "s", at },
  { event: "user_message", text: "what is 2.9% of 97.1%?", at },
  { event: "assistant_message", model: "m", blocks: [{ type: "text", text: "old answer" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, at },
];

describe("Redo runs the same message again, no retyping, the draft kept", () => {
  beforeEach(() => {
    sent.length = 0;
    for (const k of Object.keys(drafts)) delete drafts[k];
    app.busy = false;
    app.activeSessionId = "chat1";
    app.events = log;
  });
  it("sends his message unchanged, and a half-typed draft follows him", async () => {
    setDraftText("chat1", "a thought half typed");
    const items = [item("user", 1), item("assistant", 2)];
    const r = redoOf(items, endsTurn(items))!;
    expect(await retryReply(r.reply)).toBe(true);
    expect(sent).toEqual([[1, "what is 2.9% of 97.1%?", [], []]]);
    expect(readDraft("fork1").text).toBe("a thought half typed");
  });
});

describe("the markup", () => {
  it("Redo sits in his message's icon row, beside Rewind, calling the same action", () => {
    const rewind = transcriptSrc.indexOf('aria-label="Rewind to here"');
    const redo = transcriptSrc.indexOf('aria-label="Redo the reply to this message"');
    const edit = transcriptSrc.indexOf('aria-label="Edit this message"', rewind);
    expect(rewind).toBeGreaterThan(0);
    expect(redo).toBeGreaterThan(rewind);
    expect(redo).toBeLessThan(edit);
    expect(transcriptSrc).toContain("onclick={() => void retryReply(redo.reply)}");
  });
  it("the reply footer's button says Redo too", () => {
    expect(messageSrc).toContain('aria-label="Redo this reply"');
    expect(messageSrc).toMatch(/<Icon name="refresh" size=\{12\} \/> Redo/);
  });
});
