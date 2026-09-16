import { describe, expect, it } from "vitest";
import { DREAM_ENGINE, parseDreamPrefs, passTargetFor } from "./state.svelte";
import { defaultDraft } from "./catalog";

// Settings → Knowledge's dream row can name the Claude Code engine since
// 2026-09-16 (nightshift backlog 070). What the preference stores and what
// a pass is then sent are the two halves the backend's routing relies on.

describe("dream preferences", () => {
  it("keep the Claude Code engine as a real provider value", () => {
    const p = parseDreamPrefs(JSON.stringify({ auto: true, provider: DREAM_ENGINE, model: "haiku" }));
    expect(p).toEqual({ auto: true, provider: "claude-code", model: "haiku" });
  });

  it("read a missing or malformed preference as the default", () => {
    expect(parseDreamPrefs(null)).toEqual({ auto: false, provider: "", model: "" });
    expect(parseDreamPrefs("{not json")).toEqual({ auto: false, provider: "", model: "" });
    expect(parseDreamPrefs(JSON.stringify({ provider: 3 }))).toEqual({
      auto: false,
      provider: "",
      model: "",
    });
  });
});

describe("what a pass is sent", () => {
  const rail = () => ({
    ...defaultDraft(),
    agentBinary: " /opt/claude ",
    agentModel: "sonnet",
    agentSafeMode: true,
    provider: "anthropic",
    model: "claude-haiku-4-5",
  });

  it("is the engine with the rail's binary and safe mode when Settings picks it", () => {
    const t = passTargetFor({ auto: false, provider: DREAM_ENGINE, model: " haiku " }, rail());
    expect(t).toEqual({
      provider: "claude-code",
      model: "haiku",
      binary: "/opt/claude",
      safeMode: true,
    });
    // A blank alias is the CLI's default, not the rail's chat alias.
    expect(passTargetFor({ auto: false, provider: DREAM_ENGINE, model: "" }, rail()).model).toBeUndefined();
  });

  it("is the rail's Claude Code connection, alias included, when nothing is picked", () => {
    const d = { ...rail(), engine: "claude-code" as const };
    expect(passTargetFor({ auto: false, provider: "", model: "" }, d)).toEqual({
      provider: "claude-code",
      model: "sonnet",
      binary: "/opt/claude",
      safeMode: true,
    });
  });

  it("is the provider when one is picked, or the rail's provider when none is", () => {
    expect(passTargetFor({ auto: false, provider: "openrouter", model: "x" }, rail())).toEqual({
      provider: "openrouter",
      model: "x",
    });
    const t = passTargetFor({ auto: false, provider: "", model: "" }, rail());
    expect(t.provider).toBe("anthropic");
    expect(t.model).toBe("claude-haiku-4-5");
    expect(t.binary).toBeUndefined();
  });
});
