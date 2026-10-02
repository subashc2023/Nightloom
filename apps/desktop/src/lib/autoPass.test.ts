import { describe, expect, it } from "vitest";
import {
  HANDOFF_PASS_GAP_MS,
  NIGHTLY_IDLE_MS,
  NIGHTLY_STALE_MS,
  handoffPassDue,
  nightlyReady,
  turnWroteHandoff,
} from "./autoPass";
import type { SessionEvent } from "./types";

// Nightshift item 278: memory upkeep runs at a hand-off and nightly when
// the Mac is idle, not only after a compaction he never makes.

const at = "2026-10-02T00:00:00Z";
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const tool = (name: string, input: unknown): SessionEvent => ({
  event: "assistant_message",
  model: "opus",
  blocks: [{ type: "tool_use", id: "t", name, input }],
  stop_reason: "tool_use",
  usage: { input_tokens: 0, output_tokens: 0 } as never,
  at,
});

describe("a hand-off turn", () => {
  it("is one whose last turn wrote HANDOFF.md, by either engine's tools", () => {
    expect(turnWroteHandoff([user("wrap up"), tool("Edit", { file_path: "/p/HANDOFF.md" })])).toBe(true);
    expect(turnWroteHandoff([user("wrap up"), tool("write_file", { path: "HANDOFF.md" })])).toBe(true);
    expect(turnWroteHandoff([user("x"), tool("MultiEdit", { file_path: "C:\\p\\HANDOFF.md" })])).toBe(true);
  });

  it("is not a read of it, another file, or an earlier turn's write", () => {
    expect(turnWroteHandoff([user("x"), tool("Read", { file_path: "/p/HANDOFF.md" })])).toBe(false);
    expect(turnWroteHandoff([user("x"), tool("Write", { file_path: "/p/HANDOFF.md.bak" })])).toBe(false);
    expect(turnWroteHandoff([user("x"), tool("Write", { file_path: "/p/NOT-HANDOFF.md" })])).toBe(false);
    expect(
      turnWroteHandoff([user("a"), tool("Write", { file_path: "/p/HANDOFF.md" }), user("b"), tool("Read", {})]),
    ).toBe(false);
    expect(turnWroteHandoff([])).toBe(false);
    expect(turnWroteHandoff(null)).toBe(false);
    expect(turnWroteHandoff([user("x"), tool("Write", null)])).toBe(false);
  });

  it("starts at most one pass per gap", () => {
    expect(handoffPassDue(null, 1_000)).toBe(true);
    expect(handoffPassDue(1_000, 1_000 + HANDOFF_PASS_GAP_MS - 1)).toBe(false);
    expect(handoffPassDue(1_000, 1_000 + HANDOFF_PASS_GAP_MS)).toBe(true);
  });
});

describe("the nightly pass", () => {
  const now = 100 * 60 * 60_000;
  const recent = now - 20 * 60 * 60_000;
  it("waits for an idle Mac after a recent pass", () => {
    expect(nightlyReady(0, recent, now)).toBe(false);
    expect(nightlyReady(NIGHTLY_IDLE_MS - 1, recent, now)).toBe(false);
    expect(nightlyReady(NIGHTLY_IDLE_MS, recent, now)).toBe(true);
    // Unreadable is not idle.
    expect(nightlyReady(null, recent, now)).toBe(false);
  });

  it("runs anyway when the last pass is stale or there was none", () => {
    expect(nightlyReady(0, now - NIGHTLY_STALE_MS, now)).toBe(true);
    expect(nightlyReady(null, null, now)).toBe(true);
  });
});
