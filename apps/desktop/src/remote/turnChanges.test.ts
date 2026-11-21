import { describe, expect, it } from "vitest";
import { emptyTurn, foldTurnEvent, transcriptRows } from "./client";
import { PHONE_DIFF_CAP, capLines, changesLine, pageAt, turnChanges } from "./turnChanges";
import type { SessionEvent } from "../lib/types";

// Item 742: a reply's Changes row and its per-file pages, from the calls' own input.
const at = "2026-11-16T04:00:00Z";
function log(): SessionEvent[] {
  return [
    { event: "session_created", id: "c1", at },
    { event: "user_message", text: "Fix the overflow", at },
    {
      event: "assistant_message",
      model: "claude-opus-5-5",
      at,
      blocks: [
        { type: "tool_use", id: "r1", name: "Read", input: { file_path: "src/a.ts" } },
        { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/remote/Remote.svelte", old_string: "a\nb", new_string: "a\nc" } },
        { type: "tool_use", id: "w1", name: "Write", input: { file_path: "notes/new.md", content: "one\ntwo\n" } },
        { type: "tool_use", id: "e2", name: "Edit", input: { file_path: "src/remote/Remote.svelte", old_string: "x", new_string: "y", replace_all: true } },
        { type: "tool_use", id: "d1", name: "Edit", input: { file_path: "src/denied.ts", old_string: "p", new_string: "q" } },
        { type: "text", text: "Done." },
      ],
    },
    { event: "tool_result", tool_use_id: "r1", content: "ok", is_error: false, at },
    { event: "tool_result", tool_use_id: "e1", content: "ok", is_error: false, at },
    { event: "tool_result", tool_use_id: "w1", content: "ok", is_error: false, at },
    { event: "tool_result", tool_use_id: "e2", content: "ok", is_error: false, at },
    { event: "tool_result", tool_use_id: "d1", content: "denied", is_error: true, at },
  ] as unknown as SessionEvent[];
}

describe("turnChanges (item 742)", () => {
  it("lists each changed file once, first touch first, joining its edits", () => {
    const rows = transcriptRows(log());
    const reply = rows.find((r) => r.kind === "assistant");
    if (reply?.kind !== "assistant") throw new Error("no reply");
    const files = turnChanges(reply.tools);
    expect(files.map((f) => f.path)).toEqual(["src/remote/Remote.svelte", "notes/new.md"]);
    const [remote, note] = files;
    expect(remote.name).toBe("Remote.svelte");
    expect(remote.dir).toBe("src/remote/");
    expect(remote.edits).toBe(2);
    expect(remote.added).toBe(2);
    expect(remote.removed).toBe(2);
    expect(remote.everyMatch).toBe(true);
    expect(remote.lines.filter((l) => l.sep)).toHaveLength(1);
    expect(note.whole).toBe(true);
    expect(note.added).toBe(2);
    expect(changesLine(files)).toBe("2 files · +4 −2");
  });

  it("skips a denied or failed edit and a read; a reply with none has no row", () => {
    const rows = transcriptRows(log().slice(0, 2));
    expect(rows.some((r) => r.kind === "assistant")).toBe(false);
    const files = turnChanges(transcriptRows(log()).flatMap((r) => (r.kind === "assistant" ? r.tools : [])));
    expect(files.some((f) => f.path === "src/denied.ts" || f.path === "src/a.ts")).toBe(false);
  });

  it("keeps the input only on file-editing calls", () => {
    const rows = transcriptRows(log());
    const reply = rows.find((r) => r.kind === "assistant");
    if (reply?.kind !== "assistant") throw new Error("no reply");
    expect(reply.tools.find((t) => t.id === "r1")?.input).toBeUndefined();
    expect(reply.tools.find((t) => t.id === "e1")?.input).toBeDefined();
  });

  it("counts a live turn's calls, a subagent's included, once they succeed", () => {
    let live = emptyTurn();
    live = foldTurnEvent(live, { type: "tool_call", id: "a1", name: "Agent", input: { description: "helper" } } as never);
    live = foldTurnEvent(live, { type: "subagent", parent_tool_use_id: "a1", event: { type: "tool_call", id: "s1", name: "MultiEdit", input: { file_path: "lib/x.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] } } } as never);
    expect(turnChanges(live.tools)).toEqual([]);
    live = foldTurnEvent(live, { type: "subagent", parent_tool_use_id: "a1", event: { type: "tool_result", tool_use_id: "s1", content: "ok", is_error: false } } as never);
    const files = turnChanges(live.tools);
    expect(files).toHaveLength(1);
    expect(files[0].added).toBe(2);
    expect(changesLine(files)).toBe("1 file · +2 −2");
  });

  it("folds a long file past the cap and shows all on ask", () => {
    const lines = Array.from({ length: PHONE_DIFF_CAP + 5 }, (_, i) => ({ kind: "add" as const, text: String(i) }));
    expect(capLines(lines, false)).toMatchObject({ hidden: 5 });
    expect(capLines(lines, false).shown).toHaveLength(PHONE_DIFF_CAP);
    expect(capLines(lines, true).hidden).toBe(0);
  });

  it("reads the page a swipe landed on", () => {
    expect(pageAt(0, 390, 3)).toBe(0);
    expect(pageAt(390, 390, 3)).toBe(1);
    expect(pageAt(600, 390, 3)).toBe(2);
    expect(pageAt(5000, 390, 3)).toBe(2);
    expect(pageAt(-20, 390, 3)).toBe(0);
    expect(pageAt(100, 0, 3)).toBe(0);
  });
});
