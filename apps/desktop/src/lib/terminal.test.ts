import { describe, expect, it } from "vitest";
import type { Segment, ToolCallView } from "./state.svelte";
import type { SessionEvent } from "./types";
import {
  clampHeight,
  clockLabel,
  decodeBase64,
  exitLabel,
  filesChanged,
  focusedChord,
  isRunning,
  latestCall,
  shortCwd,
  tabLabel,
  terminalChord,
  turnStartedAt,
  type ShellRow,
} from "./terminal";

// The terminal pane (nightshift backlog 113): the strip's states, the
// chords and the notice row's counts, pinned without a DOM.

function row(over: Partial<ShellRow> = {}): ShellRow {
  return { id: 1, shell: "zsh", title: "zsh", cwd: "/Users/s/proj", pid: 42, exit: null, ...over };
}

function call(over: Partial<ToolCallView> = {}): ToolCallView {
  return { id: "toolu_1", name: "Bash", input: {}, result: null, ...over };
}

describe("the strip's tabs (board 12c)", () => {
  it("reads the shell while nothing runs and the command while it does", () => {
    expect(tabLabel(row())).toBe("zsh");
    expect(isRunning(row())).toBe(false);
    const busy = row({ title: "npm" });
    expect(tabLabel(busy)).toBe("npm");
    expect(isRunning(busy)).toBe(true);
  });

  it("an exited shell is its name with the code in the label", () => {
    const gone = row({ title: "sh", exit: { code: 1, signal: null } });
    expect(tabLabel(gone)).toBe("zsh");
    expect(isRunning(gone)).toBe(false);
    expect(exitLabel(gone)).toBe("exit 1");
    expect(exitLabel(row({ exit: { code: null, signal: "SIGHUP" } }))).toBe("ended (SIGHUP)");
    expect(exitLabel(row())).toBeNull();
  });
});

describe("the folder as the boards write it", () => {
  it("shortens the home and elides the middle", () => {
    const home = "/Users/swaraag";
    expect(shortCwd("/Users/swaraag/Documents/CS/Nightloom/Value-Generalization", home)).toBe("~/…/Value-Generalization");
    expect(shortCwd("/Users/swaraag/proj", home)).toBe("~/proj");
    expect(shortCwd("/Users/swaraag", home)).toBe("~");
    expect(shortCwd("/opt/homebrew/lib", home)).toBe("/opt/…/lib");
    expect(shortCwd("/tmp", null)).toBe("/tmp");
    expect(shortCwd("/", null)).toBe("/");
  });
});

describe("the chords", () => {
  const k = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("⌃` alone is the pane's chord", () => {
    expect(terminalChord(k("Backquote", { ctrlKey: true }))).toBe(true);
    expect(terminalChord(k("Backquote", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(terminalChord(k("Backquote", { metaKey: true }))).toBe(false);
    expect(terminalChord(k("Backquote"))).toBe(false);
  });

  it("⌘T · ⌘W · ⌘⇧] · ⌘⇧[ act on shells only on macOS", () => {
    expect(focusedChord(k("KeyT", { metaKey: true }), true)).toBe("new");
    expect(focusedChord(k("KeyW", { metaKey: true }), true)).toBe("close");
    expect(focusedChord(k("BracketRight", { metaKey: true, shiftKey: true }), true)).toBe("next");
    expect(focusedChord(k("BracketLeft", { metaKey: true, shiftKey: true }), true)).toBe("prev");
    expect(focusedChord(k("KeyT", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(focusedChord(k("KeyT", { ctrlKey: true }), false)).toBeNull();
    expect(focusedChord(k("KeyW", { ctrlKey: true }), true)).toBeNull();
  });
});

describe("the pane's height", () => {
  it("is clamped between the floor and most of the column", () => {
    expect(clampHeight(240, 800)).toBe(240);
    expect(clampHeight(10, 800)).toBe(96);
    expect(clampHeight(5000, 800)).toBe(640);
    expect(clampHeight(200, 100)).toBe(96);
  });
});

describe("the pty's bytes", () => {
  it("come out of the event's base64 whole, invalid UTF-8 and all", () => {
    // "hé" cut after the first byte of é: a string could not carry it.
    expect(Array.from(decodeBase64("aMM="))).toEqual([0x68, 0xc3]);
    expect(Array.from(decodeBase64(""))).toEqual([]);
  });
});

describe("the notice row while a Claude Code turn works here (12c)", () => {
  const segs: Segment[] = [
    { kind: "thinking", text: "…", done: true },
    { kind: "tool", call: call({ name: "Read", input: { file_path: "/p/notes/a.md" } }) },
    { kind: "tool", call: call({ name: "Edit", input: { file_path: "/p/notes/a.md" } }) },
    { kind: "tool", call: call({ name: "mcp__nightloom__write", input: { path: "/p/b.md" } }) },
    { kind: "tool", call: call({ name: "Edit", input: { file_path: "/p/notes/a.md" } }) },
    {
      kind: "tool",
      call: call({
        name: "Agent",
        input: {},
        children: [{ kind: "tool", call: call({ name: "Write", input: { file_path: "/p/c.md" } }) }],
      }),
    },
    { kind: "tool", call: call({ name: "Bash", input: { command: "git diff --stat" } }) },
  ];

  it("counts distinct files changed, a subagent's included", () => {
    expect(filesChanged(segs)).toBe(3);
    expect(filesChanged([])).toBe(0);
  });

  it("names the latest call the way the activity block does", () => {
    expect(latestCall(segs, "/p")).toBe("Bash git diff --stat");
    expect(latestCall(segs.slice(0, 3), "/p")).toBe("Edit notes/a.md");
    expect(latestCall(segs.slice(0, 3), null)).toBe("Edit /p/notes/a.md");
    expect(latestCall(segs.slice(0, 1), "/p")).toBeNull();
    const long = "x".repeat(80);
    expect(latestCall([{ kind: "tool", call: call({ input: { command: long } }) }], null)).toBe(
      `Bash ${"x".repeat(47)}…`,
    );
  });

  it("counts the clock from the newest user message", () => {
    const events: SessionEvent[] = [
      { event: "user_message", text: "a", at: "2026-09-17T03:00:00Z" },
      { event: "user_message", text: "b", at: "2026-09-17T03:05:00Z" },
    ] as SessionEvent[];
    expect(turnStartedAt(events)).toBe(Date.parse("2026-09-17T03:05:00Z"));
    expect(turnStartedAt([])).toBeNull();
    expect(clockLabel(41_000)).toBe("41 s");
    expect(clockLabel(123_000)).toBe("2 min 3 s");
  });
});
