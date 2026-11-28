// @vitest-environment happy-dom
/*
 * Item 1026, drawn and driven in the DOM (item 980's rule): the tab strip's one button shows the Needs-you number,
 * opens a card with two modes, remembers the mode he used, and reopens on Needs you now when the number grows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./needsBoard.svelte", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, refreshBoard: async () => {} };
});
vi.mock("./state.svelte", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, refreshCentre: async () => {} };
});
// happy-dom cancels Web Animations on unmount; the card's 220 ms open is not what is tested here.
vi.mock("./hudMenu", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, hudIn: () => ({ duration: 0 }), hudOut: () => ({ duration: 0 }) };
});
import { flushSync, mount, unmount } from "svelte";
import "./asides.svelte";
import { app } from "./state.svelte";
import { needs } from "./needsBoard.svelte";
import NeedsYouBadge from "./NeedsYouBadge.svelte";
import type { OpenBlocker } from "./needsYou";

const held = (id: string): OpenBlocker => ({ project: "ns", projectName: "Nightshift", id, question: `Question ${id}?`, guess: "x", held: true, raised: "2026-11-20" });

let root: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (root) unmount(root);
  root = null;
  document.body.innerHTML = "";
  needs.blockers = [];
  app.centre.open = false;
  app.centre.mode = "needs";
  app.centre.needsSeen = 0;
  localStorage.clear();
});

function draw(): HTMLElement {
  const bar = document.createElement("div");
  document.body.append(bar);
  root = mount(NeedsYouBadge, { target: bar });
  flushSync();
  return bar;
}
const click = (el: Element | null | undefined) => {
  (el as HTMLElement).click();
  flushSync();
};
const tabs = () => [...document.querySelectorAll<HTMLElement>(".centre-modes .mode")];

describe("1026: one button, two modes", () => {
  it("shows the number, opens on Needs you now, switches, and remembers the mode", () => {
    needs.blockers = [held("1"), held("2")];
    const bar = draw();
    expect(bar.querySelector(".need-badge .n")?.textContent).toBe("2");
    expect(bar.querySelector(".centre-bell")).toBeNull();

    click(bar.querySelector(".need-badge"));
    expect(app.centre.open).toBe(true);
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(document.querySelectorAll(".ny-row").length).toBe(2);
    expect(app.centre.needsSeen).toBe(2);

    click(tabs()[1]);
    expect(app.centre.mode).toBe("digest");
    expect(document.querySelector(".centre-title")?.textContent).toBe("What happened");
    expect(localStorage.getItem("nightloom.centreMode")).toBe("digest");

    // Closed and reopened with the same number: his last mode.
    click(bar.querySelector(".need-badge"));
    click(bar.querySelector(".need-badge"));
    expect(app.centre.mode).toBe("digest");

    // The number grows: it opens on Needs you now.
    click(bar.querySelector(".need-badge"));
    needs.blockers = [held("1"), held("2"), held("3")];
    flushSync();
    click(bar.querySelector(".need-badge"));
    expect(app.centre.mode).toBe("needs");
  });

  it("with nothing waiting, the face is the bell and the card says so", () => {
    const bar = draw();
    expect(bar.querySelector(".need-badge")).toBeNull();
    click(bar.querySelector(".centre-bell"));
    expect(document.querySelector(".centre-empty")?.textContent).toBe("Nothing waits on you.");
    click(document.querySelector(".centre-foot .ns-btn"));
    expect(app.showNeeds).toBe(true);
    app.showNeeds = false;
  });
});
