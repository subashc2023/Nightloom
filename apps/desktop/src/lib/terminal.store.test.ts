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
