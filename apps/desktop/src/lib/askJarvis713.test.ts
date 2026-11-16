// Item 713: the question card in Jarvis (lit edge, dot ground, mono heads, amber), gated so Classic is unchanged.
import { describe, expect, it } from "vitest";
import cardSrc from "./ApprovalPrompt.svelte?raw";
import askSrc from "./AskQuestions.svelte?raw";

const J = ':global(:where(:root:not([data-layout="classic"])))';
describe("713", () => {
  it("the card wears the lit edge and the dot ground, in Jarvis only", () => {
    const rule = cardSrc.slice(cardSrc.indexOf(`${J} .ask.qcard {`));
    expect(rule).toMatch(/box-shadow: var\(--glow-main, none\);[\s\S]*?\}/);
    expect(rule.slice(0, 400)).toContain("background-image: var(--chat-dots, none);");
  });
  it("the heads are mono capitals and the lit tab is amber, in Jarvis only", () => {
    for (const sel of [".aq-tab {", ".aq-h,", ".aq-next {", ".aq-opt.on {"]) expect(askSrc).toContain(`${J} ${sel}`);
    expect(askSrc.slice(askSrc.indexOf(`${J} .aq-tab {`))).toMatch(/^[^}]*font-family: var\(--mono\);[^}]*text-transform: uppercase;/);
  });
});
