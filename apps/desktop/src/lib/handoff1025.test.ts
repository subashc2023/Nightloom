/*
 * Item 1025 (blocker 2328 answered "always", 2026-11-26): every project's hand-off writes a HANDOFF.md again —
 * creating it where there is none — keeping 1007's fix (no mdcheck.py or backlog step in a plain project), and
 * the next chat's first message says where the previous chat's full history can be read.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  HANDOFF_FILE_CARE,
  HISTORY_MARK,
  PLAIN_WRAP_UP,
  WRAP_UP,
  clearDefaultReadOrder,
  historyPointer,
  noteCodeProject,
  noteThread,
  setDefaultMessage,
  withHistory,
  wrapUpToSend,
  writesHandoffFile,
} from "./handoff.svelte";

beforeEach(() => {
  setDefaultMessage(WRAP_UP);
  clearDefaultReadOrder();
  noteCodeProject("plain", false);
  noteCodeProject("code", true);
  noteThread("plain", null);
  noteThread("code", null);
});

describe("1025: a hand-off in a project without HANDOFF.md", () => {
  it("tells the model to create the file, with the sections", () => {
    const sent = wrapUpToSend("plain");
    expect(sent).toContain("Add a new section at the top of HANDOFF.md");
    expect(sent).toContain("create the file if there is none");
    expect(sent).toContain("Give the new HANDOFF.md section these sub-headings");
    expect(sent).toContain(HANDOFF_FILE_CARE);
  });

  it("names no mdcheck.py and no backlog index step", () => {
    const sent = wrapUpToSend("plain");
    for (const word of ["mdcheck", "backlog", "backlogctl", "INDEX.md", "practices"]) expect(sent).not.toContain(word);
  });

  it("a chat whose project is not probed yet gets the same (it writes HANDOFF.md too)", () => {
    expect(writesHandoffFile("never-probed")).toBe(true);
    expect(wrapUpToSend("never-probed")).toContain("HANDOFF.md");
  });

  it("a thread chat in a plain project still keeps its memory in the thread (blocker 1568)", () => {
    noteThread("plain", "t1");
    expect(writesHandoffFile("plain")).toBe(false);
    expect(wrapUpToSend("plain")).toContain("Do not write HANDOFF.md for this chat.");
    noteThread("plain", null);
  });

  it("the side cases are in both built-ins: never a rewrite, never a new file over a placeholder", () => {
    for (const t of [WRAP_UP, PLAIN_WRAP_UP]) {
      expect(t).toContain("do not read the whole file or write it out again");
      expect(t).toContain("do not create a new HANDOFF.md over it");
    }
  });
});

describe("1025: the next chat can reach the previous chat's full history", () => {
  const from = {
    id: "abc12345-0000-0000-0000-000000000000",
    title: "Fix the sidebar",
    first_user: null,
    path: "/Users/x/.nightloom/projects/p/sessions/abc12345.jsonl",
    modified: "2026-11-26T22:10:00Z",
  };

  it("names the tools and the log where it can be read", () => {
    const p = historyPointer(from);
    expect(p.startsWith(HISTORY_MARK)).toBe(true);
    expect(p).toContain(from.id);
    expect(p).toContain("“Fix the sidebar”");
    expect(p).toContain('search_chats with scope "chain"');
    expect(p).toContain("read_chat");
    expect(p).toContain(from.path);
  });

  it("goes under the start prompt once, and never onto a blank", () => {
    const once = withHistory("Goal: carry on.", from);
    expect(once).toMatch(/^Goal: carry on\.\n\nEarlier history/);
    expect(withHistory(once, from)).toBe(once);
    expect(withHistory("   ", from)).toBe("   ");
  });

  it("an id alone still points at the chain search; an incognito chat gets none", () => {
    expect(historyPointer({ id: "zzz" })).toContain("chat zzz");
    expect(historyPointer({ id: "zzz" })).not.toContain("raw log");
    expect(historyPointer({ id: "zzz", mode: "incognito" })).toBe("");
    expect(withHistory("Goal: x", null)).toBe("Goal: x");
  });

});
