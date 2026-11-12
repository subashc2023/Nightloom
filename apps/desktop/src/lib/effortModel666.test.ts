import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import railSrc from "./ProviderRail.svelte?raw";
import { EFFORT_DEFAULTS, effortDefaultLabel, effortFamily, effortModel } from "./effortDefaults";
import type { SeenModels } from "./modelSeen";

const at = "2026-11-12T01:00:00.000Z";

describe("the effort label for an alias reads what the CLI ran (item 666)", () => {
  it("reads the seen id's row on the CLI that ran it, not the table's newest-first row", () => {
    // A CLI on which `fable` still meant Fable 5.1: the label must be 5.1's (high), not 5.2's (medium).
    const seen: SeenModels = { fable: { id: "claude-fable-5-1", cliVersion: "2.1.320", seenAt: at } };
    expect(effortModel("fable", seen, "2.1.320")).toBe("claude-fable-5-1");
    expect(effortDefaultLabel("claude-code", effortModel("fable", seen, "2.1.320"))).toBe("high");
    // Table order alone says 5.2.
    expect(effortDefaultLabel("claude-code", "fable")).toBe("medium");
  });

  it("falls back to the alias (today's rule) before the first turn, or after a CLI update", () => {
    const seen: SeenModels = { fable: { id: "claude-fable-5-1", cliVersion: "2.1.320", seenAt: at } };
    expect(effortModel("opus", seen, "2.1.320")).toBe("opus");
    expect(effortModel("fable", seen, "2.1.322")).toBe("fable");
    expect(effortModel("fable", {}, "2.1.322")).toBe("fable");
    expect(effortDefaultLabel("claude-code", effortModel("fable", seen, "2.1.322"))).toBe("medium");
  });

  it("trusts a record when the CLI's version now is unknown, as the alias rows do", () => {
    const seen: SeenModels = { opus: { id: "claude-opus-5", cliVersion: "2.1.300", seenAt: at } };
    expect(effortModel("opus", seen, null)).toBe("claude-opus-5");
    expect(effortDefaultLabel("claude-code", effortModel("opus", seen, null))).toBe("high");
  });

  it("leaves a full id as it is, whatever is recorded", () => {
    const seen: SeenModels = { fable: { id: "claude-fable-5-1", cliVersion: "2.1.322", seenAt: at } };
    expect(effortModel("claude-fable-5-2", seen, "2.1.322")).toBe("claude-fable-5-2");
  });

  it("names the CLI's own default (the empty alias) once a turn has shown it", () => {
    const seen: SeenModels = { "": { id: "claude-opus-5-5", cliVersion: "2.1.322", seenAt: at } };
    expect(effortDefaultLabel("claude-code", "")).toBe("?");
    expect(effortDefaultLabel("claude-code", effortModel("", seen, "2.1.322"))).toBe("medium");
  });

  it("reads a seen model that is not in the table as ?, never a neighbour's row", () => {
    const seen: SeenModels = { opus: { id: "claude-opus-6", cliVersion: "2.1.330", seenAt: at } };
    expect(effortDefaultLabel("claude-code", effortModel("opus", seen, "2.1.330"))).toBe("?");
  });

  it("reads a 1M-context tag as the same model's row", () => {
    expect(effortFamily("claude-code", "claude-opus-5-5[1m]")).toBe("opus-5-5");
    expect(effortFamily("claude-code", "opus[1m]")).toBe(effortFamily("claude-code", "opus"));
    const seen: SeenModels = { "opus[1m]": { id: "claude-opus-4-7[1m]", cliVersion: "2.1.322", seenAt: at } };
    expect(effortDefaultLabel("claude-code", effortModel("opus[1m]", seen, "2.1.322"))).toBe(
      EFFORT_DEFAULTS["claude-code"]["opus-4-7"].default,
    );
  });

  it("is wired into both the composer's and the rail's effort label", () => {
    for (const src of [composerSrc, railSrc]) {
      expect(src).toMatch(/effortDefaultLabel\(\s*"claude-code",\s*effortModel\(\s*app\.draft\.agentModel,\s*modelSeen\.byAlias,/);
      expect(src).not.toMatch(/effortDefaultLabel\("claude-code", app\.draft\.agentModel\)/);
    }
  });
});
