import { describe, expect, it } from "vitest";
import { findChord, SEARCH_KEY } from "./find";
import { SEARCH_COLUMN_MAX, SEARCH_GROWTH, searchGrowthFor } from "./search.svelte";
import {
  countLine,
  elapsedLabel,
  emptyLine,
  escapeClosesPanel,
  flatten,
  groupKey,
  matchesSuffix,
  stepRow,
  whoLabel,
} from "./search";
import type { ChatGroup, NoteGroup, SearchResult } from "./types";

// Search everywhere (nightshift backlog 117): the row list the arrows walk,
// the count line, the labels, the chord. The panel and the jump need a
// document and are the checklist's.

function chat(id: string, rows: number[]): ChatGroup {
  return {
    id,
    path: `/logs/${id}.jsonl`,
    modified: "2026-09-16T00:00:00Z",
    user_turns: rows.length,
    first_user: null,
    title: id,
    hits: rows.length,
    rows: rows.map((index) => ({
      index,
      who: "you",
      at: "2026-09-16T00:00:00Z",
      before: "",
      matched: "x",
      after: "",
      matches: 1,
    })),
  };
}

function note(name: string, lines: number[]): NoteGroup {
  return {
    scope: "project",
    name,
    modified: "2026-09-16T00:00:00Z",
    hits: lines.length,
    rows: lines.map((line) => ({
      line,
      before: "",
      matched: "x",
      after: "",
      matches: 1,
    })),
  };
}

function result(partial: Partial<SearchResult>): SearchResult {
  return {
    matches: 0,
    messages: 0,
    chats: 0,
    shown: 0,
    elapsed_ms: 0,
    groups: [],
    notes: [],
    ...partial,
  };
}

describe("flatten", () => {
  it("walks chats in the store's order, rows in message order, then notes", () => {
    const r = result({
      groups: [chat("a", [3, 7]), chat("b", [1])],
      notes: [note("q5.md", [12])],
    });
    const rows = flatten(r);
    expect(
      rows.map((x) =>
        x.kind === "chat"
          ? `${x.group.id}:${x.row.index}`
          : `${x.group.name}:${x.row.line}`,
      ),
    ).toEqual(["a:3", "a:7", "b:1", "q5.md:12"]);
  });

  it("skips a group past the budget (no rows) but nothing else", () => {
    const capped = { ...chat("c", []), hits: 5 };
    expect(flatten(result({ groups: [capped, chat("d", [0])] }))).toHaveLength(
      1,
    );
  });

  it("is empty for no answer", () => {
    expect(flatten(null)).toEqual([]);
  });
});

describe("stepRow", () => {
  it("clamps at both ends and stays at 0 with no rows", () => {
    expect(stepRow(0, -1, 3)).toBe(0);
    expect(stepRow(2, 1, 3)).toBe(2);
    expect(stepRow(1, 1, 3)).toBe(2);
    expect(stepRow(0, 1, 0)).toBe(0);
  });
});

describe("countLine", () => {
  it("counts matches, messages and chats, pluralised", () => {
    const c = countLine(
      result({ matches: 14, messages: 9, chats: 4, shown: 9, elapsed_ms: 210 }),
      "this",
    );
    expect(c.text).toBe("14 matches in 9 messages · 4 chats");
    expect(c.narrow).toBe(false);
    expect(c.elapsed).toBe("0.2 s");
    expect(
      countLine(result({ matches: 1, messages: 1, chats: 1, shown: 1 }), "all")
        .text,
    ).toBe("1 match in 1 message · 1 chat");
  });

  it("says lines and notes under the notes scope", () => {
    expect(
      countLine(
        result({ matches: 2, messages: 2, chats: 1, shown: 2 }),
        "notes",
      ).text,
    ).toBe("2 matches in 2 lines · 1 note");
  });

  it("says how many are shown when the store capped the rows", () => {
    const c = countLine(
      result({ matches: 1340, messages: 1340, chats: 200, shown: 200 }),
      "all",
    );
    expect(c.text).toBe("200 of 1,340 matches shown");
    expect(c.narrow).toBe(true);
  });
});

