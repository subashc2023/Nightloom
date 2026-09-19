import { describe, expect, it } from "vitest";
import {
  SseParser,
  backoffMs,
  cardKind,
  emptyTurn,
  foldTurnEvent,
  liveFlags,
  loadQueue,
  newQueued,
  parseSendReply,
  questionAnswer,
  saveQueue,
  toolSummary,
  tokenFromHash,
  transcriptRows,
} from "./client";
import type { SessionEvent, TurnEvent } from "../lib/types";

describe("the token from the QR's link", () => {
  it("reads #token= and nothing else", () => {
    expect(tokenFromHash("#token=0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(tokenFromHash("#x=1&token=ABCDEF0123456789")).toBe("abcdef0123456789");
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#token=")).toBeNull();
    expect(tokenFromHash("#token=not-hex-at-all")).toBeNull();
  });
});

describe("the event stream's parser", () => {
  it("splits events across chunks, joins data lines, skips comments", () => {
    const p = new SseParser();
    expect(p.push("event: hello\ndata: {}\n\n: keep-alive\n\nevent: turn-ev")).toEqual([
      { name: "hello", data: "{}" },
    ]);
    expect(p.push('ent\ndata: {"type":"text_delta",\ndata: "text":"hi"}\n\n')).toEqual([
      { name: "turn-event", data: '{"type":"text_delta",\n"text":"hi"}' },
    ]);
    expect(p.push("")).toEqual([]);
  });

  it("takes CRLF too", () => {
    const p = new SseParser();
    expect(p.push("event: lagged\r\ndata: 3\r\n\r\n")).toEqual([{ name: "lagged", data: "3" }]);
  });
});

describe("the live turn's fold", () => {
  it("accumulates text, rows tool calls, marks results, nests subagents", () => {
    let live = emptyTurn();
    const evs: TurnEvent[] = [
      { type: "text_delta", text: "Let me " },
      { type: "text_delta", text: "look." },
      { type: "tool_call", id: "t1", name: "Bash", input: { command: "ls   -la" } },
      { type: "tool_call", id: "a1", name: "Agent", input: { description: "scan the repo" } },
      { type: "subagent", parent_tool_use_id: "a1", event: { type: "tool_call", id: "s1", name: "Grep", input: { pattern: "foo" } } },
      { type: "subagent", parent_tool_use_id: "a1", event: { type: "tool_result", tool_use_id: "s1", name: "Grep", content: "", is_error: false } },
      { type: "tool_result", tool_use_id: "t1", name: "Bash", content: "", is_error: true },
      { type: "thinking_delta", text: "ignored" },
      { type: "compacted", summary: "…" },
    ];
    for (const e of evs) live = foldTurnEvent(live, e);
    expect(live.text).toBe("Let me look.");
    expect(live.tools.map((t) => [t.name, t.summary, t.ok])).toEqual([
      ["Bash", "ls -la", false],
      ["Agent", "scan the repo", null],
    ]);
    expect(live.tools[1].children.map((t) => [t.name, t.ok])).toEqual([["Grep", true]]);
    expect(live.compacted).toBe(true);
  });

  it("summarises a call's input by the tool, capped at one line", () => {
    expect(toolSummary("Read", { file_path: "/a/b.rs" })).toBe("/a/b.rs");
    expect(toolSummary("WebSearch", { query: "x" })).toBe("x");
    expect(toolSummary("Bash", { command: "a".repeat(200) })).toHaveLength(118);
    expect(toolSummary("Bash", null)).toBe("");
  });
});

describe("the transcript's rows", () => {
  const at = "2026-09-16T00:00:00Z";
  const reply = (id: string, text: string): SessionEvent => ({
    event: "assistant_message",
    model: "m",
    blocks: [
      { type: "text", text },
      { type: "tool_use", id, name: "Bash", input: { command: "true" } },
    ],
    stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 0 } as never,
    at,
  });

  it("draws user and reply rows, matches results, honours a rewind and its lift", () => {
    const events: SessionEvent[] = [
      { event: "session_created", id: "abc", at },
      { event: "user_message", text: "hi", at },
      reply("t1", "one"),
      { event: "tool_result", tool_use_id: "t1", name: "Bash", content: "", is_error: false, at },
      { event: "user_message", text: "again", at },
      reply("t2", "two"),
      { event: "rewind", to: 4, at },
    ];
    expect(liveFlags(events)).toEqual([true, true, true, true, false, false, false]);
    let rows = transcriptRows(events);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant"]);
    expect(rows[1].kind === "assistant" && rows[1].tools[0].ok).toBe(true);
    // Lifted: the two rows come back.
    events.push({ event: "unrewind", of: 6, at });
    rows = transcriptRows(events);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("joins consecutive replies into one row", () => {
    const events: SessionEvent[] = [{ event: "user_message", text: "hi", at }, reply("t1", "one"), reply("t2", "two")];
    const rows = transcriptRows(events);
    expect(rows).toHaveLength(2);
    expect(rows[1].kind === "assistant" && rows[1].text).toBe("one\n\ntwo");
    expect(rows[1].kind === "assistant" && rows[1].tools.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});

describe("the queue", () => {
  it("round-trips through storage and drops blanks", () => {
    saveQueue([newQueued("abc", "later"), newQueued(null, "   ")]);
    const q = loadQueue();
    expect(q.map((m) => [m.chat, m.text])).toEqual([["abc", "later"]]);
    saveQueue([]);
    expect(loadQueue()).toEqual([]);
  });
});

describe("the cards", () => {
  it("names the card by the tool", () => {
    expect(cardKind({ id: "1", name: "AskUserQuestion", input: {}, effect: "read" as never })).toBe("question");
    expect(cardKind({ id: "1", name: "ExitPlanMode", input: {}, effect: "read" as never })).toBe("plan");
    expect(cardKind({ id: "1", name: "Bash", input: {}, effect: "read" as never })).toBe("call");
  });

  it("answers a question form the way the desktop does", () => {
    const input = { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }, { question: "Why?", options: [] }] };
    expect(questionAnswer(input, { 0: ["A", "B"] }, { 1: "because" })).toEqual({
      ...input,
      answers: { "Which?": "A, B", "Why?": "because" },
    });
  });
});

describe("the reconnect wait", () => {
  it("doubles from a second and caps at fifteen", () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });
});

describe("the 202's body (backlog 132)", () => {
  it("reads queued, sent, and an older listener's empty body", () => {
    expect(parseSendReply('{"status":"queued"}')).toBe("queued");
    expect(parseSendReply('{"status":"sent"}')).toBe("sent");
    expect(parseSendReply("")).toBe("sent");
    expect(parseSendReply("not json")).toBe("sent");
  });
});
