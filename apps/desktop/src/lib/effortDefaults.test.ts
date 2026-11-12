import { describe, expect, it } from "vitest";
import {
  EFFORT_DEFAULTS,
  effortDefault,
  effortDefaultLabel,
  effortFamily,
} from "./effortDefaults";

describe("effort defaults per model and per engine (backlog 100)", () => {
  it("names high on both engines for Fable 5.1, Opus 5 and Sonnet 5", () => {
    for (const id of ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"]) {
      expect(effortDefaultLabel("claude-code", id)).toBe("high");
      expect(effortDefaultLabel("provider", id)).toBe("high");
    }
  });

  it("names the 5.5 / 5.2 defaults the docs give (item 659)", () => {
    // Claude Code: Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 default to medium.
    for (const id of ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
      expect(effortDefaultLabel("claude-code", id)).toBe("medium");
    }
    // API: high everywhere but Opus 5.5 and Haiku 5.5.
    expect(effortDefaultLabel("provider", "claude-opus-5-5")).toBe("medium");
    expect(effortDefaultLabel("provider", "claude-haiku-5-5")).toBe("medium");
    expect(effortDefaultLabel("provider", "claude-sonnet-5-5")).toBe("high");
    expect(effortDefaultLabel("provider", "claude-fable-5-2")).toBe("high");
  });

  it("never lets a newer release inherit its parent's default (item 659)", () => {
    expect(effortFamily("provider", "claude-opus-5-5")).toBe("opus-5-5");
    expect(effortDefault("claude-code", "claude-opus-5-9")).toBeNull();
    expect(effortDefault("claude-code", "claude-sonnet-5-7")).toBeNull();
  });

  it("says none for Haiku, which has no effort control on either engine", () => {
    expect(effortDefault("claude-code", "claude-haiku-4-5")?.default).toBeNull();
    expect(effortDefault("provider", "claude-haiku-4-5")?.levels).toEqual([]);
    expect(effortDefaultLabel("claude-code", "claude-haiku-4-5")).toBe("none");
  });

  it("keeps the one engine difference the docs record: Opus 4.7", () => {
    expect(effortDefault("claude-code", "claude-opus-4-7")?.default).toBe("xhigh");
    expect(effortDefault("provider", "claude-opus-4-7")?.default).toBe("high");
  });

  it("resolves an alias, a full id and a dated snapshot to one family", () => {
    expect(effortFamily("claude-code", "opus")).toBe("opus-5-5");
    expect(effortFamily("provider", "claude-opus-5")).toBe("opus-5");
    expect(effortFamily("provider", "claude-opus-5-2026-01-15")).toBe("opus-5");
    expect(effortFamily("provider", "Claude-Sonnet-5")).toBe("sonnet-5");
    // The longest key wins, so a point release is not read as its parent.
    expect(effortFamily("provider", "claude-fable-5-1")).toBe("fable-5-1");
    // Item 660: since CLI 2.1.321 the `fable` alias means Fable 5.2 (model-config, "Version history").
    expect(effortFamily("claude-code", "fable")).toBe("fable-5-2");
    expect(effortDefaultLabel("claude-code", "fable")).toBe("medium");
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
