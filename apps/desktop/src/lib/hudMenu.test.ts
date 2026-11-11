import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HUD_CLOSE_MS, HUD_OPEN_MS, HUD_PICK_MS, HUD_PICK_WINDOW_MS, hudExit, hudOrigin } from "./hudMenu";
import ts from "./hudMenu.ts?raw";

/*
 * Item 620: one shared menu (HUD brackets) on every dropdown and right-click
 * menu. The pure parts, and the wiring: every menu of the census carries the
 * card class and both transitions, and Classic is never touched.
 */
// Read from disk: vitest hands a `.css?raw` import back empty.
const css = readFileSync(new URL("./hudMenu.css", import.meta.url), "utf8");
const sources = import.meta.glob("./*.svelte", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const src = (name: string) => sources[`./${name}.svelte`];

/** Each census menu: the file, and how many menus it draws. */
const CENSUS: [string, number][] = [
  ["ProjectMenu", 1],
  ["ScheduleMenu", 1],
  ["Composer", 2], // the model / effort / drafts snippet (one piece of markup), and the slash list
  ["CouncilPopover", 1],
  ["ClipPanel", 1],
  ["TurnCapChip", 1],
  ["TopBar", 2], // the engine card and the context-and-plan card
  ["ThreadChip", 1],
  ["ForYouButton", 1],
  ["NotificationCentre", 1],
  ["AsidesList", 1],
  ["TabChooser", 1],
  ["TabStrip", 1],
  ["Sidebar", 4], // thread menu, chat row menu, its flyout, New chat ▾
  ["SidebarAsides", 1],
  ["NotesPanel", 2],
  ["NoteToolbar", 1],
  ["NoteView", 1],
  ["ReviewMorning", 1],
];

describe("620 where a menu opens from", () => {
  const menu = { left: 100, top: 200, width: 240, height: 300 };
  it("a button above the menu: a point on the menu's top edge, under the button's centre", () => {
    expect(hudOrigin(menu, { left: 100, right: 300, top: 160, bottom: 190 })).toEqual({ x: 100, y: 0 });
  });
  it("a button below the menu: a point on its bottom edge", () => {
    expect(hudOrigin(menu, { left: 300, right: 340, top: 510, bottom: 540 })).toEqual({ x: 220, y: 300 });
  });
  it("a right-click: the pointer's own spot (the menu's corner)", () => {
    expect(hudOrigin(menu, { left: 100, right: 100, top: 200, bottom: 200 })).toEqual({ x: 0, y: 0 });
  });
  it("nothing known: the top-left corner", () => {
    expect(hudOrigin(menu, null)).toEqual({ x: 0, y: 0 });
  });
});

describe("620 a close is a pick or a dismiss", () => {
  const row = { id: "row" } as unknown as HTMLElement;
  const lit = { id: "lit" } as unknown as HTMLElement;
  const menu = { contains: (n: unknown) => n === row, querySelector: () => lit } as unknown as Element;
  const other = { contains: () => false, querySelector: () => null } as unknown as Element;
  it("a row clicked just before the close is the pick", () => {
    expect(hudExit(menu, 1000, { menu, row, t: 990 }, -1)).toBe(row);
  });
  it("a click that awaited first still counts, inside the window", () => {
    expect(hudExit(menu, 1000 + HUD_PICK_WINDOW_MS, { menu, row, t: 1000 }, -1)).toBe(row);
    expect(hudExit(menu, 1001 + HUD_PICK_WINDOW_MS, { menu, row, t: 1000 }, -1)).toBeNull();
  });
  it("a pick in another menu (a flyout) leaves this one a dismiss", () => {
    expect(hudExit(other, 1000, { menu, row, t: 990 }, -1)).toBeNull();
  });
  it("no click: a dismiss", () => {
    expect(hudExit(menu, 1000, null, -1)).toBeNull();
  });
  it("Enter on a list's lit row picks that row", () => {
    expect(hudExit(menu, 1000, null, 900)).toBe(lit);
    expect(hudExit(menu, 2000, null, 900)).toBeNull();
  });
});

describe("620 the timings are the design's", () => {
  it("open 220, pick 300, dismiss 150 — in the script and the sheet", () => {
    expect([HUD_OPEN_MS, HUD_PICK_MS, HUD_CLOSE_MS]).toEqual([220, 300, 150]);
    expect(css).toMatch(/\.hud-m\.hud-in \{\s*animation: hud-glass-in 220ms/);
    expect(css).toMatch(/\.hud-m\.hud-pick \{\s*animation: hud-glass-clear 300ms/);
    expect(css).toMatch(/\.hud-m\.hud-out \{\s*animation: hud-glass-out 150ms/);
  });
});

describe("620 every menu of the census is on the shared menu", () => {
  for (const [name, n] of CENSUS) {
    it(`${name}: ${n} menu${n === 1 ? "" : "s"} with the card class and both transitions`, () => {
      const s = src(name);
      expect(s).toBeTruthy();
      expect(s).toContain('import { hudIn, hudOut } from "./hudMenu";');
      expect(s.match(/class="[^"]*\bhud-m\b[^"]*"/g)?.length).toBe(n);
      expect(s.match(/in:hudIn\|global/g)?.length).toBe(n);
      expect(s.match(/out:hudOut\|global/g)?.length).toBe(n);
    });
  }
  it("25 pieces of markup in 19 files carry the census's 28 menus (model, effort and drafts share one snippet; the thread picker's list rides in the thread chip's card)", () => {
    expect(CENSUS.length).toBe(19);
    expect(CENSUS.reduce((a, [, n]) => a + n, 0)).toBe(25);
  });
});

describe("620 Classic keeps its menus", () => {
  it("every rule that touches a menu is keyed off Classic", () => {
    const rules = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
      .split("}")
      .map((r) => r.split("{")[0].trim())
      .filter(Boolean);
    expect(rules.length).toBeGreaterThan(20);
    for (const sel of rules) {
      for (const one of sel.split(/,\s*\n/)) {
        const s = one.trim();
        // The frame is only ever made outside Classic (hudMenu.ts), so its own rules need no gate.
        if (s.startsWith(".hud-frame") || s.startsWith('[data-light="calm"] .hud-frame')) continue;
        expect(s.startsWith(':root:not([data-layout="classic"]) .hud-m'), s).toBe(true);
      }
    }
  });
  it("the script makes no frame and takes no time in Classic", () => {
    expect(ts).toMatch(/if \(classic\(\) \|\| typeof requestAnimationFrame === "undefined"\) return \{ duration: 0 \};/);
    expect(ts).toMatch(/if \(classic\(\) \|\| !l\) return \{ duration: 0 \};/);
  });
  it("the Classic twins are not on it", () => {
    for (const name of ["SidebarClassic", "TopBarClassic", "TabStripClassic", "SidebarAsidesClassic"]) {
      expect(src(name)).not.toContain("hudMenu");
    }
  });
});
