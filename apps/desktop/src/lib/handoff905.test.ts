// Item 905 (his report, 2026-11-23): one turn drew the next chat's prompt three times. The fixture is his turn's two
// hand-off segments as the model wrote them (the paragraph above each `<handoff>` block, and the block), copied.
import { describe, expect, it, vi } from "vitest";
vi.mock("dompurify", () => ({ default: { sanitize: (h: string) => h } }));
import { extractHandoff, shownHandoffTexts } from "./handoffTag";
import { renderReply } from "./markdown";
import his from "./handoff905.fixture.json";

const cards = (html: string) => html.split('class="handoff-card"').length - 1;
const shownCards = (texts: (string | null)[]) =>
  shownHandoffTexts(texts).reduce((n, t) => n + (t === null ? 0 : cards(renderReply(t))), 0);
const MIDDLE = "The drift agent is back, the fifth of nine.\n\n**Checkpoints.** Keep a chain of ratified checkpoints.";
const promptOf = (t: string) => extractHandoff(t)!;

describe("one hand-off prompt per turn (item 905)", () => {
  it("his turn: hand-off, agents report, hand-off again — one card, the last", () => {
    const texts = [his.first, null, MIDDLE, null, his.last];
    expect(texts.reduce((n, t) => n + (t === null ? 0 : cards(renderReply(t))), 0)).toBe(2); // before: two cards
    const shown = shownHandoffTexts(texts);
    expect(shownCards(texts)).toBe(1);
    expect(renderReply(shown[4]!)).toContain(promptOf(his.last).slice(0, 60));
    // The paragraph above the dropped block stays; only the block goes.
    expect(shown[0]).toContain(his.first.split("\n")[0]);
    expect(shown[0]).not.toContain("<handoff>");
    expect(shown[2]).toBe(MIDDLE);
  });

  it("a prompt written as prose and in the tag shows once, in the card", () => {
    const prompt = promptOf(his.first);
    const text = `Here it is.\n\n${prompt}\n\n<handoff>\n${prompt}\n</handoff>\n`;
    const [shown] = shownHandoffTexts([text]);
    const html = renderReply(shown!);
    expect(cards(html)).toBe(1);
    expect(html.split(prompt.slice(0, 50)).length - 1).toBe(1);
    expect(html).toContain("Here it is.");
  });

  it("the prose copy in a segment of its own goes too", () => {
    const prompt = promptOf(his.first);
    const shown = shownHandoffTexts([`Plan.\n\n${prompt}`, null, his.first]);
    expect(shown[0]).not.toContain(prompt.slice(0, 50));
    expect(shown[0]).toContain("Plan.");
    expect(cards(renderReply(shown[2]!))).toBe(1);
  });

  it("two blocks in one text: the last stays", () => {
    const text = `${his.first}\n\nMore.\n\n${his.last}`;
    const [shown] = shownHandoffTexts([text]);
    const html = renderReply(shown!);
    expect(cards(html)).toBe(1);
    expect(html).toContain("More.");
    expect(extractHandoff(shown!)).toBe(extractHandoff(text));
  });

  it("a fenced prompt under a hand-off heading (item 583) counts as a block", () => {
    const fenced = "## Handoff prompt\n\n```\nDo the next thing.\n```\n";
    const shown = shownHandoffTexts([fenced, his.last]);
    expect(shownCards([fenced, his.last])).toBe(1);
    expect(shown[1]).toBe(his.last);
  });

  it("a turn with one block, or none, is drawn as written", () => {
    expect(shownHandoffTexts([his.last])).toEqual([his.last]);
    expect(shownHandoffTexts(["No hand-off here.", null])).toEqual(["No hand-off here.", null]);
    // Still streaming: an unclosed second tag is text, so the first card stays until it closes.
    const open = his.last.slice(0, his.last.indexOf("</handoff>"));
    expect(shownCards([his.first, open])).toBe(1);
    expect(shownHandoffTexts([his.first, open])[0]).toBe(his.first);
  });
});
