import { beforeEach, describe, expect, it, vi } from "vitest";

// Backlog 529: typing into an ended terminal tab goes to a live shell.
const { addToast, terminalOpen, terminalRunCwd, terminalWrite, terminalClose } = vi.hoisted(() => ({
  addToast: vi.fn(),
  terminalOpen: vi.fn(),
  terminalRunCwd: vi.fn(),
  terminalWrite: vi.fn(async () => null),
  terminalClose: vi.fn(async () => null),
}));
vi.mock("./state.svelte", async (orig) => ({ ...(await orig<typeof import("./state.svelte")>()), addToast }));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  terminalOpen,
  terminalRunCwd,
  terminalWrite,
  terminalClose,
}));

import { continueEnded, SHELL_GONE, term } from "./terminal.svelte";
import type { ShellRow } from "./terminal";

const ran = { command: "cd deeper", title: "cd deeper", note: null, stopped: false, finished: true };

function reset(rows: ShellRow[], active: number): void {
  term.shells.splice(0, term.shells.length, ...rows);
  for (const k of Object.keys(term.docks)) delete term.docks[k];
  term.docks.p = { open: true, collapsed: false, active };
}

// No DOM in this suite: the first grid reads the window's width only.
vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });

let nextId = 100;
beforeEach(() => {
  vi.clearAllMocks();
  terminalOpen.mockImplementation(async (cwd: string) => ({ id: ++nextId, pid: 1, shell: "zsh", cwd }));
  terminalRunCwd.mockResolvedValue("/w/deeper");
});

describe("keys typed into an ended run tab (529)", () => {
  it("open a shell beside it, in the folder the block ended in, and every key reaches it", async () => {
    reset(
      [
        { id: 1, shell: "zsh", title: "zsh", cwd: "/w", pid: 1, exit: { code: 0, signal: null }, pane: "p", run: { ...ran } },
        { id: 2, shell: "zsh", title: "zsh", cwd: "/w", pid: 1, exit: null, pane: "p" },
      ],
      1,
    );
    const first = continueEnded(1, "l");
    // Typed while the new shell opens: held, then sent in order.
    void continueEnded(1, "s");
    void continueEnded(1, "\r");
    await first;
    expect(terminalRunCwd).toHaveBeenCalledWith(1);
    expect(terminalOpen).toHaveBeenCalledWith("/w/deeper", expect.any(Number), expect.any(Number));
    const opened = nextId;
    // The run tab and its output stay; the new shell sits right after it and is the active tab.
    expect(term.shells.map((s) => s.id)).toEqual([1, opened, 2]);
    expect(term.docks.p.active).toBe(opened);
    expect(terminalWrite.mock.calls).toEqual([
      [opened, "l"],
      [opened, "s"],
      [opened, "\r"],
    ]);
    expect(addToast).not.toHaveBeenCalled();
    // A key typed into the run tab later goes to that same shell, not a third.
    await continueEnded(1, "x");
    expect(terminalOpen).toHaveBeenCalledTimes(1);
    expect(terminalWrite).toHaveBeenLastCalledWith(opened, "x");
  });

  it("use the block's own folder when it left no record", async () => {
    reset([{ id: 3, shell: "zsh", title: "zsh", cwd: "/w", pid: 1, exit: { code: 1, signal: null }, pane: "p", run: { ...ran } }], 3);
    terminalRunCwd.mockResolvedValue(null);
    await continueEnded(3, "a");
    expect(terminalOpen).toHaveBeenCalledWith("/w", expect.any(Number), expect.any(Number));
    expect(terminalWrite).toHaveBeenCalledWith(nextId, "a");
  });
});

describe("keys typed into an ended plain shell (529)", () => {
  it("restart it in place, in its folder, with the first key delivered", async () => {
    reset([{ id: 4, shell: "zsh", title: "zsh", cwd: "/home", pid: 1, exit: { code: 0, signal: null }, pane: "p" }], 4);
    await continueEnded(4, "e");
    expect(terminalRunCwd).not.toHaveBeenCalled();
    expect(terminalOpen).toHaveBeenCalledWith("/home", expect.any(Number), expect.any(Number));
    expect(term.shells.map((s) => s.id)).toEqual([nextId]);
    expect(terminalClose).toHaveBeenCalledWith(4);
    expect(terminalWrite.mock.calls).toEqual([[nextId, "e"]]);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("deliver the key whose write found the pty dead before the exit event came", async () => {
    reset([{ id: 5, shell: "zsh", title: "zsh", cwd: "/home", pid: 1, exit: null, pane: "p" }], 5);
    // TerminalShell's write failed with SHELL_GONE; the exit lands a moment later.
    const going = continueEnded(5, "k");
    setTimeout(() => (term.shells[0].exit = { code: 0, signal: null }), 60);
    await going;
    expect(terminalWrite.mock.calls).toEqual([[nextId, "k"]]);
    expect(addToast).not.toHaveBeenCalled();
    expect(SHELL_GONE).toBe("the shell's terminal is gone");
  });
});
