// @vitest-environment happy-dom
/*
 * Item 994 (991 follow-up, 991's shot 02): Home's reply strip drew an <ask> question twice — the reply's
 * "Question for you" box and, under it, the chat's own "Claude asks" card. Drawn and read back from the DOM
 * (item 980's rule: render, not source text): while the card is drawn, the box is hidden (`data-state="live"`,
 * app.css hides it — the rule is loaded here), so the question shows once, as the answerable card; with no card
 * (a turn still runs) the box is the answerable one, its options sending as the card's do.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const answered: { answer: string; question: string }[] = [];
vi.mock("../needsBoard.svelte", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, answerAsk: async (_t: unknown, ask: { question: string }, answer: string) => (answered.push({ answer, question: ask.question }), true) };
});
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import "../asides.svelte";
import { app } from "../state.svelte";
import Stage from "./Stage.svelte";
import { stage } from "./stageState.svelte";

const Q = "Should I read the three in full now?";
const REPLY = `Three need you:
- **Google Drive:** a shared plan.

<ask>
${Q}
- Yes, read them now
- No, leave it for the next scan
</ask>`;

// app.css's own rule for a live box (item 859), so "hidden" is the stylesheet's word, not this test's.
// vitest empties CSS imports, so the file is read from disk (the run starts in apps/desktop).
const css = await readFile(join(process.cwd(), "src/app.css"), "utf8");
const live = /\.nl-ask\[data-state="live"\]\s*\{[^}]*\}/.exec(css)?.[0] ?? "";

let root: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (root) unmount(root);
  root = null;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  app.busy = false;
  answered.length = 0;
});

function drawStrip(busy = false) {
  const style = document.createElement("style");
  style.textContent = live;
  document.head.appendChild(style);
  app.view = "chat";
  app.activeSessionId = "home-chat";
  app.busy = busy;
  app.events = [
    { event: "user_message", text: "anything in my mail?", at: "2026-11-25T23:00:00Z" },
    { event: "assistant_message", blocks: [{ type: "text", text: REPLY }], at: "2026-11-25T23:00:10Z" },
  ] as never;
  stage.focus = "watch";
  stage.strip = "open";
  const children = createRawSnippet(() => ({ render: () => "<div></div>" }));
  root = mount(Stage, { target: document.body, props: { blank: false, children } });
  flushSync();
}

/** Elements showing the question: its text, in an element the stylesheet does not hide. */
function shownQuestions(): Element[] {
  return [...document.body.querySelectorAll(".nl-ask-q, .aq-q, .aq-title, [data-turn-ask] *")]
    .filter((el) => el.children.length === 0 && el.textContent?.trim() === Q)
    .filter((el) => {
      for (let n: Element | null = el; n; n = n.parentElement) if (getComputedStyle(n).display === "none") return false;
      return true;
    });
}

describe("item 994: Home's strip shows an <ask> once", () => {
  it("hides the reply's box while the question card is drawn; the card answers", () => {
    expect(live).toContain("display: none");
    drawStrip();
    const box = document.body.querySelector(".h9-said-tx .nl-ask") as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.dataset.state).toBe("live");
    expect(getComputedStyle(box).display).toBe("none");
    // The rest of the reply still draws.
    expect(document.body.querySelector(".h9-said-tx strong")?.textContent).toBe("Google Drive:");
    const card = document.body.querySelector(".h9-said-ask")!;
    expect(card).not.toBeNull();
    expect(shownQuestions()).toHaveLength(1);
    expect(card.contains(shownQuestions()[0])).toBe(true);
    const opts = [...card.querySelectorAll(".aq-opt")] as HTMLElement[];
    opts[0].click();
    flushSync();
    expect(answered).toEqual([{ answer: "Yes, read them now", question: Q }]);
  });

  it("with no card (a turn still runs), the box is the one answerable question", () => {
    drawStrip(true);
    expect(document.body.querySelector(".h9-said-ask")).toBeNull();
    const box = document.body.querySelector(".h9-said-tx .nl-ask") as HTMLElement;
    expect(box.dataset.state).toBe("open");
    expect(shownQuestions()).toHaveLength(1);
    const li = box.querySelector(".nl-ask-o > li") as HTMLElement;
    expect(li.getAttribute("role")).toBe("button");
    li.click();
    flushSync();
    expect(answered).toEqual([{ answer: "Yes, read them now", question: Q }]);
  });

  it("item 999: his line in the strip is his words, not their marks", () => {
    app.view = "chat";
    app.activeSessionId = "home-chat";
    app.events = [
      { event: "user_message", text: "is the **sampling** one `done`?", at: "2026-11-25T23:00:00Z" },
      { event: "assistant_message", blocks: [{ type: "text", text: "Yes." }], at: "2026-11-25T23:00:10Z" },
    ] as never;
    stage.focus = "watch";
    stage.strip = "open";
    const children = createRawSnippet(() => ({ render: () => "<div></div>" }));
    root = mount(Stage, { target: document.body, props: { blank: false, children } });
    flushSync();
    expect(document.body.querySelector(".h9-him")?.textContent).toBe("YOUis the sampling one done?");
  });
});
