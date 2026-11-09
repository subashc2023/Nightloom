import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import paletteSrc from "./Palette.svelte?raw";
import {
  NEWEST,
  aliasView,
  cliVersionOf,
  currentCliVersion,
  displayName,
  fullIdRows,
  newestModels,
  otherOn,
  parseSeen,
  recordSeen,
  type SeenModels,
} from "./modelSeen";

/** Item 511: the model menu names the model behind each alias, by number. */
const at = new Date("2026-11-09T15:30:00Z");
const seenFable: SeenModels = { fable: { id: "claude-fable-5-1", cliVersion: "2.1.321", seenAt: at.toISOString() } };

describe("a model's display name from its id (511)", () => {
  it("capitalises the family and dots the version", () => {
    expect(displayName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(displayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(displayName("claude-sonnet-4")).toBe("Sonnet 4");
  });
  it("drops a snapshot date, reads the old order, and keeps a [1m] tag", () => {
    expect(displayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(displayName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(displayName("claude-opus-5-5[1m]")).toBe("Opus 5.5 [1m]");
  });
  it("shows an id it cannot read as the id itself", () => {
    expect(displayName("gpt-5")).toBe("gpt-5");
    expect(displayName("claude-weird-model-x")).toBe("claude-weird-model-x");
  });
  it("reads the CLI's version out of what --version printed", () => {
    expect(cliVersionOf("2.1.321 (Claude Code)")).toBe("2.1.321");
    expect(cliVersionOf(null)).toBe(null);
    expect(currentCliVersion(null, "2.1.300 (Claude Code)")).toBe("2.1.300");
    expect(currentCliVersion("2.1.321", "2.1.300 (Claude Code)")).toBe("2.1.321");
  });
});

describe("learning alias → id from turns (511)", () => {
  it("records an alias's and the default's resolution, not a full id's", () => {
    let s = recordSeen({}, "fable", "claude-fable-5-1", "2.1.321", at);
    s = recordSeen(s, "", "claude-opus-5-5", "2.1.321", at);
    expect(s.fable).toEqual({ id: "claude-fable-5-1", cliVersion: "2.1.321", seenAt: at.toISOString() });
    expect(s[""].id).toBe("claude-opus-5-5");
    expect(recordSeen(s, "claude-fable-5-2", "claude-fable-5-2", "2.1.321", at)).toBe(s);
    expect(recordSeen(s, "sonnet", null, "2.1.321", at)).toBe(s);
  });
  it("round-trips through storage and drops a malformed record", () => {
    const raw = JSON.stringify({ ...seenFable, opus: { id: 5 }, sonnet: "x" });
    expect(parseSeen(raw)).toEqual(seenFable);
    expect(parseSeen("not json")).toEqual({});
    expect(parseSeen(null)).toEqual({});
  });
});

describe("stale vs current CLI version (511)", () => {
  it("names the model when the record is from the CLI now", () => {
    const v = aliasView(seenFable, "fable", "2.1.321");
    expect(v.detail).toBe("· Fable 5.1");
    expect(v.title).toContain("claude-fable-5-1");
  });
  it("says not seen on the new version when the CLI moved on", () => {
    const v = aliasView(seenFable, "fable", "2.1.330");
    expect(v.current).toBe(null);
    expect(v.detail).toBe("· not seen on 2.1.330 yet");
    expect(v.title).toContain("it was claude-fable-5-1 on Claude Code 2.1.321");
  });
  it("says not seen when nothing ran on it; not seen yet with no version", () => {
    expect(aliasView(seenFable, "sonnet", "2.1.321").detail).toBe("· not seen on 2.1.321 yet");
    expect(aliasView({}, "sonnet", null).detail).toBe("· not seen yet");
    // An unknown version trusts the record it has.
    expect(aliasView(seenFable, "fable", null).detail).toBe("· Fable 5.1");
  });
  it("names a full id in the list by itself", () => {
    expect(aliasView({}, "claude-opus-5-5", "2.1.321").detail).toBe("· Opus 5.5");
  });
});

describe("the newest models: table vs the API's list (511)", () => {
  it("is the shipped table without an API list", () => {
    expect(newestModels(undefined)).toEqual([...NEWEST]);
    expect(newestModels([])).toEqual(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });
  it("is each family's newest from the API's list when there is one", () => {
    const api = ["claude-opus-5-1", "claude-opus-5-6", "claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-sonnet-5-5-20261001", "claude-fable-5-3"];
    expect(newestModels(api)).toEqual(["claude-fable-5-3", "claude-opus-5-6", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]);
  });
  it("skips a newest row an alias already shows, and one the list holds", () => {
    const rows = fullIdRows(NEWEST, ["fable", "opus", "sonnet", "haiku"], { opus: { id: "claude-opus-5-5", cliVersion: "2.1.321", seenAt: "x" } }, "2.1.321", "");
    expect(rows.map((r) => r.pick)).toEqual(["claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(fullIdRows(NEWEST, ["fable", "claude-haiku-5-5"], {}, "2.1.321", "").map((r) => r.pick)).not.toContain("claude-haiku-5-5");
    // A stale record shows nothing, so its row stays.
    const stale = { opus: { id: "claude-opus-5-5", cliVersion: "2.1.300", seenAt: "x" } };
    expect(fullIdRows(NEWEST, ["opus"], stale, "2.1.321", "").map((r) => r.pick)).toContain("claude-opus-5-5");
  });
});

describe("picking a full id (511)", () => {
  it("a newest row picks its id exactly and is on for it; other… is not", () => {
    const rows = fullIdRows(NEWEST, ["fable", "opus"], seenFable, "2.1.321", "claude-fable-5-2");
    const fable = rows.find((r) => r.label === "Fable 5.2")!;
    expect(fable.pick).toBe("claude-fable-5-2");
    expect(fable.on).toBe(true);
    expect(rows.filter((r) => r.on)).toHaveLength(1);
    expect(otherOn("claude-fable-5-2", ["fable", "opus"], rows)).toBe(false);
  });
  it("a full id typed by hand keeps other… on", () => {
    const rows = fullIdRows(NEWEST, ["fable"], {}, "2.1.321", "claude-opus-4-1");
    expect(rows.some((r) => r.on)).toBe(false);
    expect(otherOn("claude-opus-4-1", ["fable"], rows)).toBe(true);
    expect(otherOn("fable", ["fable"], rows)).toBe(false);
    expect(otherOn("", ["fable"], rows)).toBe(false);
  });
  it("the menus send the row's id through switchModel, as a typed id goes", () => {
    expect(composerSrc).toContain("run: () => void switchModel(f.pick)");
    expect(paletteSrc).toContain("run: () => go(() => void switchModel(f.pick))");
  });
});
