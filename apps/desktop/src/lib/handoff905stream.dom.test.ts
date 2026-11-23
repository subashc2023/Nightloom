// @vitest-environment happy-dom
/*
 * Item 905 ("the next chat's prompt was duplicated … the first one wasn't in the normal like prompt box"): his
 * reply streamed through `liveHtml` the way the transcript draws it (by blocks while streaming, whole once
 * finished) ends with the prompt once, in its card — the streamed DOM matches a fresh render of the finished
 * reply. Before d198e00e the unclosed `<handoff>`'s streamed text stayed above the card. A fake DOM can't show
 * this; happy-dom parses the HTML for real.
 */
import { describe, expect, it } from "vitest";
import { liveHtml } from "./liveHtml";
import { renderReply } from "./markdown";
import { renderStreamingParts } from "./streamBlocks";
import his from "./handoff905.fixture.json";

function stream(text: string, step: number): HTMLElement {
  const node = document.createElement("div");
  const act = liveHtml(node, renderStreamingParts(text.slice(0, 1)));
  for (let n = 1 + step; n < text.length; n += step) act.update(renderStreamingParts(text.slice(0, n)));
  act.update(renderStreamingParts(text));
  act.update(renderReply(text));
  return node;
}
const fresh = (text: string) => {
  const d = document.createElement("div");
  d.innerHTML = renderReply(text);
  return d;
};
const promptHead = (text: string) => text.slice(text.indexOf("<handoff>") + 10, text.indexOf("<handoff>") + 70);

describe("905: his hand-off reply, streamed then finished, draws the prompt once", () => {
  for (const step of [1, 7, 23, 97]) {
    it(`deltas of ${step} char(s)`, () => {
      const node = stream(his.first, step);
      const head = promptHead(his.first);
      expect(node.textContent!.split(head).length - 1).toBe(1);
      expect(node.innerHTML).toBe(fresh(his.first).innerHTML);
    });
  }
});
