import { describe, expect, it } from "vitest";
import { findRefs, hitsOfCalls, isMemoryWhere, lineOffset, parseMemoryReply, shortPath } from "./memoryHits";

// The shape `memory_where.rs`'s `render` writes (fixture text, not his memory).
const REPLY = `3 places in memory match "Stuart IP terms" (also searched: intellectual property); searched User memory (1 file), Project memory (1 file).
In your reply, name each place you mean as its path:line exactly as written below.

## User memory — loaded into every chat
/home/u/.nightloom/AGENTS.md:2: - Always mention Stuart's IP terms.

## User memory — loaded into every chat (chats on that model only)
/home/u/.nightloom/models/opus.md:4: IP terms: say them.

## Project memory — read on demand
/work/proj/.agents/memory/stuart.md:1: Stuart's intellectual property terms: shared rights.
`;

describe("memory_where results", () => {
  it("knows the tool on both engines", () => {
    expect(isMemoryWhere("memory_where")).toBe(true);
    expect(isMemoryWhere("mcp__nightloom__memory_where")).toBe(true);
    expect(isMemoryWhere("search_chats")).toBe(false);
  });

  it("parses groups, loading and notes", () => {
    const g = parseMemoryReply(REPLY);
    expect(g.map((x) => [x.layer, x.loading, x.note])).toEqual([
      ["User memory", "every", null],
      ["User memory", "every", "chats on that model only"],
      ["Project memory", "demand", null],
    ]);
    expect(g[0].hits).toEqual([
      { path: "/home/u/.nightloom/AGENTS.md", line: 2, text: "- Always mention Stuart's IP terms." },
    ]);
    // The summary line's "path:line" is before any heading and is not a hit.
    expect(g.flatMap((x) => x.hits)).toHaveLength(3);
  });

  it("merges a turn's calls and drops errors and repeats", () => {
    const calls = [
      { name: "mcp__nightloom__memory_where", result: { content: REPLY, is_error: false } },
      { name: "mcp__nightloom__memory_where", result: { content: REPLY, is_error: false } },
      { name: "mcp__nightloom__memory_where", result: { content: REPLY, is_error: true } },
      { name: "Read", result: { content: REPLY, is_error: false } },
    ];
    const g = hitsOfCalls(calls);
    expect(g.flatMap((x) => x.hits)).toHaveLength(3);
  });

  it("finds the line's offset", () => {
    const t = "a\nbb\nccc";
    expect(lineOffset(t, 1)).toBe(0);
    expect(lineOffset(t, 2)).toBe(2);
    expect(lineOffset(t, 3)).toBe(5);
    expect(lineOffset(t, 9)).toBe(5);
  });

  it("shortens a path for a row", () => {
    expect(shortPath("/work/proj/.agents/memory/stuart.md")).toBe("…/memory/stuart.md");
    expect(shortPath("a/b.md")).toBe("a/b.md");
  });

  it("links references in the reply to hits", () => {
    const hits = parseMemoryReply(REPLY).flatMap((g) => g.hits);
    const text =
      "It is in /home/u/.nightloom/AGENTS.md:2 and in `memory/stuart.md:1`; also ~/.nightloom/models/opus.md:4. Not x.md:9.";
    const refs = findRefs(text, hits);
    expect(refs.map((r) => [text.slice(r.start, r.end), r.hit.line])).toEqual([
      ["/home/u/.nightloom/AGENTS.md:2", 2],
      ["memory/stuart.md:1", 1],
      ["~/.nightloom/models/opus.md:4", 4],
    ]);
  });

  it("does not guess between two files of one name", () => {
    const hits = [
      { path: "/a/AGENTS.md", line: 3, text: "x" },
      { path: "/b/AGENTS.md", line: 3, text: "y" },
    ];
    expect(findRefs("see AGENTS.md:3", hits)).toEqual([]);
    expect(findRefs("see /b/AGENTS.md:3", hits).map((r) => r.hit.text)).toEqual(["y"]);
  });
});
