import { describe, expect, it } from "vitest";
import { DREAM_ENGINE, DREAM_PREFS_VERSION, parseDreamPrefs, passTargetFor } from "./state.svelte";
import { defaultDraft } from "./catalog";

/** The usage limits every parsed preference carries (item 279). */
const LIM = { limitFiveHour: 50, limitWeek: 80 };

// Settings → Knowledge's dream row can name the Claude Code engine since
// 2026-09-16 (nightshift backlog 070). What the preference stores and what
// a pass is then sent are the two halves the backend's routing relies on.

describe("dream preferences", () => {
  it("keep the Claude Code engine as a real provider value", () => {
    const p = parseDreamPrefs(JSON.stringify({ auto: true, provider: DREAM_ENGINE, model: "haiku" }));
    expect(p).toEqual({ auto: true, provider: "claude-code", model: "haiku", ...LIM });
  });

  it("read a missing or malformed preference as the default, which is on (item 278)", () => {
    expect(parseDreamPrefs(null)).toEqual({ auto: true, provider: "", model: "", ...LIM });
    expect(parseDreamPrefs("{not json")).toEqual({ auto: true, provider: "", model: "", ...LIM });
    expect(parseDreamPrefs(JSON.stringify({ provider: 3 }))).toEqual({
      auto: true,
      provider: "",
      model: "",
      ...LIM,
    });
  });

  it("read stored prefs without the usage limits as the defaults, keeping the switch (item 279)", () => {
    // Saved by a 278 build: version 2, his off, no limits.
    const old = parseDreamPrefs(JSON.stringify({ auto: false, provider: DREAM_ENGINE, model: "", v: DREAM_PREFS_VERSION }));
    expect(old).toEqual({ auto: false, provider: DREAM_ENGINE, model: "", ...LIM });
    // Saved limits are kept; nonsense reads as the default, out-of-range is clamped.
    const set = parseDreamPrefs(JSON.stringify({ v: DREAM_PREFS_VERSION, auto: true, limitFiveHour: 30, limitWeek: 95 }));
    expect([set.limitFiveHour, set.limitWeek]).toEqual([30, 95]);
    const bad = parseDreamPrefs(JSON.stringify({ v: DREAM_PREFS_VERSION, limitFiveHour: "x", limitWeek: 250 }));
    expect([bad.limitFiveHour, bad.limitWeek]).toEqual([50, 100]);
  });

  it("read a pre-278 off as on, and keep an off saved since", () => {
    // Stored before the version existed, when off was the default and
    // meant "after a compaction" — a trigger he never fires.
    expect(parseDreamPrefs(JSON.stringify({ auto: false, provider: "", model: "" })).auto).toBe(true);
    expect(parseDreamPrefs(JSON.stringify({ auto: false, provider: "", model: "", v: DREAM_PREFS_VERSION })).auto).toBe(
      false,
    );
    expect(parseDreamPrefs(JSON.stringify({ auto: true, v: DREAM_PREFS_VERSION })).auto).toBe(true);
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
    const t = passTargetFor({ auto: false, provider: DREAM_ENGINE, model: " haiku ", ...LIM }, rail());
    expect(t).toEqual({
      provider: "claude-code",
      model: "haiku",
      binary: "/opt/claude",
      safeMode: true,
    });
    // A blank alias is the CLI's default, not the rail's chat alias.
    expect(passTargetFor({ auto: false, provider: DREAM_ENGINE, model: "", ...LIM }, rail()).model).toBeUndefined();
  });

  it("is the rail's Claude Code connection, alias included, when nothing is picked", () => {
    const d = { ...rail(), engine: "claude-code" as const };
    expect(passTargetFor({ auto: false, provider: "", model: "", ...LIM }, d)).toEqual({
      provider: "claude-code",
      model: "sonnet",
      binary: "/opt/claude",
      safeMode: true,
    });
  });

  it("is the provider when one is picked, or the rail's provider when none is", () => {
    expect(passTargetFor({ auto: false, provider: "openrouter", model: "x", ...LIM }, rail())).toEqual({
      provider: "openrouter",
      model: "x",
    });
    const t = passTargetFor({ auto: false, provider: "", model: "", ...LIM }, rail());
    expect(t.provider).toBe("anthropic");
    expect(t.model).toBe("claude-haiku-4-5");
    expect(t.binary).toBeUndefined();
  });
});
