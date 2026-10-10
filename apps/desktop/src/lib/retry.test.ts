import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "./types";

// The action's one outside call is `sendEdit` (the fork + send, backlog
// 062): stubbed to do what it does to the open chat and call back.
const sent: unknown[][] = [];
vi.mock("./state.svelte", async (orig) => {
  const actual = await orig<typeof import("./state.svelte")>();
  return {
    ...actual,
    sendEdit: vi.fn(async (...args: unknown[]) => {
      sent.push(args.slice(0, 4));
      // The fork request is a round trip: a second press lands during it.
      await Promise.resolve();
      const onForked = args[4] as ((p: string | null, f: string) => void) | null;
      const parent = actual.app.activeSessionId;
      actual.app.activeSessionId = "fork1";
      onForked?.(parent, "fork1");
      return true;
    }),
  };
});

import { app } from "./state.svelte";
import { drafts, enqueueMessage, readDraft, setDraftText, addAttachment, removeAttachment, updateAttachment } from "./drafts.svelte";
import { endsTurn, retryPrompt } from "./retry";
import { retryReply } from "./retry.svelte";

const at = "2026-10-09T00:00:00Z";
const user = (text: string, extra: object = {}): SessionEvent => ({ event: "user_message", text, at, ...extra });
const reply = (text: string): SessionEvent => ({
  event: "assistant_message",
  model: "m",
  blocks: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
  at,
});
const img = { media_type: "image/png", data: "AAAA" } as never;

// 0 created, 1 user, 2 reply, 3 reply (same turn), 4 user with an image, 5 reply.
const log: SessionEvent[] = [
  { event: "session_created", id: "s", at },
  user("first"),
  reply("one"),
  reply("one, after a call"),
  user("second", { images: [img] }),
  reply("two"),
];

describe("retryPrompt", () => {
  it("finds the prompt a reply answered, with its attachments", () => {
    expect(retryPrompt(log, 5)).toEqual({ index: 4, text: "second", images: [img], documents: [] });
    expect(retryPrompt(log, 3)?.index).toBe(1);
    expect(retryPrompt(log, 2)?.index).toBe(1);
  });

  it("sends the prompt as it reads now: its latest edit", () => {
    const edited = [...log, { event: "edit", target: 4, text: "second, reworded", at } as SessionEvent];
    expect(retryPrompt(edited, 5)?.text).toBe("second, reworded");
  });

  it("is null for a non-reply, a rewound reply, or a reply with no prompt before it", () => {
    expect(retryPrompt(log, 4)).toBeNull();
    const rewound = [...log, { event: "rewind", to: 4, at } as SessionEvent];
    expect(retryPrompt(rewound, 5)).toBeNull();
    expect(retryPrompt(rewound, 3)?.index).toBe(1);
    expect(retryPrompt([{ event: "session_created", id: "s", at }, reply("carried")], 1)).toBeNull();
  });
});

describe("endsTurn", () => {
  const it_ = (kind: "user" | "assistant" | "compaction", superseded = false) => ({ kind, superseded });
  it("marks only the last reply of each turn", () => {
    expect(endsTurn([it_("user"), it_("assistant"), it_("assistant"), it_("user"), it_("assistant")])).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
  });
  it("skips rewound turns when looking at what follows", () => {
    expect(endsTurn([it_("user"), it_("assistant"), it_("assistant", true), it_("user", true)])).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect(endsTurn([it_("assistant"), it_("compaction"), it_("assistant")])).toEqual([true, false, true]);
  });
});

describe("retryReply", () => {
  beforeEach(() => {
    sent.length = 0;
    for (const k of Object.keys(drafts)) delete drafts[k];
    app.busy = false;
    app.activeSessionId = "chat1";
    app.events = log;
  });

  it("forks before the prompt and sends it unchanged", async () => {
    expect(await retryReply(5)).toBe(true);
    expect(sent).toEqual([[4, "second", [img], []]]);
  });

  it("carries a half-typed draft into the fork; held messages stay", async () => {
    setDraftText("chat1", "half-typed");
    addAttachment("chat1", { id: 1, kind: "image", name: "a.png" } as never);
    enqueueMessage("chat1", "held", []);
    await retryReply(5);
    expect(readDraft("fork1").text).toBe("half-typed");
    expect(readDraft("fork1").attachments).toHaveLength(1);
    expect(readDraft("chat1").text).toBe("");
    expect(readDraft("chat1").queue.map((q) => q.text)).toEqual(["held"]);
  });

  it("a chip still converting finishes (or fails) in the fork it was carried to", async () => {
    addAttachment("chat1", { id: 7, kind: "document", name: "a.docx", data: "", pending: true } as never);
    addAttachment("chat1", { id: 8, kind: "document", name: "b.pptx", data: "", pending: true } as never);
    await retryReply(5);
    // The conversion reports under the key it was dropped in.
    expect(updateAttachment("chat1", 7, { data: "QUJD", pending: false })).toBe(true);
    removeAttachment("chat1", 8);
    expect(readDraft("fork1").attachments).toEqual([
      expect.objectContaining({ id: 7, data: "QUJD", pending: false }),
    ]);
  });

  it("appends to what the fork's box already holds rather than replace it", async () => {
    setDraftText("chat1", "mine");
    setDraftText("fork1", "there already");
    await retryReply(2);
    expect(readDraft("fork1").text).toBe("there already\nmine");
  });

  it("forks once when pressed twice before the fork comes back", async () => {
    const [a, b] = await Promise.all([retryReply(5), retryReply(5)]);
    expect([a, b]).toEqual([true, false]);
    expect(sent).toHaveLength(1);
    // Once the fork is open, Retry works again.
    expect(await retryReply(5)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("does nothing mid-turn", async () => {
    app.busy = true;
    expect(await retryReply(5)).toBe(false);
    expect(sent).toEqual([]);
  });
});
