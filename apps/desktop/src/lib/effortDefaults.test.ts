import { describe, expect, it } from "vitest";
import {
  EFFORT_DEFAULTS,
  effortDefault,
  effortDefaultLabel,
  effortFamily,
} from "./effortDefaults";

describe("effort defaults per model and per engine (backlog 100)", () => {
  it("names high on both engines for the three effort models", () => {
    // The finding the item was opened for: his belief that Claude Code's
    // default differs from the API's does not hold on the current docs —
    // both say `high` for Fable 5.1, Opus 5 and Sonnet 5.
    for (const alias of ["fable", "opus", "sonnet"]) {
      expect(effortDefaultLabel("claude-code", alias)).toBe("high");
      expect(effortDefaultLabel("provider", alias)).toBe("high");
    }
  });

  it("says none for Haiku, which has no effort control on either engine", () => {
    expect(effortDefault("claude-code", "haiku")?.default).toBeNull();
    expect(effortDefault("provider", "claude-haiku-4-5")?.levels).toEqual([]);
    expect(effortDefaultLabel("claude-code", "haiku")).toBe("none");
  });

  it("keeps the one engine difference the docs record: Opus 4.7", () => {
    expect(effortDefault("claude-code", "claude-opus-4-7")?.default).toBe("xhigh");
    expect(effortDefault("provider", "claude-opus-4-7")?.default).toBe("high");
  });

  it("resolves an alias, a full id and a dated snapshot to one family", () => {
    expect(effortFamily("claude-code", "opus")).toBe("opus-5");
    expect(effortFamily("provider", "claude-opus-5")).toBe("opus-5");
    expect(effortFamily("provider", "claude-opus-5-2026-01-15")).toBe("opus-5");
    expect(effortFamily("provider", "Claude-Sonnet-5")).toBe("sonnet-5");
    // The longest key wins, so a point release is not read as its parent.
    expect(effortFamily("provider", "claude-fable-5-1")).toBe("fable-5-1");
    expect(effortFamily("claude-code", "fable")).toBe("fable-5-1");
  });

  it("answers ? for a model the table has never heard of", () => {
    // The rail's dimmed `default · ?` case: the CLI's own default model
    // (an empty alias) and ids from other vendors.
    expect(effortDefault("claude-code", "")).toBeNull();
    expect(effortDefault("provider", "gpt-5")).toBeNull();
    expect(effortDefaultLabel("claude-code", "  ")).toBe("?");
  });

  it("carries a source on every row, so a cell is never an unqualified claim", () => {
    for (const engine of ["claude-code", "provider"] as const) {
      for (const [key, facts] of Object.entries(EFFORT_DEFAULTS[engine])) {
        expect(facts.source, `${engine}/${key}`).toMatch(/^https:\/\//);
        if (facts.default) expect(facts.levels).toContain(facts.default);
      }
    }
  });
});
