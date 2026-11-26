// @vitest-environment happy-dom
/*
 * Item 1007, drawn and read back from the DOM (item 980's rule): the hand-off card says the hand-off also
 * saves memory — only when the automatic pass is on (before, the capture it started was said nowhere).
 */
import { afterEach, describe, expect, it } from "vitest";
import { handoffGo, MEMORY_LINE, type NextChat } from "./handoffButton";
import { renderReply } from "./markdown";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("1007: the hand-off card says it also saves memory", () => {
  const reply = "Done.\n\n<handoff>\nGoal: finish the parser.\nRead src/parse.ts first.\n</handoff>";
  const prompt = "Goal: finish the parser.\nRead src/parse.ts first.";
  function draw(memory: string | null): HTMLElement {
    const node = document.createElement("div");
    node.className = "markdown";
    node.innerHTML = renderReply(reply);
    document.body.append(node);
    const next: NextChat = { chat: "c1", index: 3, prompt, readOrder: "", used: false, blocked: null, onContinue: () => {}, memory };
    handoffGo(node, next);
    return node;
  }

  it("with the automatic pass on: the line, above the controls", () => {
    const node = draw(MEMORY_LINE);
    const card = node.querySelector(".handoff-card");
    expect(card, "the reply draws a hand-off card").not.toBeNull();
    const line = node.querySelector(".handoff-go > .handoff-memory-line");
    expect(line?.textContent).toBe(MEMORY_LINE);
    expect(line?.textContent).toContain("also saves memory from this chat");
    // Before the button, so it is read before Continue is pressed.
    const go = node.querySelector(".handoff-go > button.handoff-continue")!;
    expect(line!.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("with it off: no line (nothing would run)", () => {
    const node = draw(null);
    expect(node.querySelector(".handoff-go")).not.toBeNull();
    expect(node.querySelector(".handoff-memory-line")).toBeNull();
  });
});
