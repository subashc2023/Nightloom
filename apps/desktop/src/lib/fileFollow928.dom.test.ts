// @vitest-environment happy-dom
/*
 * Item 928 (his report, 2026-11-23): an open .md file tab kept showing the old text for minutes after the model
 * had edited the file (python + sed through Bash, 11:42–11:45 PM), until he left the tab and came back. The real
 * FileView, mounted: the model's Bash result and a turn's end each make it read the file again and show the new
 * text without leaving the tab; a read-only tool's result does not re-read; a PDF is not re-read per tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

const disk: Record<string, { kind: string; text: string | null; data: string | null }> = {};
const reads: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: { path?: string }) => {
    if (cmd === "read_file_tab" && args.path) {
      reads.push(args.path);
      const f = disk[args.path];
      if (!f) throw new Error("No such file or directory (os error 2)");
      return { path: args.path, kind: f.kind, media_type: f.kind === "pdf" ? "application/pdf" : "text/markdown", size: (f.text ?? f.data ?? "").length, text: f.text, data: f.data, via: "folder" };
    }
    throw new Error("no backend");
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

await import("./asides.svelte");
const { app, applyTurnEvent } = await import("./state.svelte");
const { fileFollow, followFileTurns, mayHaveWritten } = await import("./fileFollow.svelte");
const FileView = (await import("./FileView.svelte")).default;

const MD = "/p/research/Application-Master-List.md";
let mounted: Record<string, unknown>[] = [];
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}
function view(path: string) {
  const c = mount(FileView, { target: document.body, props: { content: { kind: "file", path, session: "chat-A" } } });
  mounted.push(c);
  return c;
}
const body = () => document.body.textContent ?? "";

beforeEach(() => {
  document.body.innerHTML = "";
  reads.length = 0;
  app.activeSessionId = "chat-A";
  disk[MD] = { kind: "markdown", text: "# Master list\n\nMicrosoft: not applied", data: null };
});
afterEach(() => {
  for (const c of mounted) unmount(c);
  mounted = [];
});

describe("an open file tab follows its file (item 928)", () => {
  it("his case: the model's Bash edit shows without leaving the tab", async () => {
    view(MD);
    await settle();
    expect(body()).toContain("Microsoft: not applied");
    disk[MD] = { kind: "markdown", text: "# Master list\n\nMicrosoft: applied Nov 23", data: null };
    // The chat's Bash result (on screen; a background chat's goes through the same path).
    fileFollow.tools++;
    await settle();
    expect(body()).toContain("Microsoft: applied Nov 23");
    expect(body()).not.toContain("Microsoft: not applied");
  });
  it("a turn's end re-reads too", async () => {
    view(MD);
    await settle();
    disk[MD] = { kind: "markdown", text: "# Master list\n\nBlueDot: Dec 27", data: null };
    followFileTurns();
    await settle();
    expect(body()).toContain("BlueDot: Dec 27");
  });
  it("only tools that may write count; a PDF waits for the turn's end", async () => {
    expect(mayHaveWritten({ type: "tool_result", tool_use_id: "t", name: "Bash", content: "", is_error: false } as never)).toBe(true);
    expect(mayHaveWritten({ type: "tool_result", tool_use_id: "t", name: "Read", content: "", is_error: false } as never)).toBe(false);
    expect(mayHaveWritten({ type: "subagent", parent_tool_use_id: "p", event: { type: "tool_result", tool_use_id: "t", name: "Edit", content: "", is_error: false } } as never)).toBe(true);
    const PDF = "/p/files/paper.pdf";
    disk[PDF] = { kind: "pdf", text: null, data: "JVBERi0x" };
    view(PDF);
    await settle();
    const before = reads.filter((r) => r === PDF).length;
    fileFollow.tools++;
    await settle();
    expect(reads.filter((r) => r === PDF).length).toBe(before);
    followFileTurns();
    await settle();
    expect(reads.filter((r) => r === PDF).length).toBe(before + 1);
  });
  it("a live tool result reaches the counter through applyTurnEvent", () => {
    const n = fileFollow.tools;
    applyTurnEvent({ type: "tool_result", tool_use_id: "t1", name: "Bash", content: "ok", is_error: false } as never);
    expect(fileFollow.tools).toBe(n + 1);
    applyTurnEvent({ type: "tool_result", tool_use_id: "t2", name: "Grep", content: "", is_error: false } as never);
    expect(fileFollow.tools).toBe(n + 1);
  });
});

describe("the class: an open note in a scope no folder watch covers (item 928)", () => {
  it("NoteView re-checks every scope on a tool or a turn's end, the folder watch only for notes and the vault", async () => {
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${cwd}/src/lib/NoteView.svelte`, "utf8");
    expect(src).toContain('const watched = target.scope === "project" || target.scope === "knowledge";');
    expect(src).not.toContain('if (!target || (target.scope !== "project" && target.scope !== "knowledge")) return;');
    expect(src).toContain("if (due) void untrack(() => followCheck)?.();");
  });
});
