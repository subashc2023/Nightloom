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
    term.shells.push({ id, shell: "zsh", title: "zsh", cwd: "/w", pid: 1, exit: null });
    term.active = id;
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
