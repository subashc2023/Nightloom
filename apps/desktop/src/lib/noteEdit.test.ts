import { describe, expect, it } from "vitest";
import {
  MAX_TURNS,
  HISTORY_CHANGE_LINES,
  HISTORY_TURNS,
  blockWords,
  changeDigest,
  changedLines,
  editBlock,
  PROPOSAL_OPEN_WORDS,
  DIFF_ROWS_SHOWN,
  PANEL_WIDTH,
  editRows,
  expandWords,
  lineNow,
  panelWidthAt,
  replyKind,
  shownRows,
  editTotals,
  parseThreads,
  priorExchanges,
  priorExchangeCount,
  serializeThreads,
  today,
  undoable,
  type NoteEditThread,
  type NoteEditTurn,
} from "./noteEdit";

// Edit a note by prompt (nightshift backlog 151), the pure part: the
// changed lines and the threads' storage. Pass 1's `splitReply` tests went
// with `splitReply` (pass 2 edits the file; there is no reply to split).

const BEFORE = "# Plan\n- use the neutral folder\n- ship on Friday\n";

describe("changedLines and editTotals", () => {
  it("marks the new text's added lines, 0-based", () => {
    const after = "# Plan\n- no neutral folder\n- ship on Friday\n- tell Ana\n";
    expect(changedLines(BEFORE, after)).toEqual([1, 3]);
    expect(editTotals(BEFORE, after)).toEqual({ added: 2, removed: 1 });
  });

  it("an unchanged note has no marks", () => {
    expect(changedLines(BEFORE, BEFORE)).toEqual([]);
  });

  it("a struck line and its replacement are both marked", () => {
    const after = "# Plan\n- ~~use the neutral folder~~ (2026-09-25)\n- use the app folder\n- ship on Friday\n";
    expect(changedLines(BEFORE, after)).toEqual([1, 2]);
  });
});

describe("today", () => {
  it("is the local date as YYYY-MM-DD", () => {
    expect(today(new Date(2026, 8, 5, 23, 59))).toBe("2026-09-05");
  });
});

const turn = (id: number, status: NoteEditTurn["status"], extra: Partial<NoteEditTurn> = {}): NoteEditTurn => ({
  id,
  request: `r${id}`,
  strike: true,
  at: new Date(2026, 8, 25, 10, id).toISOString(),
  status,
  before: `before ${id}`,
  ...extra,
});

describe("the threads' storage", () => {
  it("round-trips a thread; a half-typed request survives", () => {
    const threads: Record<string, NoteEditThread> = {
      "p:project:plan.md": {
        draft: "we dropped the neutral fol",
        strike: false,
        touched: "2026-09-25T10:00:00.000Z",
        turns: [turn(1, "applied", { after: "after 1", summary: "s", edits: 2 })],
      },
    };
    const back = parseThreads(serializeThreads(threads));
    expect(back).toEqual(threads);
  });

  it("stores a running exchange with no edits yet as stopped, its before kept", () => {
    const threads: Record<string, NoteEditThread> = {
      k: { draft: "", strike: true, touched: "t", turns: [turn(1, "running", { partial: "half" })] },
    };
    const back = parseThreads(serializeThreads(threads));
    expect(back.k.turns[0].status).toBe("stopped");
    expect(back.k.turns[0].partial).toBeUndefined();
    expect(back.k.turns[0].after).toBeUndefined();
    expect(back.k.turns[0].before).toBe("before 1");
  });

  it("stores a running exchange whose edits landed with them as its after, so Undo still works", () => {
    const threads: Record<string, NoteEditThread> = {
      k: { draft: "", strike: true, touched: "t", turns: [turn(1, "running", { current: "half edited", edits: 1 })] },
    };
    const back = parseThreads(serializeThreads(threads));
    expect(back.k.turns[0]).toMatchObject({ status: "stopped", after: "half edited", before: "before 1" });
    expect(back.k.turns[0].current).toBeUndefined();
    expect(undoable(back.k.turns)?.id).toBe(1);
  });

  it("keeps the newest exchanges and leaves out empty threads", () => {
    const many = Array.from({ length: MAX_TURNS + 5 }, (_, i) => turn(i, "applied"));
    const threads: Record<string, NoteEditThread> = {
      full: { draft: "", strike: true, touched: "t", turns: many },
      empty: { draft: "  ", strike: true, touched: "t", turns: [] },
    };
    const back = parseThreads(serializeThreads(threads));
    expect(back.full.turns).toHaveLength(MAX_TURNS);
    expect(back.full.turns[0].id).toBe(5);
    expect(back.empty).toBeUndefined();
  });

  it("reads anything malformed as nothing", () => {
    expect(parseThreads(null)).toEqual({});
    expect(parseThreads("not json")).toEqual({});
    expect(parseThreads('{"k": {"turns": [{"id": "x"}]}}')).toEqual({
      k: { draft: "", strike: true, touched: new Date(0).toISOString(), turns: [] },
    });
  });
});

