import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import paletteSrc from "./Palette.svelte?raw";
import railSrc from "./ProviderRail.svelte?raw";
import { NEWEST, familyRows, otherOnRows, type SeenModels } from "./modelSeen";
import { modelChipLabel } from "./catalog";

/** Item 518: one model row per family, the alias noted when it lags. */
const LIST = ["fable", "opus", "sonnet", "haiku"];
const seen = (m: Record<string, string>): SeenModels =>
  Object.fromEntries(Object.entries(m).map(([a, id]) => [a, { id, cliVersion: "2.1.321", seenAt: "2026-11-09T00:00:00Z" }]));
const rows = (s: SeenModels, cur: string, list = LIST) => familyRows(list, NEWEST, s, "2.1.321", cur);

describe("familyRows (item 518)", () => {
  it("an alias equal to the newest: one row, labelled with the newest, picking its full id", () => {
    const r = rows(seen({ opus: "claude-opus-5-5" }), "");
    const opus = r.filter((x) => x.label.startsWith("Opus") || x.pick === "opus");
    expect(opus).toHaveLength(1);
    expect(opus[0]).toMatchObject({ label: "Opus 5.5", pick: "claude-opus-5-5", kind: "family", capAlias: "opus" });
    expect(opus[0].note).toBe("the opus alias too");
    // Four families, four rows: nothing doubled.
    expect(r.map((x) => x.key)).toEqual(["family:fable", "family:opus", "family:sonnet", "family:haiku"]);
  });

  it("an alias lagging the newest: still one row, the alias noted on it", () => {
    const r = rows(seen({ fable: "claude-fable-5-1" }), "");
    const fable = r.filter((x) => x.key.endsWith(":fable") || x.pick.includes("fable"));
    expect(fable).toHaveLength(1);
    expect(fable[0]).toMatchObject({ label: "Fable 5.2", pick: "claude-fable-5-2", note: "fable alias = 5.1", capAlias: null });
    expect(fable[0].detail).toBe("claude-fable-5-2 · fable alias = 5.1");
  });

  it("an alias not seen on this CLI: one row, saying its number is not known", () => {
    const [fable] = rows({}, "");
    expect(fable.note).toBe("fable alias not seen yet");
    expect(fable.title).toContain("2.1.321");
    expect(fable.capAlias).toBe("fable");
  });

  it("a chat on a lagging alias: a second row for the alias, selected", () => {
    const r = rows(seen({ fable: "claude-fable-5-1" }), "fable");
    expect(r.map((x) => x.key).slice(0, 2)).toEqual(["family:fable", "lagging:fable"]);
    expect(r[0].on).toBe(false);
    expect(r[1]).toMatchObject({ pick: "fable", on: true, version: "5.1", capAlias: "fable" });
    expect(r.filter((x) => x.on)).toHaveLength(1);
    expect(otherOnRows("fable", r)).toBe(false);
  });

  it("a chat on an alias equal to the newest (or not yet seen): the merged row is selected", () => {
    const r = rows(seen({ opus: "claude-opus-5-5" }), "opus");
    expect(r.find((x) => x.on)).toMatchObject({ key: "family:opus", detail: "claude-opus-5-5 · the opus alias too · current, as opus" });
    expect(rows({}, "fable").find((x) => x.on)?.key).toBe("family:fable");
    expect(r.some((x) => x.kind === "lagging")).toBe(false);
  });

  it("a chat on the full id: the merged row is selected", () => {
    const r = rows(seen({ fable: "claude-fable-5-1" }), "claude-fable-5-2");
    expect(r.filter((x) => x.on).map((x) => x.key)).toEqual(["family:fable"]);
    expect(otherOnRows("claude-fable-5-2", r)).toBe(false);
  });

  it("an alias newer than the shipped table: the row is labelled with what the alias resolves to", () => {
    const [fable] = rows(seen({ fable: "claude-fable-5-3" }), "");
    expect(fable).toMatchObject({ label: "Fable 5.3", pick: "claude-fable-5-3", note: "the fable alias too" });
  });

  it("a full id in the list that a family row picks is not listed twice; other entries keep a row", () => {
    const r = rows({}, "", ["fable", "claude-fable-5-2", "opusplan", "claude-opus-4-1"]);
    expect(r.map((x) => x.key)).toEqual([
      "family:fable",
      "alias:opusplan",
      "full:claude-opus-4-1",
      "newest:claude-opus-5-5",
      "newest:claude-sonnet-5-5",
      "newest:claude-haiku-5-5",
    ]);
  });

  it("a full id no row names lights other…", () => {
    const r = rows({}, "claude-opus-4-1");
    expect(otherOnRows("claude-opus-4-1", r)).toBe(true);
    expect(otherOnRows("", r)).toBe(false);
  });

  it("the composer, the palette and the rail list familyRows", () => {
    expect(composerSrc).toContain("familyRows(AGENT_PILLS, newestIds");
    expect(paletteSrc).toContain("familyRows(aliases, newestModels(");
    expect(railSrc).toContain("familyRows(AGENT_PILLS, newestIds");
  });

  it("the chip names a full id by its model, an alias as it is", () => {
    const chip = (agentModel: string) => modelChipLabel({ agentMode: true, agentModel, model: "", connected: null });
    expect(chip("claude-fable-5-2")).toBe("Fable 5.2");
    expect(chip("fable")).toBe("fable");
    expect(chip("my-own-alias")).toBe("my-own-alias");
  });
});
