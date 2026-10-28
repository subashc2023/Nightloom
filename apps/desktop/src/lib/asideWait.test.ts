import { describe, expect, it } from "vitest";
import { ASIDE_STALL_MS, asideWait, quietLabel } from "./asideWait";

/** Item 404: what an aside's running exchange is waiting on. */
describe("asideWait (item 404)", () => {
  it("is queued while the chat's turn holds the agent, however long", () => {
    expect(asideWait({ phase: "queued", startedAt: 0 }, 10 * ASIDE_STALL_MS).kind).toBe("queued");
  });
  it("is running until the silence passes the stall line", () => {
    expect(asideWait({ phase: "running", heardAt: 1000 }, 1000 + ASIDE_STALL_MS - 1)).toEqual({ kind: "running", quietMs: ASIDE_STALL_MS - 1 });
    expect(asideWait({ phase: "running", heardAt: 1000 }, 1000 + ASIDE_STALL_MS).kind).toBe("stalled");
  });
  it("counts from the last event, not the start", () => {
    expect(asideWait({ phase: "running", startedAt: 0, heardAt: 80_000 }, 100_000).kind).toBe("running");
  });
  it("with no phase yet counts from when it was asked", () => {
    expect(asideWait({ startedAt: 0 }, ASIDE_STALL_MS).kind).toBe("stalled");
    expect(asideWait({ startedAt: 0 }, 5000)).toEqual({ kind: "running", quietMs: 5000 });
  });
  it("says the silence in seconds and minutes", () => {
    expect(quietLabel(45_400)).toBe("45 s");
    expect(quietLabel(90_000)).toBe("1 min 30 s");
    expect(quietLabel(120_000)).toBe("2 min");
  });
});
