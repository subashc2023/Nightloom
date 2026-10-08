import { describe, expect, it } from "vitest";
import {
  MAX_TURNS,
  blockWords,
  changedLines,
  editBlock,
  editTotals,
  parseThreads,
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
describe("editBlock", () => {
  const none = { loading: false, error: false, reviewing: false, hasBuffer: true };
  it("is null when nothing blocks", () => {
    expect(editBlock(none)).toBeNull();
  });
  it("names each reason, the read first", () => {
    expect(editBlock({ ...none, reviewing: true })).toBe("proposal");
    expect(editBlock({ ...none, loading: true, hasBuffer: false })).toBe("loading");
    expect(editBlock({ ...none, error: true, hasBuffer: false })).toBe("error");
    expect(editBlock({ ...none, hasBuffer: false })).toBe("no-note");
    // A proposal still loading reads as loading; one that failed to read, as the error.
    expect(editBlock({ ...none, loading: true, reviewing: true })).toBe("loading");
    expect(editBlock({ ...none, error: true, reviewing: true })).toBe("error");
  });
  it("gives every reason its own one line", () => {
    const all = (["proposal", "loading", "error", "no-note"] as const).map(blockWords);
    expect(new Set(all).size).toBe(4);
    for (const w of all) expect(w).not.toContain("\n");
    expect(blockWords("proposal")).toMatch(/proposed change is open on this note.*Accept or Dismiss/);
  });
});
