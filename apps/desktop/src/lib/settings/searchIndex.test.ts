// Search in Settings (nightshift item 844): the index covers every card the
// modal renders, and the matching finds what he would type.
import { describe, expect, it } from "vitest";
import modalSrc from "../SettingsModal.svelte?raw";
import { CARDS, paneTitle, queryWords, searchSettings, settingsIndex } from "./searchIndex";
import { CONTROLS } from "./subscriptionPane";
import { settingsGroups } from "../settingsUsage";

const providers = [
  { kind: "anthropic", label: "Anthropic" },
  { kind: "openai", label: "OpenAI" },
];
const backends = [{ name: "brave", label: "Brave Search" }];
const index = settingsIndex(providers, backends);
const titleOf = (p: string) => paneTitle(p, providers, backends);
const groups = settingsGroups(["anthropic", "openai"], ["brave"]);
const groupOf = (p: string) => groups.find((g) => g.panes.includes(p))?.title ?? "";
const top = (q: string) => searchSettings(index, q, titleOf, groupOf)[0];

describe("the index (item 844)", () => {
  it("has every literal card title SettingsModal renders", () => {
    const titles = [...modalSrc.matchAll(/<div class="ch">\s*<span class="t">([^<{]+)<\/span>/g)].map((m) => m[1].trim());
    const known = new Set(index.map((e) => e.section));
    // Empty states, not settings; and the provider pane's own key card (in the index per provider).
    const skip = new Set(["No ledger yet"]);
    const missing = titles.filter((t) => !skip.has(t) && !known.has(t));
    expect(titles.length).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });

  it("has every Subscription control, with its fold", () => {
    for (const c of CONTROLS) {
      const e = index.find((x) => x.fold?.row === `subscription/${c.id}`);
      expect(e?.label).toBe(c.label);
      expect(e?.pane).toBe("claude-code");
    }
  });

  it("points only at panes the nav has", () => {
    const panes = new Set(groups.flatMap((g) => g.panes));
    for (const e of index) expect(panes.has(e.pane), e.pane).toBe(true);
  });

  it("titles every pane", () => {
    for (const e of index) expect(titleOf(e.pane)).not.toBe(e.pane.replace(/^search:/, ""));
    expect(CARDS.length).toBeGreaterThan(50);
  });
});

describe("matching (item 844)", () => {
  it("finds Quick Entry by its name and by 'shortcut' (848's terms)", () => {
    expect(top("quick entry")?.entry.pane).toBe("quick-entry");
    expect(top("shortcut")?.entry.pane).toBe("quick-entry");
  });

  it("finds a control by its label and says where it is", () => {
    const h = top("display on");
    expect(h?.title).toBe("Keep the display on too");
    expect(h?.where).toBe("System › Sleep");
    expect(top("hand off at")?.where).toBe("Subscription › Hand-off");
    expect(top("quick entry")?.where).toBe("System");
    expect(top("layout")?.where).toBe("Appearance › Palette");
    expect(top("brave key")?.where).toBe("Web search › Brave Search › API key");
  });

  it("finds by help text and by section", () => {
    expect(searchSettings(index, "caffeinate", titleOf).some((h) => h.entry.pane === "sleep")).toBe(true);
    expect(searchSettings(index, "bitwarden", titleOf).every((h) => h.entry.pane === "claude-code")).toBe(true);
    expect(top("notifications")?.entry.pane).toBe("notifications");
  });

  it("needs every word, ignores case, and is empty for a blank box", () => {
    expect(searchSettings(index, "", titleOf)).toEqual([]);
    expect(searchSettings(index, "   ", titleOf)).toEqual([]);
    expect(searchSettings(index, "zzqx", titleOf)).toEqual([]);
    expect(top("BRAVE key")?.entry.pane).toBe("search:brave");
    expect(queryWords(" Quick  Entry ")).toEqual(["quick", "entry"]);
  });

  it("says why when only the help matched", () => {
    const h = searchSettings(index, "pmset", titleOf).find((x) => x.entry.pane === "sleep");
    expect(h?.snippet).toContain("pmset");
    expect(h?.snippet).toMatch(/^…\S+ /);
    expect(h?.snippet).not.toMatch(/^…sertion/);
    expect(top("quick entry")?.snippet).toBeUndefined();
  });

  it("ranks a title match over a help match", () => {
    const hits = searchSettings(index, "layout", titleOf);
    expect(hits[0].title).toBe("Layout");
  });
});
