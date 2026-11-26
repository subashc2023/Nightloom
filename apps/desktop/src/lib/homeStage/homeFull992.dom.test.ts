// @vitest-environment happy-dom
/*
 * Item 992: Home's reply strip gets a full-screen button — "should be like a fullscreen button or somethign so that i
 * can directly go from this to like seeing it as my entire page" (2026-11-25). Drawn and read back from the DOM (item
 * 980's rule): one press shows the reply rendered as the whole page (markdown drawn, the <ask> card answering, a
 * streaming reply streaming); Back to Home and Escape return to the stage, which kept its view underneath.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const answered: { answer: string; question: string }[] = [];
vi.mock("../needsBoard.svelte", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, answerAsk: async (_t: unknown, ask: { question: string }, answer: string) => (answered.push({ answer, question: ask.question }), true) };
});
// The motion is the stage's HUD open/close (hudMenu.ts, tested there); here it is recorded and made instant, since
// happy-dom's Web Animations cancel with an unhandled AbortError when an element leaves mid-animation.
const motion: string[] = [];
vi.mock("../hudMenu", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    hudIn: (node: HTMLElement) => (motion.push(`in:${node.className.split(" ")[0]}`), () => ({ duration: 0 })),
    hudOut: (node: HTMLElement) => (motion.push(`out:${node.className.split(" ")[0]}`), { duration: 0 }),
  };
});
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import "../asides.svelte";
import { app } from "../state.svelte";
import Stage from "./Stage.svelte";
import { readKept, stage } from "./stageState.svelte";

const Q = "Want me to accept either of them?";
const REPLY = `**swaraags@uci.edu (calendar):** nothing until Sunday, November 29. You haven't responded yet to either of these:
- COAST Meeting at 12 PM
- AISCI Board Sync at 1 PM

**aisafetyatuci@gmail.com (calendar):** nothing in the next seven days.`;

let root: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (root) unmount(root);
  root = null;
  document.body.innerHTML = "";
  app.busy = false;
  app.live = null;
  stage.full = false;
  answered.length = 0;
  motion.length = 0;
});

function draw(reply: string, busy = false) {
  app.view = "chat";
  app.activeSessionId = "home-chat";
  app.busy = busy;
  app.events = [
    { event: "user_message", text: "what's on my calendars?", at: "2026-11-25T23:00:00Z" },
    ...(reply ? [{ event: "assistant_message", blocks: [{ type: "text", text: reply }], at: "2026-11-25T23:00:10Z" }] : []),
  ] as never;
  stage.focus = "watch";
  stage.strip = "open";
  stage.full = false;
  const children = createRawSnippet(() => ({ render: () => "<div></div>" }));
  root = mount(Stage, { target: document.body, props: { blank: false, children } });
  flushSync();
}
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null;
const button = (name: string) => [...document.body.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const esc = (init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(e);
  flushSync();
  return e;
};

describe("item 992: Home's reply as the whole page", () => {
  it("the strip has a full-screen button (named Whole page); one press draws the reply rendered as the page, the strip gone", () => {
    draw(REPLY);
    expect(q(".h9-strip")).not.toBeNull();
    const b = button("Whole page");
    expect(b).toBeDefined();
    b!.click();
    flushSync();
    const page = q("[data-home-full]");
    expect(page).not.toBeNull();
    expect(page!.getAttribute("role")).toBe("dialog");
    expect(q(".h9-strip")).toBeNull();
    // Rendered, not raw: bold and a list, no ** left.
    expect([...page!.querySelectorAll("strong")].map((s) => s.textContent)).toEqual(["swaraags@uci.edu (calendar):", "aisafetyatuci@gmail.com (calendar):"]);
    expect([...page!.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["COAST Meeting at 12 PM", "AISCI Board Sync at 1 PM"]);
    expect(page!.textContent).not.toContain("**");
    expect(page!.querySelector(".h9-him")?.textContent).toBe("YOUwhat's on my calendars?");
    expect(stage.full).toBe(true);
  });

  it("Back to Home returns to the stage, its view where he left it", () => {
    draw(REPLY);
    stage.focus = "watch";
    button("Whole page")!.click();
    flushSync();
    button("Back to Home")!.click();
    flushSync();
    expect(q("[data-home-full]")).toBeNull();
    expect(q(".h9-strip")).not.toBeNull();
    expect(stage.focus).toBe("watch");
    expect(stage.full).toBe(false);
    // Opened and closed with the stage's HUD motion, because he pressed.
    expect(motion).toEqual(["in:h9-full", "out:h9-full"]);
  });

  it("Escape closes it; an Escape something nearer already took does not", () => {
    draw(REPLY);
    button("Whole page")!.click();
    flushSync();
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    window.dispatchEvent(taken);
    flushSync();
    expect(q("[data-home-full]")).not.toBeNull();
    const e = esc();
    expect(e.defaultPrevented).toBe(true);
    expect(q("[data-home-full]")).toBeNull();
    // With the page closed, Escape is left alone for others.
    expect(esc().defaultPrevented).toBe(false);
  });

  it("an <ask> reply shows its question once, as the card, and the card answers from the full page", () => {
    draw(`Two need you.\n\n<ask>\n${Q}\n- Accept both\n- Leave them\n</ask>`);
    button("Whole page")!.click();
    flushSync();
    const page = q("[data-home-full]")!;
    const card = page.querySelector(".h9-said-ask");
    expect(card).not.toBeNull();
    expect((page.querySelector(".nl-ask") as HTMLElement).dataset.state).toBe("live");
    (card!.querySelectorAll(".aq-opt")[0] as HTMLElement).click();
    flushSync();
    expect(answered).toEqual([{ answer: "Accept both", question: Q }]);
  });

  it("a reply being written streams in the full page, rendered as it grows", () => {
    draw("", true);
    button("Whole page")!.click();
    flushSync();
    expect(q("[data-home-full]")!.textContent).toContain("Home is working on it");
    app.live = { segments: [{ kind: "text", text: "**swaraags@uci.edu:** nothing until" }] } as never;
    flushSync();
    expect(q("[data-home-full] strong")?.textContent).toBe("swaraags@uci.edu:");
    app.live = { segments: [{ kind: "text", text: "**swaraags@uci.edu:** nothing until Sunday.\n\n- COAST Meeting" }] } as never;
    flushSync();
    expect(q("[data-home-full] li")?.textContent).toBe("COAST Meeting");
    expect(q(".h9-full-what")?.textContent).toBe("Writing its reply…");
  });

  it("the strip streams the same reply (one rule for both boxes)", () => {
    draw("", true);
    app.live = { segments: [{ kind: "text", text: "**Partial** reply" }] } as never;
    flushSync();
    expect(q(".h9-strip .h9-said-tx strong")?.textContent).toBe("Partial");
  });

  it("stays open across leaving Home and coming back (kept with the stage), and a pre-992 stage reads back unchanged", () => {
    draw(REPLY);
    button("Whole page")!.click();
    flushSync();
    unmount(root!);
    root = null;
    const children = createRawSnippet(() => ({ render: () => "<div></div>" }));
    motion.length = 0;
    root = mount(Stage, { target: document.body, props: { blank: false, children } });
    flushSync();
    expect(q("[data-home-full]")).not.toBeNull();
    // Drawn again on a return, it is simply there: no opening motion replayed.
    expect(motion).toEqual([]);
    expect(readKept(JSON.stringify({ ...stage })).full).toBe(true);
    expect(readKept('{"focus":"chat","strip":"open","stripFor":"","ui":{}}')).toEqual({ focus: "chat", strip: "open", stripFor: "", ui: {} });
  });
});