describe("undoable", () => {
  it("is the newest exchange that changed the note, walking back past undone ones", () => {
    expect(undoable([turn(1, "applied"), turn(2, "applied")])?.id).toBe(2);
    expect(undoable([turn(1, "applied"), turn(2, "undone"), turn(3, "failed")])?.id).toBe(1);
    expect(undoable([turn(1, "undone"), turn(2, "stopped")])).toBeNull();
    expect(undoable([turn(1, "stopped", { after: "x" })])?.id).toBe(1);
    expect(undoable([turn(1, "stopped", { after: "before 1" })])).toBeNull();
    expect(undoable([])).toBeNull();
  });
});

// Backlog 325: Send off with text typed says why, each reason in its own words.
// Backlog 345: a dream's proposal open on the note is not a reason.
describe("editBlock", () => {
  const none = { loading: false, error: false, hasBuffer: true };
  it("is null when nothing blocks", () => {
    expect(editBlock(none)).toBeNull();
  });
  it("names each reason, the read first", () => {
    expect(editBlock({ ...none, loading: true, hasBuffer: false })).toBe("loading");
    expect(editBlock({ ...none, error: true, hasBuffer: false })).toBe("error");
    expect(editBlock({ ...none, hasBuffer: false })).toBe("no-note");
  });
  it("gives every reason its own one line", () => {
    const all = (["loading", "error", "no-note"] as const).map(blockWords);
    expect(new Set(all).size).toBe(3);
    for (const w of all) expect(w).not.toContain("\n");
    for (const w of all) expect(w).not.toMatch(/Accept or Dismiss/);
  });
  it("says a proposal is open without asking him to clear it first (345)", () => {
    expect(PROPOSAL_OPEN_WORDS).toMatch(/proposal stays pending/);
    expect(PROPOSAL_OPEN_WORDS).not.toMatch(/first/);
  });
});

// Backlog 326: the earlier exchanges each request carries.
describe("priorExchanges", () => {
  const turn = (over: Partial<NoteEditTurn>): NoteEditTurn => ({
    id: Math.random(),
    request: "r",
    strike: true,
    at: "2026-10-08T00:00:00Z",
    status: "applied",
    before: "a\nb\n",
    ...over,
  });
  it("carries requests, replies, outcomes and changed lines, oldest first; skips kept and running", () => {
    const h = priorExchanges([
      turn({ request: "one", after: "a\nB\n", summary: "Changed b." }),
      turn({ request: "", status: "kept", summary: "kept copy" }),
      turn({ request: "two?", status: "unchanged", summary: "An answer." }),
      turn({ request: "three", status: "undone", after: "x\n", summary: "Rewrote." }),
      turn({ request: "four", status: "failed", error: "the CLI failed" }),
      turn({ request: "five", status: "running" }),
    ]);
    expect(h.map((x) => x.request)).toEqual(["one", "two?", "three", "four"]);
    expect(h.map((x) => x.outcome)).toEqual(["edited", "no edit", "undone", "failed"]);
    expect(h[0]).toEqual({ request: "one", reply: "Changed b.", changes: "- b\n+ B", outcome: "edited" });
    expect(h[1].changes).toBe("");
    expect(h[3].reply).toBe("the CLI failed");
  });
  it("a failed turn whose summary came back empty carries its error as the reply", () => {
    const h = priorExchanges([turn({ request: "x", status: "failed", summary: "", error: "the CLI failed" })]);
    expect(h[0].reply).toBe("the CLI failed");
  });
  it("keeps only the newest HISTORY_TURNS", () => {
    const many = Array.from({ length: 20 }, (_, i) => turn({ request: `r${i}`, status: "unchanged" }));
    const h = priorExchanges(many);
    expect(h).toHaveLength(HISTORY_TURNS);
    expect(h[h.length - 1].request).toBe("r19");
  });
  it("counts every earlier exchange, past HISTORY_TURNS, but not kept copies or a running turn", () => {
    const many = Array.from({ length: 20 }, (_, i) => turn({ request: `r${i}`, status: "unchanged" }));
    many.push(turn({ request: "k", status: "kept" }), turn({ request: "now", status: "running" }));
    expect(priorExchangeCount(many)).toBe(20);
    expect(priorExchanges(many)).toHaveLength(HISTORY_TURNS);
  });
  it("caps the changed lines and says how many more", () => {
    const before = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 100 }, (_, i) => `LINE ${i}`).join("\n");
    const d = changeDigest(before, after).split("\n");
    expect(d).toHaveLength(HISTORY_CHANGE_LINES + 1);
    expect(d[d.length - 1]).toBe(`… ${200 - HISTORY_CHANGE_LINES} more changed lines`);
  });
});

