import { describe, expect, it } from "vitest";
import {
  END_MARKER,
  MAX_TURNS,
  changedLines,
  editTotals,
  parseThreads,
  serializeThreads,
  splitReply,
  today,
  undoable,
  type NoteEditThread,
  type NoteEditTurn,
} from "./noteEdit";

// Edit a note by prompt (nightshift backlog 151), the pure part: the reply
// read as it streams, the changed lines, and the threads' storage.

const BEFORE = "# Plan\n- use the neutral folder\n- ship on Friday\n";

describe("splitReply", () => {
  it("splits a whole reply into the note and the sentence", () => {
    const raw = `# Plan\n- no neutral folder\n- ship on Friday\n${END_MARKER}\nDropped the neutral folder.`;
    expect(splitReply(raw, BEFORE)).toEqual({
      note: "# Plan\n- no neutral folder\n- ship on Friday\n",
      summary: "Dropped the neutral folder.",
      complete: true,
    });
  });

  it("never shows a tail that could be the marker's start while streaming", () => {
    for (let n = 1; n < END_MARKER.length; n++) {
      const raw = `# Plan\n${END_MARKER.slice(0, n)}`;
      const s = splitReply(raw, BEFORE);
      expect(s.note).toBe("# Plan\n");
      expect(s.complete).toBe(false);
    }
    // A `<` that turns out not to be the marker comes back.
    expect(splitReply("a <b", BEFORE).note).toBe("a <b");
  });

  it("strips a fence the model wrapped the note in", () => {
    const raw = "```markdown\n# Plan\n- x\n```\n" + END_MARKER + "\nDone.";
    expect(splitReply(raw, BEFORE)).toEqual({ note: "# Plan\n- x\n", summary: "Done.", complete: true });
    // Mid-stream: the opener is gone, and a half-typed opener shows nothing.
    expect(splitReply("```markdown\n# Pl", BEFORE).note).toBe("# Pl");
    expect(splitReply("``", BEFORE).note).toBe("");
  });

  it("keeps a fence the note itself opens with", () => {
    const before = "```\ncode\n```\n";
    const raw = "```\ncode 2\n```\n" + END_MARKER + "\nok";
    expect(splitReply(raw, before).note).toBe("```\ncode 2\n```\n");
  });

  it("gives the note the ending the old one had", () => {
    expect(splitReply(`a\n\n\n${END_MARKER}`, "x\n").note).toBe("a\n");
    expect(splitReply(`a\n${END_MARKER}`, "x").note).toBe("a");
    expect(splitReply(`a${END_MARKER}`, "x\n").note).toBe("a\n");
  });

  it("a reply with no marker is the note so far, not complete", () => {
    expect(splitReply("# Plan\n- a\n", BEFORE)).toEqual({ note: "# Plan\n- a\n", summary: "", complete: false });
  });

  it("keeps CRLF inside the note", () => {
    expect(splitReply(`a\r\nb\r\n${END_MARKER}\nx`, "a\r\n").note).toBe("a\r\nb\n");
  });
});

describe("changedLines and editTotals", () => {
  it("marks the new text's added lines, 0-based", () => {
    const after = "# Plan\n- no neutral folder\n- ship on Friday\n- tell Ana\n";
    expect(changedLines(BEFORE, after)).toEqual([1, 3]);
    expect(editTotals(BEFORE, after)).toEqual({ added: 2, removed: 1 });
  });

  it("an unchanged note has no marks", () => {
    expect(changedLines(BEFORE, BEFORE)).toEqual([]);
  });

  it("a prefix of the new text marks only what differs so far", () => {
    expect(changedLines(BEFORE, "# Plan\n- no neutral")).toEqual([1]);
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
        turns: [turn(1, "applied", { after: "after 1", summary: "s" })],
      },
    };
    const back = parseThreads(serializeThreads(threads));
    expect(back).toEqual(threads);
  });

  it("stores a running exchange as stopped, without its partial reply, its before kept", () => {
    const threads: Record<string, NoteEditThread> = {
      k: { draft: "", strike: true, touched: "t", turns: [turn(1, "running", { partial: "half" })] },
    };
    const back = parseThreads(serializeThreads(threads));
    expect(back.k.turns[0].status).toBe("stopped");
    expect(back.k.turns[0].partial).toBeUndefined();
    expect(back.k.turns[0].before).toBe("before 1");
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
  it("is the newest applied exchange, walking back past undone ones", () => {
    expect(undoable([turn(1, "applied"), turn(2, "applied")])?.id).toBe(2);
    expect(undoable([turn(1, "applied"), turn(2, "undone"), turn(3, "failed")])?.id).toBe(1);
    expect(undoable([turn(1, "undone"), turn(2, "stopped")])).toBeNull();
    expect(undoable([])).toBeNull();
  });
});
