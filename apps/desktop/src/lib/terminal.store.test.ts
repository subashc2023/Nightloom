import { describe, expect, it } from "vitest";
import { deliverForTest, pendingFor, registerSink } from "./terminal.svelte";
import { PENDING_MAX_BYTES } from "./terminal";

/**
 * The store's undrawn bytes (nightshift backlog 137): what a shell prints
 * before its component has a sink queues in the store, capped — the
 * oldest go, and the replay writes a marker first.
 */
describe("a shell's undrawn output", () => {
  it("is capped from the front and replayed behind a marker", () => {
    const id = 7;
    const chunk = (fill: number) => new Uint8Array(600 * 1024).fill(fill);
    deliverForTest(id, chunk(1));
    deliverForTest(id, chunk(2));
    expect(pendingFor(id)).toEqual({ bytes: 600 * 1024, dropped: 600 * 1024 });
    deliverForTest(id, chunk(3));
    expect(pendingFor(id).bytes).toBeLessThanOrEqual(PENDING_MAX_BYTES);
    expect(pendingFor(id).dropped).toBe(2 * 600 * 1024);
    const got: (string | number)[] = [];
    const off = registerSink(id, (b) => got.push(typeof b === "string" ? b : b[0]!));
    expect(got.length).toBe(2);
    expect(got[0]).toContain("1200 KB of output not shown");
    expect(got[1]).toBe(3);
    expect(pendingFor(id)).toEqual({ bytes: 0, dropped: 0 });
    // With a sink, bytes go straight through, nothing queues.
    deliverForTest(id, new Uint8Array([9]));
    expect(got[2]).toBe(9);
    off();
  });

  it("holds a small early prompt whole, no marker", () => {
    const id = 8;
    deliverForTest(id, new Uint8Array([65, 66]));
    const got: (string | Uint8Array)[] = [];
    registerSink(id, (b) => got.push(b));
    expect(got.length).toBe(1);
    expect(Array.from(got[0] as Uint8Array)).toEqual([65, 66]);
  });
});

/**
 * A shell's xterm outlives its component's mount (113's scrollback,
 * 2026-09-17): the store keeps the instance, a re-mount takes it back,
 * and only the shell's own close disposes it.
 */
describe("a shell's instance across mounts", () => {
  it("is kept until the shell closes, then disposed once", async () => {
    const { closeShell, keepLive, liveCount, liveShell, term } = await import("./terminal.svelte");
    const id = 21;
    term.shells.push({ id, shell: "zsh", title: "zsh", cwd: "/w", pid: 1, exit: null, pane: "px" });
    term.docks.px = { open: true, collapsed: false, active: id };
    let disposed = 0;
    let removed = 0;
    // No DOM in this suite: the host is the one call the store makes.
    const host = { remove: () => removed++ } as unknown as HTMLElement;
    keepLive(id, { host, xterm: {}, fit: {}, exitWritten: false, dispose: () => disposed++ });
    // A re-mount finds the same instance; nothing was disposed by the
    // unmount in between (the component only detaches the host).
    expect(liveShell(id)?.host).toBe(host);
    expect(liveCount()).toBe(1);
    expect(disposed).toBe(0);
    closeShell(id);
    expect(disposed).toBe(1);
    expect(liveShell(id)).toBeUndefined();
    expect(removed).toBe(1);
    expect(term.shells.some((s) => s.id === id)).toBe(false);
  });
});

/**
 * Two docks (blocker 155, his answer 2026-09-22): one for the window by
 * default; a shell's tab dropped on the other pane gives that pane a dock
 * of its own; the only shell of a dock moves the dock; a shell dropped on
 * a pane with a dock joins it.
 */
describe("the docks", () => {
  it("split by a drag, merge by a drag, and follow the window's dock", async () => {
    const { closeShell, dropLabel, moveShell, shellsIn, term } = await import("./terminal.svelte");
    const row = (id: number, pane: string) => ({ id, shell: "zsh", title: "zsh", cwd: "/w", pid: id, exit: null, pane });
    // The window's dock under p1, two shells, the second in front.
    term.shells.push(row(31, "p1"), row(32, "p1"));
    term.docks.p1 = { open: true, collapsed: false, active: 32 };
    term.pane = "p1";

    term.dragging = 32;
    expect(dropLabel("p1")).toBe("the terminal is here");
    expect(dropLabel("p2")).toBe("a second terminal here");
    moveShell(32, "p2");
    term.dragging = null;
    // Two docks now: each with its own shell in front, the window's
    // still p1.
    expect(shellsIn("p1").map((s) => s.id)).toEqual([31]);
    expect(shellsIn("p2").map((s) => s.id)).toEqual([32]);
    expect(term.docks.p1?.active).toBe(31);
    expect(term.docks.p2).toEqual({ open: true, collapsed: false, active: 32 });
    expect(term.pane).toBe("p1");
    expect(term.focusDock).toBe("p2");

    // Back onto p1: joins its strip, last, in front; p2's dock goes.
    term.dragging = 32;
    expect(dropLabel("p1")).toBe("add to this pane's terminal");
    moveShell(32, "p1");
    expect(shellsIn("p1").map((s) => s.id)).toEqual([31, 32]);
    expect(term.docks.p1?.active).toBe(32);
    expect(term.docks.p2).toBeUndefined();

    // Close one; then the only shell of the window's dock dragged away
    // moves the dock, and the window's dock with it.
    closeShell(31);
    term.dragging = 32;
    expect(dropLabel("p2")).toBe("dock the terminal here");
    moveShell(32, "p2");
    term.dragging = null;
    expect(term.docks.p1).toBeUndefined();
    expect(term.pane).toBe("p2");
    closeShell(32);
    expect(term.docks.p2).toBeUndefined();
    expect(term.pane).toBeNull();
    expect(term.shells.length).toBe(0);
  });

  it("a dock's pane closing ends that dock's shells and not the other's", async () => {
    const { app } = await import("./state.svelte");
    const { dockPaneCheck, shellsIn, term } = await import("./terminal.svelte");
    const row = (id: number, pane: string) => ({ id, shell: "zsh", title: "zsh", cwd: "/w", pid: id, exit: null, pane });
    term.shells.push(row(41, "q1"), row(42, "q2"));
    term.docks.q1 = { open: true, collapsed: false, active: 41 };
    term.docks.q2 = { open: true, collapsed: false, active: 42 };
    term.pane = "q2";
    const before = app.tabs.panes;
    app.tabs.panes = [{ ...before[0], id: "q1" }] as typeof before;
    dockPaneCheck();
    app.tabs.panes = before;
    expect(shellsIn("q1").map((s) => s.id)).toEqual([41]);
    expect(shellsIn("q2")).toEqual([]);
    expect(term.docks.q2).toBeUndefined();
    expect(term.pane).toBe("q1");
  });
});
