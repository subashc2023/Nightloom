// Items 629 / 630 / 628 / 631 (wave 5, agent C): each Appearance control
// changes only what it names; the one-time migration keeps every saved
// look as it was drawn; Jarvis is a label only; the pick motion.
import { describe, expect, it } from "vitest";
import welcome from "./Welcome.svelte?raw";
import rightRail from "./RightRail.svelte?raw";
import taskPanel from "./TaskPanel.svelte?raw";
import settingsModal from "./SettingsModal.svelte?raw";
import { migrateLook, parseMotionInk, parseNewChat, type LookStore } from "./settings/look.svelte";
import { picksIn } from "./settings/pickMotion";

// vitest empties CSS imports, so app.css is read from disk.
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const appCss = fs.readFileSync(new URL("../app.css", import.meta.url), "utf8");

function store(init: Record<string, string>): LookStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

/** What the page drew before item 629, from the saved palette and light. */
function before(s: Record<string, string>) {
  const bcd = ["B", "C", "D"].includes(s["nightloom.palette"]);
  const calm = s["nightloom.light"] === "calm";
  return { row: calm || bcd, motionAccent: bcd, light: !calm && !bcd };
}
/** What the page draws after, from the stored choices alone. */
function after(s: Record<string, string>) {
  return {
    row: parseNewChat(s["nightloom.newchat"] ?? null) === "row",
    motionAccent: parseMotionInk(s["nightloom.motionInk"] ?? null) === "accent",
    light: s["nightloom.light"] !== "calm",
  };
}

describe("migration: a saved look draws the same on first launch", () => {
  const cases: Record<string, string>[] = [];
  for (const p of [undefined, "A", "B", "C", "D"])
    for (const l of [undefined, "calm"]) {
      const c: Record<string, string> = { "nightloom.look": "filament" };
      if (p) c["nightloom.palette"] = p;
      if (l) c["nightloom.light"] = l;
      cases.push(c);
    }
  for (const c of cases)
    it(`palette ${c["nightloom.palette"] ?? "(none)"}, light ${c["nightloom.light"] ?? "lit"}`, () => {
      const s = store(c);
      expect(migrateLook(s)).toBe(true);
      expect(after(s.data)).toEqual(before(c));
    });
  it("his saved look (palette A, Lit, links in the browser) stores nothing new but the marker", () => {
    const s = store({ "nightloom.look": "filament", "nightloom.palette": "A", "nightloom.links": "browser" });
    migrateLook(s);
    expect(s.data).toEqual({ "nightloom.look": "filament", "nightloom.palette": "A", "nightloom.links": "browser", "nightloom.lookSplit": "1" });
  });
  it("runs once: a later pick is never overwritten", () => {
    const s = store({ "nightloom.palette": "B" });
    migrateLook(s);
    expect(s.data["nightloom.newchat"]).toBe("row");
    delete s.data["nightloom.newchat"]; // he picks the wheel (the default stores nothing)
    s.data["nightloom.light"] = "lit-picked";
    expect(migrateLook(s)).toBe(false);
    expect(s.data["nightloom.newchat"]).toBeUndefined();
  });
});

describe("no palette or light gate left on layout or motion", () => {
  it("the new-chat row reads data-newchat only", () => {
    const style = welcome.slice(welcome.lastIndexOf("<style>"));
    expect(style).not.toMatch(/data-palette="(B|C|D|classic-A)"/);
    expect(style).not.toContain('data-light="calm"');
    expect(style).toContain(':global([data-newchat="row"]) .wide .ready');
  });
  it("the light-off block names Calm and the Classic layout, no palette", () => {
    const at = appCss.indexOf("/* Calm (IV), and the Classic layout");
    const block = appCss.slice(at, appCss.indexOf("}", at));
    expect(block).toContain('[data-light="calm"],\n[data-layout="classic"] {');
    expect(block).not.toMatch(/\[data-palette=/);
  });
  it("the motion ink reads data-motion-ink, not the palette", () => {
    expect(appCss).toContain(':root:not([data-layout="classic"]):not([data-motion-ink="accent"]) {');
    expect(appCss).not.toContain(':root:not([data-layout="classic"]):is(:not([data-palette]), [data-palette="A"])');
  });
  it("Calm no longer re-sets the right column's headings", () => {
    expect(rightRail).not.toContain(':global([data-light="calm"]) .col h4');
    expect(taskPanel).not.toContain(':global([data-light="calm"]) .tcol h4');
  });
});

describe("628: Jarvis is a label", () => {
  it("names palette A Jarvis under Filament IV, keeps the id A", () => {
    expect(settingsModal).toContain('if (id === "A" && !classic()) return "Jarvis";');
    expect(settingsModal).not.toContain('return "Filament IV";');
  });
});

describe("631: which pick moved", () => {
  function rec(target: Element, oldValue: string): MutationRecord {
    return { type: "attributes", attributeName: "aria-checked", target, oldValue } as unknown as MutationRecord;
  }
  // No DOM in this test environment: just what `picksIn` reads.
  const root = { contains: () => true } as unknown as Element;
  function opt(group: object, checked: boolean): Element {
    return { closest: () => group, getAttribute: () => String(checked) } as unknown as Element;
  }
  it("pairs the option left with the option picked, per group", () => {
    const seg = {};
    const cards = {};
    const a = opt(seg, false);
    const b = opt(seg, true);
    const c = opt(cards, true);
    const out = picksIn([rec(a, "true"), rec(b, "false"), rec(c, "false")], root);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ group: seg, from: a, to: b });
    expect(out[1]).toMatchObject({ group: cards, from: null, to: c });
  });
  it("ignores a change that is not one, and options outside a group", () => {
    const a = opt({}, true);
    expect(picksIn([rec(a, "true")], root)).toEqual([]);
    const loose = { closest: () => null, getAttribute: () => "true" } as unknown as Element;
    expect(picksIn([rec(loose, "false")], root)).toEqual([]);
  });
});
