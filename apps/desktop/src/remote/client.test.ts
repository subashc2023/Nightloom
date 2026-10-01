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
  newNonce,
  newQueued,
  nonceFor,
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
  councilProblem,
  damp,
  dismissVerdict,
  foldAside,
  loadNoteDraft,
  noteDraftKey,
  noteDraftKeys,
  noteFileName,
  noteNameProblem,
  notePath,
  noteTitle,
  parseAsideEvent,
  pastAsides,
  saveNoteDraft,
  searchGroupLabel,
  searchSummary,
  swipeVerdict,
  PULL_AT,
  type Aside,
  type SearchResult,
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

describe("a message's tries (wave 4 C1)", () => {
  it("a fresh nonce is 32 hex digits, and two differ", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });

  it("the same message again keeps its nonce; another message gets a new one", () => {
    const first = nonceFor(null, "send:c1\nhello");
    expect(nonceFor(first, "send:c1\nhello")).toBe(first);
    const other = nonceFor(first, "send:c1\nhello again");
    expect(other.nonce).not.toBe(first.nonce);
  });

  it("rides in the send body only when given, and a held message keeps its try's", () => {
    expect(sendBody("hi", { nonce: "n-1" })).toEqual({ text: "hi", nonce: "n-1" });
    expect(sendBody("hi", { nonce: "" })).toEqual({ text: "hi" });
    expect(newQueued("c1", "later", new Date(), null, null, "n-2").nonce).toBe("n-2");
    expect(newQueued("c1", "later").nonce).toMatch(/^[0-9a-f]{32}$/);
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

// ---- wave 2C -------------------------------------------------------------------

describe("a council send (wave 2C)", () => {
  it("carries the council with its areas, and leaves it out otherwise", () => {
    const council = { seats: [{ model: "opus" }, { model: "sonnet" }], mode: "disproof" as const };
    expect(sendBody("idea", { council })).toEqual({ text: "idea", council: { ...council, areas: [] } });
    expect(sendBody("idea", { council: null })).toEqual({ text: "idea" });
  });

  it("refuses a council the listener would refuse", () => {
    expect(councilProblem([{ model: "opus" }])).toMatch(/at least 2/);
    expect(councilProblem([{ model: "opus" }, { model: "haiku" }])).toBeNull();
    expect(councilProblem(Array.from({ length: 7 }, () => ({ model: "opus" })))).toMatch(/at most 6/);
    expect(councilProblem([{ model: "opus" }, { model: "x", engine: "api" }])).toMatch(/API/);
  });
});

describe("notes (wave 2C)", () => {
  it("addresses a note by segments, keeping its slashes", () => {
    expect(notePath("project", "design/phone page.md")).toBe("/notes/project/design/phone%20page.md");
    expect(notePath("memory", "AGENTS.md")).toBe("/notes/memory/AGENTS.md");
  });

  it("names a new note as the listener takes it", () => {
    expect(noteNameProblem("  ")).toMatch(/needs a name/);
    expect(noteNameProblem("a//b")).toMatch(/empty/);
    expect(noteNameProblem("../up")).toMatch(/\.\./);
    expect(noteNameProblem("ideas/phone")).toBeNull();
    expect(noteFileName(" Phone ideas ")).toBe("Phone ideas.md");
    expect(noteFileName("ideas / phone")).toBe("ideas/phone.md");
    expect(noteFileName("list.txt")).toBe("list.txt");
    expect(noteTitle("design/phone page.md")).toBe("phone page");
  });

  it("keeps an edit's draft until it is saved or discarded", () => {
    localStorage.clear();
    const key = noteDraftKey("project", "a.md");
    expect(key).toBe("project/a.md");
    expect(noteDraftKey("knowledge", null)).toBe("new:knowledge");
    saveNoteDraft(key, { text: "half typed", base: "old" });
    expect(loadNoteDraft(key)).toEqual({ text: "half typed", base: "old" });
    expect(noteDraftKeys()).toEqual([key]);
    // Typed back to the note's own text: nothing to keep.
    saveNoteDraft(key, { text: "old", base: "old" });
    expect(loadNoteDraft(key)).toBeNull();
    // A new note with only a name is still a draft.
    saveNoteDraft("new:project", { text: "", base: "", name: "Ideas" });
    expect(loadNoteDraft("new:project")?.name).toBe("Ideas");
    saveNoteDraft("new:project", null);
    expect(noteDraftKeys()).toEqual([]);
  });
});

describe("search (wave 2C)", () => {
  const group = (over: object) => ({ id: "c1", hits: 1, rows: [], ...over });
  it("labels a hit's chat by its name, else its first line", () => {
    expect(searchGroupLabel(group({ title: "Tab drag", first_user: "why" }))).toBe("Tab drag");
    expect(searchGroupLabel(group({ title: null, first_user: "why does\nthe tab" }))).toBe("why does the tab");
    expect(searchGroupLabel(group({}))).toBe("Untitled chat");
  });

  it("counts what it found", () => {
    const r = (m: number, g: number, n: number): SearchResult => ({
      matches: m,
      messages: m,
      chats: g,
      shown: m,
      elapsed_ms: 3,
      groups: Array.from({ length: g }, (_, i) => group({ id: `c${i}` })) as SearchResult["groups"],
      notes: Array.from({ length: n }, (_, i) => ({ scope: "project", name: `n${i}`, modified: "", hits: 1, rows: [] })),
    });
    expect(searchSummary(null)).toBe("");
    expect(searchSummary(r(0, 0, 0))).toBe("No matches.");
    expect(searchSummary(r(14, 4, 2))).toBe("14 matches in 4 chats · 2 notes");
    expect(searchSummary(r(1, 1, 0))).toBe("1 match in 1 chat");
    expect(searchSummary(r(3, 0, 1))).toBe("3 matches · 1 note");
  });
});

describe("asides (wave 2C, 2A's shapes)", () => {
  const asking: Aside = { chat: "c1", seq: 4, thread: 3, question: "q", answer: "", state: "asking" };

  it("reads the stream's aside events, and the Mac's bare aside-delta", () => {
    expect(parseAsideEvent('{"kind":"delta","seq":4,"text":"Hi"}')).toEqual({ kind: "delta", seq: 4, text: "Hi" });
    expect(parseAsideEvent('{"seq":4,"text":"Hi"}')).toEqual({ kind: "delta", seq: 4, text: "Hi" });
    expect(parseAsideEvent('{"kind":"done","chat":"c1","thread":3,"seq":4,"answer":"All","error":null,"cancelled":false}')).toEqual({
      kind: "done",
      seq: 4,
      answer: "All",
      error: null,
      cancelled: false,
    });
    // 2A's current version: an error row, with what had arrived and whether it was a stop.
    expect(parseAsideEvent('{"kind":"error","chat":"c1","thread":3,"seq":4,"error":"the aside was cancelled","answer":"half","cancelled":true}')).toEqual({
      kind: "done",
      seq: 4,
      answer: "half",
      error: "the aside was cancelled",
      cancelled: true,
    });
    expect(parseAsideEvent('{"kind":"done","chat":"c1","seq":4,"answer":"A","is_error":false,"cost_usd":null}')).toMatchObject({ error: null, cancelled: false });
    expect(parseAsideEvent("not json")).toBeNull();
    expect(parseAsideEvent('{"kind":"delta","text":"no seq"}')).toBeNull();
    expect(parseAsideEvent('{"kind":"odd","seq":1}')).toBeNull();
  });

  it("folds its own exchange's events and no other's", () => {
    let a = foldAside(asking, { kind: "delta", seq: 4, text: "The " });
    a = foldAside(a, { kind: "delta", seq: 4, text: "answr" });
    expect(a.answer).toBe("The answr");
    // The Mac's own aside, or another phone's: untouched.
    expect(foldAside(a, { kind: "delta", seq: 5, text: "x" })).toBe(a);
    // The whole answer heals a lost delta.
    const done = foldAside(a, { kind: "done", seq: 4, answer: "The answer", error: null, cancelled: false });
    expect(done).toMatchObject({ state: "done", answer: "The answer" });
    expect(foldAside(done, { kind: "delta", seq: 4, text: "late" }).answer).toBe("The answer");
  });

  it("marks a failure with the Mac's sentence, and a stop keeps what arrived", () => {
    const failed = foldAside(asking, { kind: "done", seq: 4, answer: null, error: "no session yet", cancelled: false });
    expect(failed).toMatchObject({ state: "failed", error: "no session yet" });
    const part = foldAside(asking, { kind: "delta", seq: 4, text: "half" });
    expect(foldAside(part, { kind: "done", seq: 4, answer: "", error: null, cancelled: true })).toMatchObject({ state: "failed", answer: "half" });
  });

  it("lists earlier exchanges newest first, without the one on the card or any still asking", () => {
    const past = pastAsides(
      [
        { id: null, key: "k1", open: false, name: "Named", turns: [{ seq: null, question: "old", answer: "a0" }] },
        {
          id: 3,
          open: true,
          turns: [
            { seq: 1, question: "q1", answer: "a1" },
            { seq: 4, question: "q4", answer: "a4" },
            { seq: 5, question: "q5", answer: "", asking: true },
          ],
        },
      ],
      4,
    );
    expect(past.map((p) => p.question)).toEqual(["q1", "old"]);
    expect(past[1].thread).toBe("Named");
    expect(past[0].thread).toBe("Open card");
  });

  it("reads 2A's flat rows too (Past first, then the open cards')", () => {
    const past = pastAsides(
      [
        { seq: null, question: "old", answer: "a0", at: "2026-09-30T03:00:00Z", thread: null, key: "k1", open: false, name: "Named" },
        { seq: 4, question: "q4", answer: "a4", at: null, thread: 3, open: true },
        { seq: 5, question: "q5", answer: "", at: null, thread: 3, open: true, asking: true },
        { seq: 6, question: "q6", answer: "a6", at: null, thread: 3, open: true },
      ],
      4,
    );
    expect(past.map((p) => [p.question, p.thread])).toEqual([
      ["q6", "Open card"],
      ["old", "Named"],
    ]);
  });
});

describe("gestures (wave 2C)", () => {
  it("damps a pull past the mark", () => {
    expect(damp(-5)).toBe(0);
    expect(damp(40)).toBe(40);
    expect(damp(PULL_AT + 100)).toBeCloseTo(PULL_AT + 35);
  });

  it("opens the drawer only from the edge, and closes it by a swipe left", () => {
    expect(swipeVerdict(8, 80, 10, false)).toBe("open");
    expect(swipeVerdict(120, 80, 10, false)).toBeNull();
    expect(swipeVerdict(8, 30, 0, false)).toBeNull();
    // More down than across is a scroll.
    expect(swipeVerdict(8, 60, 80, false)).toBeNull();
    expect(swipeVerdict(200, -90, 12, true)).toBe("close");
    expect(swipeVerdict(200, 90, 12, true)).toBeNull();
  });

  it("dismisses a sheet past the mark or on a flick", () => {
    expect(dismissVerdict(140, 600)).toBe(true);
    expect(dismissVerdict(60, 50)).toBe(true);
    expect(dismissVerdict(60, 600)).toBe(false);
    expect(dismissVerdict(20, 10)).toBe(false);
  });
});

describe("wave 2: a council turn from the phone", () => {
  const at = "2026-09-30T11:40:00Z";
  it("keeps the chair's reply and folds the seats and the record into a note", () => {
    const rows = transcriptRows([
      { event: "session_created", id: "abc", at },
      { event: "user_message", text: "council question", at },
      {
        event: "assistant_message",
        model: "m",
        blocks: [
          { type: "text", text: "the chair" },
          { type: "text", text: '<council-seat label="B" model="opus">\nseat b\n</council-seat>' },
          { type: "text", text: '<council-seat label="A" model="sonnet">\nseat a\n</council-seat>' },
          { type: "text", text: '<council>\n{"mode":"answer"}\n</council>' },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 } as never,
        at,
      },
    ]);
    expect(rows[1]).toMatchObject({ kind: "assistant", text: "the chair" });
    expect((rows[1] as { parts: unknown[] }).parts).toHaveLength(1);
    expect(rows[2]).toMatchObject({ kind: "note", text: "council — 2 seats answered; their answers fold on the Mac" });
    expect(rows).toHaveLength(3);
  });
});

describe("a client per host (wave 3)", () => {
  // A generated test value.
  const T = "0123456789abcdef0123456789abcdef";
  it("calls its own host's address with its own token, the token never in the URL", async () => {
    const { Client } = await import("./client");
    const seen: { url: string; auth: string | null }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("Authorization") });
      return new Response(JSON.stringify({ host: "serve" }), { status: 200 });
    }) as typeof fetch;
    try {
      const st = await new Client(T, "https://nightloom-test.fly.dev").state();
      expect(st.host).toBe("serve");
      await new Client(T).state();
    } finally {
      globalThis.fetch = real;
    }
    expect(seen[0].url).toBe("https://nightloom-test.fly.dev/api/state");
    expect(seen[0].auth).toBe(`Bearer ${T}`);
    expect(seen[1].url).toBe("/api/state");
    expect(seen.every((s) => !s.url.includes(T))).toBe(true);
  });

  it("says which host could not be reached", async () => {
    const { Client, Unreachable } = await import("./client");
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("Load failed");
    }) as typeof fetch;
    try {
      await new Client(T, "http://100.101.102.103:8642").state();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Unreachable);
      expect((e as InstanceType<typeof Unreachable>).base).toBe("http://100.101.102.103:8642");
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("wave 3 B2: the missing buttons, the limit card, speak the reply", () => {
  const T = "0123456789abcdef0123456789abcdef";
  /** Each `act` call's path and body, through a stand-in fetch. */
  async function acted(run: (c: InstanceType<typeof import("./client").Client>) => Promise<unknown>) {
    const { Client } = await import("./client");
    const seen: { url: string; body: unknown }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ chat: "c1", events: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await run(new Client(T));
    } finally {
      globalThis.fetch = real;
    }
    return seen;
  }

  it("sends each new button's action through act, as the Mac's buttons run it", async () => {
    const { budgetAction, checkpointAction, resumeAction } = await import("./client");
    const seen = await acted(async (c) => {
      await c.act("c1", { op: "compact" });
      await c.act("c1", checkpointAction(7));
      await c.act("c1", budgetAction("continue"));
      await c.act("c1", budgetAction("wrap"));
      await c.act("c1", budgetAction("stop"));
      await c.act("c1", resumeAction(), "p-keep");
    });
    expect(seen.map((s) => s.body)).toEqual([
      { op: "compact" },
      { op: "checkpoint", index: 7 },
      { op: "budget", decision: "continue", text: null },
      { op: "budget", decision: "wrap", text: null },
      { op: "budget", decision: "stop", text: null },
      { op: "resume_limit" },
    ]);
    const { rowCheckpoint } = await import("./client");
    const rows = transcriptRows([
      { event: "user_message", text: "hi", at: "2026-09-30T10:00:00Z" },
      { event: "assistant_message", model: "m", at: "2026-09-30T10:00:00Z", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: null, blocks: [{ type: "text", text: "a" }] },
      { event: "assistant_message", model: "m", at: "2026-09-30T10:00:00Z", usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: null, blocks: [{ type: "text", text: "b" }] },
    ] as unknown as SessionEvent[]);
    expect(rowCheckpoint(rows[0])).toBe(0);
    expect(rowCheckpoint(rows[1])).toBe(2);
    expect(rowCheckpoint({ kind: "note", text: "x", at: "" })).toBe(null);
    expect(seen[0].url).toBe("/api/chats/c1/act");
    expect(seen[5].url).toBe("/api/chats/c1/act?project=p-keep");
  });

  it("greys an op serve does not name, and offers every op on a Mac that acts", async () => {
    const { canOp } = await import("./client");
    const mac = { project: null, active_chat: null, busy: false, connected: true, engine: null, pending: [], host: "mac" as const, features: ["act"] };
    expect(canOp(mac, "compact")).toBe(true);
    expect(canOp(mac, "budget")).toBe(true);
    expect(canOp({ ...mac, host: undefined }, "checkpoint")).toBe(true);
    expect(canOp({ ...mac, features: [] }, "compact")).toBe(false);
    const serve = { ...mac, host: "serve" as const, features: ["act", "resume_limit"] };
    expect(canOp(serve, "compact")).toBe(false);
    expect(canOp(serve, "resume_limit")).toBe(true);
  });

  it("reads the limit's reset in seconds, ms or ISO, and says the time in 12-hour", async () => {
    const { clock12, resetMs } = await import("./client");
    const at = new Date(2026, 8, 30, 3, 10).getTime();
    expect(resetMs(at / 1000)).toBe(at);
    expect(resetMs(at)).toBe(at);
    expect(resetMs(new Date(at).toISOString())).toBe(at);
    expect(resetMs(String(at / 1000))).toBe(at);
    expect(resetMs(null)).toBe(null);
    expect(resetMs("soon")).toBe(null);
    expect(clock12(at, at - 3600_000)).toBe("3:10 AM");
    expect(clock12(new Date(2026, 8, 30, 15, 5).getTime(), at)).toBe("3:05 PM");
    expect(clock12(new Date(2026, 9, 1, 3, 10).getTime(), at)).toBe("Oct 1, 3:10 AM");
  });

  it("labels the limit card, and Resume before the reset reads its time and never goes sooner", async () => {
    const { limitCard, resumeAction, RESUME_MARGIN_MS } = await import("./client");
    const at = new Date(2026, 8, 30, 3, 10).getTime();
    const p = { chat: "c1", resets_at: at / 1000, window: "five_hour" };
    const before = limitCard(p, at - 40 * 60_000);
    expect(before).toEqual({ label: "Paused by the 5-hour limit · resumes at 3:10 AM", button: "Resume at 3:10 AM", early: true, at });
    // Inside the margin after the reset it is still early: the host's clock may lag.
    expect(limitCard(p, at + RESUME_MARGIN_MS - 1).early).toBe(true);
    const after = limitCard(p, at + RESUME_MARGIN_MS + 1);
    expect(after.label).toBe("Paused by the 5-hour limit · the window has reset");
    expect(after.button).toBe("Resume");
    expect(after.early).toBe(false);
    expect(limitCard({ ...p, window: "seven_day" }, at - 1).label).toBe("Paused by the weekly limit · resumes at 3:10 AM");
    expect(limitCard({ chat: "c1", resets_at: null }, at)).toEqual({ label: "Paused by the usage limit", button: "Resume", early: false, at: null });
    // Early or not, Resume is the host's resume — it schedules; the page sends no message of its own.
    expect(resumeAction()).toEqual({ op: "resume_limit" });
  });

  it("shows the budget card only while a call is held, in the Mac's words", async () => {
    const { budgetHeld, budgetCard } = await import("./client");
    const now = 1_000_000;
    const ledger = { budget_pct: 35, stop_at: 85, start_pct: 50, latest_pct: 86, resets_at: new Date(2026, 8, 30, 3, 10).getTime() / 1000, pending_since_ms: now - 5000, holds: [now + 60_000] };
    expect(budgetHeld(ledger, now)).toBe(ledger);
    expect(budgetHeld({ ...ledger, holds: [now - 1] }, now)).toBe(null);
    expect(budgetHeld({ ...ledger, pending_since_ms: null }, now)).toBe(null);
    expect(budgetHeld(null, now)).toBe(null);
    const card = budgetCard(ledger, new Date(2026, 8, 30, 2, 0).getTime());
    expect(card.title).toBe("Stopped at 85% of the 5-hour window");
    expect(card.detail).toBe("the window is at 86% · this message has spent 36% of its 35% · it resets at 3:10 AM");
  });

  const at = "2026-09-30T10:00:00Z";
  const usage = (o: number, i = 1000) => ({ input_tokens: i, output_tokens: o });

  it("speaks the last reply's prose, its code blocks said once as on screen", async () => {
    const { speakText, CODE_ON_SCREEN } = await import("./client");
    const ev = [
      { event: "user_message", text: "hi", at },
      { event: "assistant_message", model: "m", at, usage: usage(5), stop_reason: null, blocks: [{ type: "text", text: "An old reply." }] },
      { event: "user_message", text: "and the fix?", at },
      {
        event: "assistant_message",
        model: "m",
        at,
        usage: usage(5),
        stop_reason: null,
        blocks: [
          { type: "tool_use", id: "t1", name: "Read", input: {} },
          { type: "text", text: "Set the width.\n```css\n.a { min-width: 0 }\n```\nThen this:\n```ts\nx()\n```\nDone." },
        ],
      },
    ] as unknown as SessionEvent[];
    const said = speakText(ev)!;
    expect(said).toBe(`Set the width.\n${CODE_ON_SCREEN}\nThen this:\nDone.`);
    expect(said).not.toContain("min-width");
    expect(said).not.toContain("An old reply");
    // His message last: nothing to speak yet.
    expect(speakText([...ev, { event: "user_message", text: "more", at }] as unknown as SessionEvent[])).toBe(null);
    // A removed block is not in the context, so not spoken.
    const gone = [...ev, { event: "elide", targets: [3], block: 1, at }] as unknown as SessionEvent[];
    expect(speakText(gone)).toBe(null);
  });

  it("writes the model and token line under a reply, as the Mac's footer figures it", async () => {
    const { replyLine, replySizes, shortModel } = await import("./client");
    expect(shortModel("claude-opus-5-5")).toBe("opus 5.5");
    expect(shortModel("sonnet")).toBe("sonnet");
    const ev = [
      { event: "user_message", text: "hi", at },
      { event: "assistant_message", model: "claude-opus-5-5", at, usage: usage(200, 12000), stop_reason: null, cost: 0.0412, blocks: [{ type: "text", text: "Hello." }] },
      { event: "user_message", text: "more", at },
      { event: "assistant_message", model: "claude-opus-5-5", at, usage: usage(300, 12500), stop_reason: null, blocks: [{ type: "text", text: "More." }] },
    ] as unknown as SessionEvent[];
    const rows = transcriptRows(ev);
    const sizes = replySizes(ev);
    expect(replyLine(ev, rows[1], sizes)).toBe("opus 5.5 · 200 tokens · $0.04");
    // 12500 in − (12000 + 200) = 300 from his message; the reply's own 300.
    expect(replyLine(ev, rows[3], sizes)).toBe("opus 5.5 · 300 tokens");
    expect(replyLine(ev, rows[0], sizes)).toBe("");
    // No usage recorded: the model alone.
    const bare = [{ event: "assistant_message", model: "haiku", at, usage: usage(0, 0), stop_reason: null, blocks: [{ type: "text", text: "x" }] }] as unknown as SessionEvent[];
    expect(replyLine(bare, transcriptRows(bare)[0], replySizes(bare))).toBe("haiku");
  });
});
