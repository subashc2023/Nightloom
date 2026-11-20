// Item 884: the question box in Jarvis — Console rows (option B), number keys that answer.
import turnAskSrc from "./TurnAsk.svelte?raw";
import answeredSrc from "./AskAnswered.svelte?raw";
import { describe, expect, it } from "vitest";
import { numberKey } from "./askSettled";

// vitest empties CSS imports (askBox859.test.ts): app.css is read from disk.
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const appCss = fs.readFileSync(new URL("../askLook.css", import.meta.url), "utf8");
const mainSrc = fs.readFileSync(new URL("../main.ts", import.meta.url), "utf8");

describe("884: number keys", () => {
  it("1–9 name an answer", () => {
    expect(numberKey({ key: "1" })).toBe(1);
    expect(numberKey({ key: "9" })).toBe(9);
  });
  it("0, letters, Enter and modified digits do not", () => {
    expect(numberKey({ key: "0" })).toBe(0);
    expect(numberKey({ key: "a" })).toBe(0);
    expect(numberKey({ key: "Enter" })).toBe(0);
    expect(numberKey({ key: "2", metaKey: true })).toBe(0);
    expect(numberKey({ key: "2", ctrlKey: true })).toBe(0);
    expect(numberKey({ key: "2", altKey: true })).toBe(0);
  });
});

describe("884: Jarvis look", () => {
  const J = ':where(:root:not([data-layout="classic"]))';
  it("the box's answers are rows with a number key, not pills", () => {
    expect(appCss).toContain(`${J} .nl-ask:is([data-state="open"], [data-state="closed"], [data-answered]) .nl-ask-o > li::before {\n  content: counter(nl-ask);`);
    expect(appCss).toMatch(/\.nl-ask-o > li \{\n  counter-increment: nl-ask;[\s\S]*?border-radius: 0;/);
  });
  it("the box is the hand-off glass, with no amber left rule", () => {
    expect(appCss).toMatch(/\[data-answered\]\) \{\n  border: 1px solid color-mix\(in srgb, var\(--accent\) 38%, var\(--line2\)\);/);
  });
  it("is imported right after app.css, so it wins the ties", () => {
    const i = mainSrc.indexOf('import "./app.css";');
    expect(i).toBeGreaterThan(0);
    expect(mainSrc.indexOf('import "./askLook.css";')).toBeGreaterThan(i);
  });
  it("every rule is Jarvis-only", () => {
    const rules = appCss.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.trim()).filter((r) => r.includes("{"));
    expect(rules.length).toBeGreaterThan(10);
    for (const r of rules) expect(r.startsWith(':where(:root:not([data-layout="classic"]))')).toBe(true);
  });
  it("851's answered state keeps its green pick", () => {
    expect(appCss).toMatch(/\.nl-ask\[data-answered\] \.nl-ask-o > li\[data-picked\] \{\n  color: var\(--ink\);\n  background: var\(--done-soft\);/);
  });
  it("the live card and the closed card share the look in Jarvis", () => {
    expect(turnAskSrc).toContain('.turn-ask {\n    border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--line2));');
    expect(answeredSrc).toContain("content: counter(aa-pick);");
  });
});