describe("labels", () => {
  it("formats the elapsed time to a tenth of a second", () => {
    expect(elapsedLabel(8)).toBe("0.0 s");
    expect(elapsedLabel(1480)).toBe("1.5 s");
    expect(elapsedLabel(210)).toBe("0.2 s");
  });

  it("names who said it", () => {
    expect(whoLabel("you")).toBe("You");
    expect(whoLabel("name")).toBe("name");
    expect(whoLabel("claude-opus-5")).toBe("opus");
    expect(whoLabel("deepseek/deepseek-v4")).toBe("deepseek/deepseek-v4");
  });

  it("says where nothing matched", () => {
    expect(emptyLine("mean rewrad", "this")).toBe(
      "Nothing mentions “mean rewrad” in this project.",
    );
    expect(emptyLine("x", "all")).toBe("Nothing mentions “x” in any chat.");
    expect(emptyLine("x", "notes")).toBe("Nothing mentions “x” in the notes.");
  });

  it("appends the match count past one", () => {
    expect(matchesSuffix(1)).toBe("");
    expect(matchesSuffix(3)).toBe(" · 3 matches");
  });

  it("keys a group by chat id or by scope and name", () => {
    expect(groupKey(chat("abc", []))).toBe("abc");
    expect(groupKey(note("q5.md", []))).toBe("project/q5.md");
  });
});

describe("the chord", () => {
  it("is the search key with shift, and nothing else on that key", () => {
    expect(
      findChord({ code: SEARCH_KEY, shiftKey: true, altKey: false }, true),
    ).toBe("everywhere");
    expect(
      findChord({ code: SEARCH_KEY, shiftKey: false, altKey: false }, true),
    ).toBeNull();
    expect(
      findChord({ code: SEARCH_KEY, shiftKey: true, altKey: true }, true),
    ).toBeNull();
    expect(
      findChord({ code: SEARCH_KEY, shiftKey: true, altKey: false }, false),
    ).toBeNull();
  });

  it("leaves ⌘⇧F alone — it is the Fable switch (blocker 164)", () => {
    expect(
      findChord({ code: "KeyF", shiftKey: true, altKey: false }, true),
    ).toBeNull();
  });
});

describe("the panel's Escape (backlog 138)", () => {
  const field = { tagName: "INPUT" };
  it("closes the panel from its own field, a result row, a chevron, or nothing focused", () => {
    expect(escapeClosesPanel(field, field)).toBe(true);
    expect(escapeClosesPanel({ tagName: "BUTTON" }, field)).toBe(true);
    expect(escapeClosesPanel({ tagName: "DIV" }, field)).toBe(true);
    expect(escapeClosesPanel({ tagName: "body" }, field)).toBe(true);
    expect(escapeClosesPanel(null, field)).toBe(true);
  });
  it("leaves another text field's Escape alone — the composer, a rename, the find bar", () => {
    expect(escapeClosesPanel({ tagName: "TEXTAREA" }, field)).toBe(false);
    expect(escapeClosesPanel({ tagName: "INPUT" }, field)).toBe(false);
    expect(escapeClosesPanel({ tagName: "DIV", isContentEditable: true }, field)).toBe(false);
  });
});

describe("the panel's column (backlog 138)", () => {
  it("grows a little past the sidebar's width, never past the board's 380, never negative", () => {
    expect(searchGrowthFor(260)).toBe(SEARCH_GROWTH);
    expect(searchGrowthFor(200)).toBe(SEARCH_GROWTH);
    expect(searchGrowthFor(340)).toBe(SEARCH_COLUMN_MAX - 340);
    expect(searchGrowthFor(380)).toBe(0);
    expect(searchGrowthFor(440)).toBe(0);
  });
});
