import { describe, expect, it } from "vitest";
import {
  SseParser,
  backoffMs,
  cardKind,
  draftKey,
  emptyTurn,
  foldTurnEvent,
  liveFlags,
  loadDraft,
  loadQueue,
  newQueued,
  parseSendReply,
  questionAnswer,
  saveDraft,
  saveQueue,
  shortWhen,
  toolSummary,
  tokenFromHash,
  transcriptRows,
  editAction,
  fitSize,
  hasFeature,
  imageFromDataUrl,
  markers,
  rowRemoval,
  rowTarget,
  sendBody,
  sinceText,
  usageLine,
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

describe("drafts per chat (item 246)", () => {
  it("keeps each chat's text apart and forgets an emptied one", () => {
    const a = draftKey("chat-a", "p1");
    const fresh = draftKey(null, "p1");
    expect(fresh).toBe("new:p1");
    saveDraft(a, "half a thought");
    saveDraft(fresh, "for a new chat");
    expect(loadDraft(a)).toBe("half a thought");
    expect(loadDraft(fresh)).toBe("for a new chat");
    expect(loadDraft("chat-b")).toBe("");
    saveDraft(a, "  ");
    expect(loadDraft(a)).toBe("");
    expect(loadDraft(fresh)).toBe("for a new chat");
  });
});

describe("the short time", () => {
  const now = new Date(2026, 8, 27, 18, 0);
  it("is 12-hour today, then Yesterday, a weekday, a date", () => {
    expect(shortWhen(new Date(2026, 8, 27, 16, 5).toISOString(), now)).toBe("4:05 PM");
    expect(shortWhen(new Date(2026, 8, 26, 9, 0).toISOString(), now)).toBe("Yesterday");
    expect(shortWhen(new Date(2026, 8, 23, 9, 0).toISOString(), now)).toBe("Wednesday");
    expect(shortWhen(new Date(2026, 8, 11, 9, 0).toISOString(), now)).toBe("Sep 11");
    expect(shortWhen("nonsense", now)).toBe("");
  });
});

describe("wave 1: the message menu over the log", () => {
  const at = "2026-09-30T10:00:00Z";
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
  const log = (): SessionEvent[] => [
    { event: "session_created", id: "abc", at },
    { event: "user_message", text: "hi", at, images: [{ media_type: "image/jpeg", data: "AA" }] },
    reply("t1", "one"),
    { event: "tool_result", tool_use_id: "t1", name: "Bash", content: "", is_error: false, at },
    reply("t2", "two"),
    { event: "user_message", text: "again", at },
    reply("t3", "three"),
  ];

  it("gives each row the log indexes an action names", () => {
    const rows = transcriptRows(log());
    expect(rows[0]).toMatchObject({ kind: "user", index: 1, images: 1, removed: false, edited: false });
    expect(rows[1].kind === "assistant" && rows[1].indexes).toEqual([2, 4]);
    expect(rows[1].kind === "assistant" && rows[1].parts.map((p) => [p.index, p.block])).toEqual([[2, 0], [4, 0]]);
    expect(rows[1].kind === "assistant" && rows[1].tools.map((t) => [t.index, t.block])).toEqual([[2, 1], [4, 1]]);
  });

  it("draws edits and removals the way the desktop's markers read", () => {
    const events = log();
    events.push(
      { event: "edit", target: 1, text: "hello", at },
      { event: "edit", target: 2, block: 0, text: "uno", at },
      { event: "elide", targets: [4], block: 1, at },
      { event: "elide", targets: [5], at },
    );
    const rows = transcriptRows(events);
    expect(rows[0]).toMatchObject({ text: "hello", edited: true });
    const r = rows[1];
    expect(r.kind === "assistant" && r.text).toBe("uno\n\ntwo");
    expect(r.kind === "assistant" && r.tools.map((t) => !!t.removed)).toEqual([false, true]);
    expect(rows[2]).toMatchObject({ kind: "user", removed: true });
    // A restore lifts the removal; the last word on an index wins.
    events.push({ event: "unelide", targets: [5], at });
    expect(transcriptRows(events)[2]).toMatchObject({ removed: false });
    // A removed text block leaves the joined text and is kept as a part.
    events.push({ event: "elide", targets: [2], block: 0, at });
    const r2 = transcriptRows(events)[1];
    expect(r2.kind === "assistant" && r2.text).toBe("two");
    expect(r2.kind === "assistant" && r2.parts[0].removed).toBe(true);
  });

  it("reads an edit without a block as the reply's first text block", () => {
    const events = log();
    events.push({ event: "edit", target: 6, text: "tres", at });
    expect(markers(events).blockText.get(6)?.get(0)).toBe("tres");
  });

  it("ignores markers a rewind superseded", () => {
    const events = log();
    events.push({ event: "elide", targets: [1], at }, { event: "rewind", to: 7, at });
    expect(transcriptRows(events)[0]).toMatchObject({ removed: false });
  });

  it("points Rewind and Fork at the right user turn", () => {
    const events = log();
    const rows = transcriptRows(events);
    expect(rowTarget(events, rows[0])).toEqual({ rewind: 1, fork: 1 });
    // A reply: what follows it goes, the reply stays.
    expect(rowTarget(events, rows[1])).toEqual({ rewind: 5, fork: 5 });
    // The last reply: nothing after it to rewind; a fork takes it all.
    expect(rowTarget(events, rows[3])).toEqual({ rewind: null, fork: events.length });
  });

  it("removes a joined reply event by event", () => {
    const rows = transcriptRows(log());
    expect(rowRemoval(rows[1], false)).toEqual([{ op: "remove", index: 2 }, { op: "remove", index: 4 }]);
    expect(rowRemoval(rows[0], true)).toEqual([{ op: "restore", index: 1 }]);
  });

  it("builds §4's payloads", () => {
    expect(editAction(3, "new", "send")).toEqual({ op: "edit", index: 3, text: "new", mode: "send", block: null });
    expect(editAction(4, "t", "save", 2)).toEqual({ op: "edit", index: 4, text: "t", mode: "save", block: 2 });
    expect(sendBody("hi")).toEqual({ text: "hi" });
    expect(sendBody("hi", { project: "p", images: [{ media_type: "image/jpeg", data: "AA" }] })).toEqual({
      text: "hi",
      project: "p",
      images: [{ media_type: "image/jpeg", data: "AA" }],
    });
    expect(sendBody("hi", { project: null, images: [] })).toEqual({ text: "hi" });
  });

  it("reads features, absent on a pass-1 listener", () => {
    const base = { project: null, active_chat: null, busy: false, connected: true, engine: null, pending: [] };
    expect(hasFeature(base, "act")).toBe(false);
    expect(hasFeature({ ...base, features: ["act", "rail"] }, "rail")).toBe(true);
  });
});

describe("wave 1: photos, usage, running", () => {
  it("scales a photo's long edge down, never up", () => {
    expect(fitSize(4032, 3024)).toEqual({ w: 1568, h: 1176 });
    expect(fitSize(3024, 4032)).toEqual({ w: 1176, h: 1568 });
    expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitSize(0, 10)).toEqual({ w: 0, h: 0 });
  });

  it("reads a data URL into an ImageInput", () => {
    expect(imageFromDataUrl("data:image/jpeg;base64,QUJD")).toEqual({ media_type: "image/jpeg", data: "QUJD" });
    expect(imageFromDataUrl("data:text/plain;base64,QUJD")).toBeNull();
  });

  it("writes the plan line", () => {
    expect(usageLine(null)).toBe("");
    const resets = new Date(2026, 8, 30, 4, 10).toISOString();
    const plan = { five_hour: 41.6, seven_day: 61, five_hour_resets_at: resets, seven_day_resets_at: null, stale: false };
    expect(usageLine({ plan })).toBe("5-hour 42% · resets 4:10 AM · week 61%");
    expect(usageLine({ plan: { ...plan, five_hour: null } })).toBe("week 61%");
    expect(usageLine({ plan: { ...plan, five_hour: null, stale: true } })).toBe("week 61% · an old reading");
    expect(usageLine({ plan: { ...plan, five_hour: null, seven_day: null } })).toBe("");
  });

  it("says how long a task has run", () => {
    const now = new Date(2026, 8, 30, 5, 0);
    expect(sinceText(new Date(2026, 8, 30, 4, 59, 40).toISOString(), now)).toBe("just now");
    expect(sinceText(new Date(2026, 8, 30, 4, 56).toISOString(), now)).toBe("4 min");
    expect(sinceText(new Date(2026, 8, 30, 2, 55).toISOString(), now)).toBe("2 h 5 min");
    expect(sinceText(new Date(2026, 8, 30, 3, 0).toISOString(), now)).toBe("2 h");
    // The Mac sends unix milliseconds.
    expect(sinceText(new Date(2026, 8, 30, 4, 56).getTime(), now)).toBe("4 min");
    expect(sinceText(null, now)).toBe("");
  });
});
