// @vitest-environment happy-dom
/*
 * Item 995 (the verify sweep, 2026-11-25): Home's line said "Nothing needs you — Home is watching." while the top
 * pill said "5 need you" (4 held blockers + 1 memory proposal) and the line beside it counted "21 blockers · 20
 * shipped items" (every open blocker, decided ones included). Every surface is drawn here from ONE seeded state and
 * read back from the DOM: the pill, Home's Watching tab, Home's status line and its quiet line, the sidebar's Home
 * count and the bell's foot line (both `homeNeedsNow().waiting`, the number the pill draws); then the empty case.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The board's file read goes to the backend (none in a test): the seeded rows stay as set.
vi.mock("../needsBoard.svelte", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, refreshBoard: async () => {} };
});
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import "../asides.svelte";
import { app } from "../state.svelte";
import { needs, homeNeedsNow } from "../needsBoard.svelte";
import { home } from "../home.svelte";
import { homeCount } from "../home";
import NeedsYouBadge from "../NeedsYouBadge.svelte";
import Stage from "./Stage.svelte";
import type { OpenBlocker, ShippedItem } from "../needsYou";

const roots: ReturnType<typeof mount>[] = [];
afterEach(() => {
  while (roots.length) unmount(roots.pop()!);
  document.body.innerHTML = "";
  needs.blockers = [];
  needs.shipped = [];
  needs.ended = [];
  app.centre.proposals = [];
});

const blocker = (id: string, held: boolean): OpenBlocker => ({ project: "ns", projectName: "Nightshift", id, question: `Question ${id}?`, guess: "x", held, raised: "2026-11-20" });
const shipped = (id: string): ShippedItem => ({ project: "ns", projectName: "Nightshift", id, title: `Item ${id}`, shipped: "2026-11-24" });

/** The sweep's state: 4 held blockers, 17 decided, 20 shipped items, 1 memory proposal, nothing in his chats. */
function seedSweep() {
  needs.blockers = [
    ...["2290", "2292", "2300", "2301"].map((id) => blocker(id, true)),
    ...Array.from({ length: 17 }, (_, i) => blocker(String(2280 + i), false)),
  ];
  needs.shipped = Array.from({ length: 20 }, (_, i) => shipped(String(960 + i)));
  app.centre.proposals = [
    { project: null, entry: { id: "p1", proposal: { at: "2026-11-25T10:00:00Z", why: "A rule he repeated", screened: null } } } as never,
  ];
}

function draw() {
  app.view = "chat";
  app.activeSessionId = "home-chat";
  app.events = [];
  const children = createRawSnippet(() => ({ render: () => "<div></div>" }));
  const bar = document.createElement("div");
  const stage = document.createElement("div");
  document.body.append(bar, stage);
  roots.push(mount(NeedsYouBadge, { target: bar }));
  roots.push(mount(Stage, { target: stage, props: { blank: false, children } }));
  flushSync();
  return { bar, stage };
}

describe("995: one Needs-you number on every surface", () => {
  it("held blockers + a proposal: the pill, the tab, Home's line, the sidebar and the bell all say 5", () => {
    seedSweep();
    const { bar, stage } = draw();
    // The pill.
    expect(bar.querySelector(".need-badge .n")?.textContent).toBe("5");
    expect(bar.querySelector(".need-badge")?.getAttribute("aria-label")).toBe("5 need you — open the needs-you list");
    // Home's Watching tab.
    expect(stage.querySelector('.h9-tab .cnt')?.textContent).toBe("5");
    // Home's status line: never "Nothing needs you" beside a 5.
    const line = stage.querySelector("[data-home-line]")?.textContent ?? "";
    expect(line).toBe("5 need you — none of it in your chats.");
    expect(stage.textContent).not.toContain("Nothing needs you");
    // Its quiet line: the held ones and the proposal (the pill's 5), the shipped ones to review; no decided blockers.
    const quiet = stage.querySelector(".w-else-t")?.textContent ?? "";
    expect(quiet).toBe("4 held blockers · 1 proposal · 20 shipped items to review");
    expect(quiet).not.toContain("21");
    // The sidebar's Home count and the bell's foot line read this same number.
    expect(homeNeedsNow().waiting).toBe(5);
    expect(homeCount(homeNeedsNow().waiting)).toBe("5 need you");
  });

  it("a Start card counts on every surface too", () => {
    seedSweep();
    home.cards = [{ id: "r1" } as never];
    try {
      const { bar, stage } = draw();
      expect(bar.querySelector(".need-badge .n")?.textContent).toBe("6");
      expect(stage.querySelector('.h9-tab .cnt')?.textContent).toBe("6");
      expect(stage.querySelector("[data-home-line]")?.textContent).toBe("6 need you — none of it in your chats.");
      expect(homeNeedsNow().waiting).toBe(6);
    } finally {
      home.cards = [];
    }
  });

  it("only decided blockers and shipped items: nothing needs him — the line says so and the pill has no number", () => {
    needs.blockers = [blocker("2280", false)];
    needs.shipped = [shipped("960")];
    const { bar, stage } = draw();
    expect(bar.querySelector(".need-badge .n")).toBeNull();
    // Item 1026: no number, so the face is the bell with "to review" beside it.
    expect(bar.querySelector(".need-badge")).toBeNull();
    expect(bar.querySelector(".centre-bell .review")?.textContent).toBe("to review");
    expect(stage.querySelector('.h9-tab .cnt')).toBeNull();
    expect(stage.querySelector("[data-home-line]")?.textContent).toMatch(/^Nothing needs you/);
    expect(stage.querySelector(".w-else-t")?.textContent).toBe("1 shipped item to review");
    expect(homeNeedsNow().waiting).toBe(0);
    expect(homeCount(0)).toBe("");
  });

  it("nothing at all: 'Nothing needs you', no pill, no count", () => {
    const { bar, stage } = draw();
    expect(bar.querySelector(".need-badge")).toBeNull();
    expect(stage.querySelector('.h9-tab .cnt')).toBeNull();
    expect(stage.querySelector("[data-home-line]")?.textContent).toMatch(/^Nothing needs you/);
    expect(stage.querySelector(".w-else-t")).toBeNull();
  });
});