// Backlog 345, his pick D2: how a reply is drawn, its lines, and the width.
describe("D2 panel", () => {
  const T = (status: NoteEditTurn["status"], extra: Partial<NoteEditTurn> = {}): NoteEditTurn => ({
    id: 1,
    request: "r",
    strike: true,
    at: "2026-10-12T21:41:00Z",
    status,
    before: "a\nb\n",
    ...extra,
  });

  it("draws a reply with no edit as plain text and one that edited as a card", () => {
    expect(replyKind(T("unchanged", { summary: "Two changes this week." }))).toBe("plain");
    expect(replyKind(T("failed", { error: "x" }))).toBe("plain");
    expect(replyKind(T("draft", { error: "x" }))).toBe("plain");
    expect(replyKind(T("kept", { summary: "x" }))).toBe("plain");
    expect(replyKind(T("applied", { after: "a\nb\n" }))).toBe("plain"); // applied, nothing changed
    expect(replyKind(T("stopped"))).toBe("plain");
    expect(replyKind(T("applied", { after: "a\nc\n" }))).toBe("card");
    expect(replyKind(T("undone", { after: "a\nc\n" }))).toBe("card");
    expect(replyKind(T("stopped", { after: "a\nc\n" }))).toBe("card");
    // Running: thinking until an edit lands, then the card.
    expect(replyKind(T("running", { edits: 0 }))).toBe("thinking");
    expect(replyKind(T("running", { edits: 1, current: "a\nc\n" }))).toBe("card");
  });

  it("gives each changed line its place in the note the turn left", () => {
    const rows = editRows("# P\nold\nkeep\n", "# P\n~~old~~\nnew\nkeep\n");
    expect(rows).toEqual([
      { kind: "del", text: "old", line: 1 },
      { kind: "add", text: "~~old~~", line: 1 },
      { kind: "add", text: "new", line: 2 },
    ]);
  });

  it("a clicked line goes to where it is now — by its text, nearest its old place — else its old place", () => {
    const row = { kind: "add" as const, text: "new", line: 2 };
    expect(lineNow(row, "# P\n~~old~~\nnew\nkeep\n")).toBe(2);
    // Two lines added above since: found by text.
    expect(lineNow(row, "# P\nx\ny\n~~old~~\nnew\nkeep\n")).toBe(4);
    // The nearest of two copies.
    expect(lineNow(row, "new\n# P\nnew\nkeep\n")).toBe(2);
    // Gone (or a removed line): its old place, inside the note.
    expect(lineNow({ kind: "del", text: "old", line: 1 }, "# P\nnew\n")).toBe(1);
    expect(lineNow({ kind: "add", text: "gone", line: 9 }, "# P\nnew\n")).toBe(1);
  });

  it("a card shows the first lines and expands to all of them, whole", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ kind: "add" as const, text: `l${i}`, line: i }));
    expect(shownRows(rows, false)).toHaveLength(DIFF_ROWS_SHOWN);
    expect(shownRows(rows, true)).toHaveLength(7);
    expect(expandWords(7, false)).toBe("Show all 7 lines, whole");
    expect(expandWords(2, false)).toBe("Show the lines whole");
    expect(expandWords(7, true)).toBe("Collapse");
  });

  it("is 380 px from a 1408-px window up, 27 % between, never under the old 320 px", () => {
    expect(PANEL_WIDTH).toBe("clamp(320px, 27vw, 380px)");
    expect(panelWidthAt(1440)).toBe(380);
    expect(panelWidthAt(1408)).toBe(380);
    expect(panelWidthAt(1400)).toBe(378);
    expect(panelWidthAt(1300)).toBeCloseTo(351, 0);
    expect(panelWidthAt(1185)).toBe(320);
    expect(panelWidthAt(900)).toBe(320);
  });
});
