// @vitest-environment happy-dom
/*
 * Item 1035 (repeat of 734): "this fuckin aside is stuck on my screen". 734 made a dragged card
 * `absolute` in the chat column, but a card with no passage on screen — a composer aside, or a
 * passage aside whose passage cannot be found after a reload, a relaunch or a hand-off — was still
 * `position: sticky` at the viewport's foot (blocker 225's default), so it stayed on screen while the
 * chat scrolled under it. 734's test read `.moved`'s CSS as text and never saw `.foot`.
 *
 * This test mounts the REAL card in every state he can reach and reads the position it is drawn
 * with (behaviour, not source text — item 980): never sticky, fixed only while the pointer holds it.
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
const { cardPosition, cleanMoved } = await import("./asideMove");
const { startMove } = await import("./floatingMove");
const AsideCard = (await import("./AsideCard.svelte")).default;

const swallow = (e: PromiseRejectionEvent) => e.preventDefault?.();
let mounted: Record<string, unknown>[] = [];
beforeEach(() => {
  app.activeSessionId = "chat-A";
  app.project = { id: "p", name: "P", root: "/w", exists: true } as never;
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
const ANCHOR = { turn: 3, block: 0, start: 4, end: 20, side: "below" as const };
const PLACED = { top: 640, left: 20, width: 380, maxHeight: 400, side: "below" as const };
function aside(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    quote: null,
    draft: false,
    anchor: null,
    moved: null,
    name: "Stuart",
    turns: [{ seq: 1, question: "Why?", partial: "", answer: "Because.", error: null, cancelled: false }],
    ...over,
  };
}
/** Mount the real card and return the `position` it is drawn with. */
async function drawnPosition(a: ReturnType<typeof aside>, props: Record<string, unknown> = {}): Promise<HTMLElement> {
  app.asides = [a] as never;
  mounted.push(
    mount(AsideCard, {
      target: document.body,
      props: { aside: app.asides[0], placement: null, front: true, frameWidth: 720, ...props },
    }),
  );
  await settle();
  const card = document.querySelector(".aside-card") as HTMLElement;
  expect(card).not.toBeNull();
  return card;
}

describe("1035: every aside card he can reach scrolls with the chat", () => {
  it("a fresh composer aside (his screenshot's card) is in the column's flow, not stuck to the screen", async () => {
    const card = await drawnPosition(aside(), { footRoom: 527, footCount: 1 });
    expect(card.classList.contains("foot")).toBe(true);
    expect(card.style.position).toBe("relative");
    expect(card.style.bottom).toBe("");
  });

  it("several composer asides: each in the flow, none given a sticky `bottom`", async () => {
    const card = await drawnPosition(aside(), { footRoom: 527, footCount: 2 });
    expect(card.style.position).toBe("relative");
    expect(card.style.bottom).toBe("");
  });

  it("a passage aside after a reload, relaunch or hand-off whose passage is not found goes home — in the flow", async () => {
    const card = await drawnPosition(aside({ anchor: ANCHOR }), { placement: null, passageTop: null });
    expect(card.style.position).toBe("relative");
  });

  it("a fresh passage aside is absolute under its passage", async () => {
    const card = await drawnPosition(aside({ anchor: ANCHOR }), { placement: PLACED, passageTop: 600 });
    expect(card.style.position).toBe("absolute");
  });

  it("a dragged passage aside, and one restored from disk after a relaunch, is absolute in the column", async () => {
    const stored = cleanMoved(JSON.parse(JSON.stringify({ left: 140, top: 60, width: 380, from: "passage" })));
    expect(stored).not.toBeNull();
    const card = await drawnPosition(aside({ anchor: ANCHOR, moved: stored }), { placement: PLACED, passageTop: 600 });
    expect(card.style.position).toBe("absolute");
    expect(card.style.top).toBe("660px");
  });

  it("a dragged passage aside whose passage is lost (moved kept) goes home in the flow, never fixed", async () => {
    const card = await drawnPosition(aside({ anchor: ANCHOR, moved: { left: 140, top: 60, width: 380, from: "passage" } }), {
      placement: null,
      passageTop: null,
    });
    expect(card.style.position).toBe("relative");
  });

  it("a dragged composer aside is absolute in the column", async () => {
    const card = await drawnPosition(aside({ moved: { left: 100, top: 900, width: 380, from: "column" } }));
    expect(card.style.position).toBe("absolute");
    expect(card.style.top).toBe("900px");
  });

  it("leaving the chat and coming back (the same live aside, remounted) draws it the same way", async () => {
    const a = aside();
    const first = await drawnPosition(a);
    expect(first.style.position).toBe("relative");
    for (const c of mounted) unmount(c);
    mounted = [];
    document.body.innerHTML = "";
    const again = await drawnPosition(a);
    expect(again.style.position).toBe("relative");
  });

  it("the side panel's card is static furniture", async () => {
    const card = await drawnPosition(aside(), { panel: true, session: "chat-A" });
    expect(card.style.position).toBe("static");
  });
});

describe("1035: one rule, every state", () => {
  it("is never sticky, and fixed only while held", () => {
    for (const panel of [false, true])
      for (const holding of [false, true])
        for (const placed of [false, true])
          for (const moved of [false, true]) {
            const p = cardPosition({ panel, holding, placed, moved });
            expect(p).not.toBe("sticky");
            if (p === "fixed") expect(holding && !panel).toBe(true);
          }
  });
});

describe("1035: a move the window loses ends, so the card is not left held (fixed)", () => {
  it("a blur mid-move cancels it", () => {
    const onCancel = vi.fn();
    const onDrop = vi.fn();
    const down = new MouseEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }) as unknown as PointerEvent;
    startMove(down, {
      origin: { left: 0, top: 0 },
      size: { width: 300, height: 200 },
      edges: { left: "beside", right: "panel" },
      onMove: () => {},
      onDrop,
      onCancel,
    } as never);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 80, clientY: 90 }));
    window.dispatchEvent(new Event("blur"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The release after it is not a drop: the move already ended.
    window.dispatchEvent(new MouseEvent("pointerup", { clientX: 80, clientY: 90 }));
    expect(onDrop).not.toHaveBeenCalled();
  });
});
