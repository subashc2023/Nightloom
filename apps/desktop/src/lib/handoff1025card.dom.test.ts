// @vitest-environment happy-dom
/*
 * Item 1025, drawn and read back from the DOM (item 980's rule): the hand-off card says that the next chat's
 * first message also points at this chat's full history, so what Continue sends is on screen (blocker 1659).
 */
import { afterEach, describe, expect, it } from "vitest";
import { handoffGo, HISTORY_LINE, type NextChat } from "./handoffButton";
import { renderReply } from "./markdown";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("1025: the hand-off card says the history pointer is added", () => {
  const reply = "Done.\n\n<handoff>\nGoal: finish the parser.\nRead src/parse.ts first.\n</handoff>";
  const prompt = "Goal: finish the parser.\nRead src/parse.ts first.";
  function draw(history: string | null): HTMLElement {
    const node = document.createElement("div");
    node.className = "markdown";
    node.innerHTML = renderReply(reply);
    document.body.append(node);
    const next: NextChat = { chat: "c1", index: 3, prompt, readOrder: "", used: false, blocked: null, onContinue: () => {}, history };
    handoffGo(node, next);
    return node;
  }

  it("draws the line before the button", () => {
    const node = draw(HISTORY_LINE);
    const line = node.querySelector(".handoff-go > .handoff-history-line");
    expect(line?.textContent).toBe(HISTORY_LINE);
    const go = node.querySelector(".handoff-go > button.handoff-continue")!;
    expect(line!.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("no line when none is given", () => {
    expect(draw(null).querySelector(".handoff-history-line")).toBeNull();
  });
});
