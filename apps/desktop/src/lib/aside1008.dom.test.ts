// @vitest-environment happy-dom
/*
 * Item 1008 (verify sweep 2, rows 2 and 3): the REAL aside card mounted in a DOM.
 * - Its cache chip read "84kcached": Svelte 5 drops whitespace at the start and end of an element's content, so
 *   `<span class="head-word"> cached</span>` drew "cached" right after "84k". Every element built that way is
 *   swept (the same parse the compiler does), main chat and asides, desktop and phone.
 * - A composer aside (no passage, above the chat's composer) was capped at 50vh — at 1150×780 its composer foot
 *   left the thread ~150 px. It now grows into the transcript's viewport (`footCardMax`).
 * - Each trace block's foot showed the whole turn's elapsed; it now shows its own steps' span (`stepsSpan`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

vi.hoisted(() => {
  (globalThis as { __NIGHTLOOM_PLATFORM__?: string }).__NIGHTLOOM_PLATFORM__ = "macos";
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => {
    throw new Error("no backend");
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

await import("./asides.svelte");
const { app } = await import("./state.svelte");
const { footCardMax, MIN_CARD_HEIGHT, EDGE_MARGIN, CARD_GAP } = await import("./asideCard");
const { stepsSpan, fmtSecs } = await import("./turnTiming");
const AsideCard = (await import("./AsideCard.svelte")).default;

const swallow = (e: PromiseRejectionEvent) => e.preventDefault?.();
let mounted: Record<string, unknown>[] = [];
beforeEach(() => {
  app.activeSessionId = "chat-A";
  app.project = { id: "stats", name: "STATS 67", root: "/w", exists: true } as never;
  app.asides = [];
  document.body.innerHTML = "";
  window.addEventListener("unhandledrejection", swallow as never);
});
afterEach(() => {
  for (const c of mounted) unmount(c);
  mounted = [];
  window.removeEventListener("unhandledrejection", swallow as never);
});
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}
function aside() {
  return {
    id: 1,
    quote: null,
    draft: false,
    anchor: null,
    name: "Color pick",
    turns: [{ seq: 1, question: "Pick a colour", partial: "", answer: "Green", error: null, cancelled: false, cacheRead: 84_211 }],
  };
}

describe("1008: the aside's cache chip", () => {
  it('reads "84k cached", a space between the figure and the word', async () => {
    app.asides = [aside()] as never;
    mounted.push(mount(AsideCard, { target: document.body, props: { aside: app.asides[0], placement: null, front: true } }));
    await settle();
    const chip = document.querySelector(".aside-cache");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("84k cached");
  });
});

describe("1008: a composer aside grows into the transcript's room", () => {
  it("at 1150×780 (a ~527 px transcript viewport) the card may take the viewport, not 50vh (390)", () => {
    expect(footCardMax(527, 1)).toBe(527 - 2 * EDGE_MARGIN);
    expect(footCardMax(527, 1)!).toBeGreaterThan(390);
    // Two stacked share it; never under the floor; unmeasured keeps the stylesheet's 50vh.
    expect(footCardMax(527, 2)).toBe(Math.floor((527 - 2 * EDGE_MARGIN - CARD_GAP) / 2));
    expect(footCardMax(300, 1)).toBe(MIN_CARD_HEIGHT);
    expect(footCardMax(300, 3)).toBe(200);
    expect(footCardMax(0, 1)).toBeNull();
  });

  it("the mounted card carries that cap as its max-height", async () => {
    app.asides = [aside()] as never;
    mounted.push(mount(AsideCard, { target: document.body, props: { aside: app.asides[0], placement: null, front: true, footRoom: 527, footCount: 1 } }));
    await settle();
    const card = document.querySelector(".aside-card.foot") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.style.maxHeight).toBe(`${527 - 2 * EDGE_MARGIN}px`);
  });
});

describe("1008: each trace block shows its own elapsed", () => {
  it("the sweep's turn: seq ran 0:05–1:34, echo 1:40–1:57 — the blocks read 1 min 29 s and 17 s, not 1 min 57 s twice", () => {
    const t0 = 1_000_000;
    const rec = {
      t0,
      t1: t0 + 117_000,
      tps: 32,
      steps: {
        "t:seq": { start: t0 + 5_000, end: t0 + 94_000 },
        "t:echo": { start: t0 + 100_000, end: t0 + 117_000 },
      },
    };
    const end = rec.t1;
    expect(fmtSecs(stepsSpan(rec, ["t:seq"], end)!)).toBe("1 min 29 s");
    expect(fmtSecs(stepsSpan(rec, ["t:echo"], end)!)).toBe("17.0 s");
    // One block over both: its first start to its last end.
    expect(fmtSecs(stepsSpan(rec, ["t:seq", null, "t:echo"], end)!)).toBe("1 min 52 s");
    // A step still running ends now; a block with no timed step has no span (the foot keeps the turn's).
    expect(stepsSpan({ ...rec, steps: { "t:x": { start: t0, end: null } } }, ["t:x"], t0 + 4_000)).toBe(4_000);
    expect(stepsSpan(rec, ["t:none", null], end)).toBeNull();
  });
});
