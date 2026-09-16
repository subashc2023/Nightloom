import { describe, expect, it } from "vitest";
import { CURATED, defaultDraft, type CatalogPrefs } from "./catalog";
import { CLAUDE_CODE, dreamEngineRows, dreamModelPills, dreamSentence, railNow } from "./dreamRows";
import type { ProviderInfo } from "./types";

// The dream row as rows and pills (nightshift backlog 071): the engine
// named plainly with what it bills, the model a pill and never a typed id.

const providers: ProviderInfo[] = [
  { kind: "anthropic", available: true, default_model: "claude-sonnet-5", key_source: "stored" },
  { kind: "openrouter", available: false, default_model: null, key_source: null },
];
const prefs: CatalogPrefs = { hiddenProviders: [], hiddenModels: {}, customModels: {} };

describe("dreamEngineRows", () => {
  it("lists the rail's connection, Claude Code, then each provider with what it bills", () => {
    const rows = dreamEngineRows(providers, defaultDraft());
    expect(rows.map((r) => r.value)).toEqual(["", CLAUDE_CODE, "anthropic", "openrouter"]);
    expect(rows[1]).toMatchObject({ name: "Claude Code", bills: "the subscription", warn: false });
    expect(rows[2]).toMatchObject({ bills: "its API key", warn: false, sub: "default model claude-sonnet-5" });
    expect(rows[3]).toMatchObject({ bills: "no key set", warn: true });
  });

  it("says what the rail is on right now, on either engine", () => {
    const d = defaultDraft();
    expect(railNow(d)).toMatch(/^Anthropic · .* · its API key$/);
    d.engine = "claude-code";
    d.agentModel = "haiku";
    expect(railNow(d)).toBe("Claude Code · haiku · the subscription");
    d.agentModel = "";
    expect(railNow(d)).toBe("Claude Code · the CLI's default · the subscription");
  });
});

describe("dreamModelPills", () => {
  it("offers nothing for the rail's connection, which brings its own model", () => {
    expect(dreamModelPills("", "", providers, prefs)).toEqual([]);
  });

  it("offers the CLI's aliases on Claude Code, the default first", () => {
    const pills = dreamModelPills(CLAUDE_CODE, "", providers, prefs);
    expect(pills[0]).toEqual({ value: "", label: "the CLI's default" });
    expect(pills.map((p) => p.value)).toEqual(["", "fable", "opus", "sonnet", "haiku"]);
  });

  it("offers a provider's picker list after its default, named", () => {
    const pills = dreamModelPills("anthropic", "", providers, prefs);
    expect(pills[0]).toEqual({ value: "", label: "default (claude-sonnet-5)" });
    expect(pills.slice(1).map((p) => p.value)).toEqual(
      expect.arrayContaining(CURATED["anthropic"] ?? []),
    );
  });

  it("keeps a stored id that is in neither list, so the old text box's value is not lost", () => {
    const pills = dreamModelPills("anthropic", "claude-typed-in-1", providers, prefs);
    expect(pills.at(-1)).toEqual({ value: "claude-typed-in-1", label: "claude-typed-in-1" });
    const aliases = dreamModelPills(CLAUDE_CODE, "sonnet", providers, prefs);
    expect(aliases.filter((p) => p.value === "sonnet")).toHaveLength(1);
  });
});

describe("dreamSentence", () => {
  const rows = dreamEngineRows(providers, defaultDraft());

  it("reads the engine, the model and the bill in one line", () => {
    expect(dreamSentence(rows, CLAUDE_CODE, "haiku", defaultDraft())).toBe(
      "Dreams and captures run on Claude Code · haiku, billed to the subscription.",
    );
    expect(dreamSentence(rows, "anthropic", "", defaultDraft())).toBe(
      "Dreams and captures run on Anthropic · its default model, billed to its API key.",
    );
  });

  it("names the rail's current connection when nothing is picked", () => {
    const d = defaultDraft();
    d.engine = "claude-code";
    d.agentModel = "opus";
    expect(dreamSentence(rows, "", "", d)).toBe(
      "Dreams and captures run on the rail's connection — Claude Code · opus · the subscription.",
    );
  });
});
