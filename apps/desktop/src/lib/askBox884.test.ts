// Item 884: the question box in Jarvis — Console rows (option B), number keys that answer.
import turnAskSrc from "./TurnAsk.svelte?raw";
import answeredSrc from "./AskAnswered.svelte?raw";
import { describe, expect, it } from "vitest";
import { ASK_STACK_CHARS, askStacks, numberKey } from "./askSettled";
import askSettledSrc from "./askSettled.ts?raw";

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

describe("884: the stack rule (option A)", () => {
  it("short answers stay side by side", () => {
    expect(askStacks(["Yes, redraw them", "No, they're fine"])).toBe(false);
    expect(askStacks(["x".repeat(ASK_STACK_CHARS)])).toBe(false);
  });
  it("any answer past 40 characters stacks them all", () => {
    expect(ASK_STACK_CHARS).toBe(40);
    expect(askStacks(["Yes", "x".repeat(ASK_STACK_CHARS + 1)])).toBe(true);
  });
  it("the box is marked, open and answered", () => {
    expect(askSettledSrc).toMatch(/markStack\(box, lis\);/);
    expect(askSettledSrc).toMatch(/markStack\(box, items\);/);
  });
});

describe("884: Jarvis look (option A, Control row)", () => {
  const JA = ':where(:root:not([data-layout="classic"])[data-askcard="buttons"])';
  it("the box's answers are buttons with a number key, side by side", () => {
    expect(appCss).toContain(`.nl-ask-o > li::before {\n  content: counter(nl-ask);`);
    expect(appCss).toMatch(/\.nl-ask-o \{\n  list-style: none;\n  display: flex;\n  flex-wrap: wrap;/);
    expect(appCss).toMatch(/\.nl-ask-o > li \{[^}]*border: 1px solid var\(--line2\);[^}]*background: var\(--well\);/);
  });
  it("a stacked box puts every answer full width", () => {
    expect(appCss).toContain(`${JA} .nl-ask[data-stack] .nl-ask-o {\n  flex-direction: column;`);
    expect(appCss).toContain(`${JA} .nl-ask[data-stack] .nl-ask-o > li {\n  display: flex;\n  width: 100%;`);
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
    for (const r of rules) expect(r.startsWith(':where(:root:not([data-layout="classic"])')).toBe(true);
  });
  it("851's answered state keeps its green pick", () => {
    expect(appCss).toMatch(/\.nl-ask\[data-answered\] \.nl-ask-o > li\[data-picked\] \{\n  color: var\(--ink\);\n  background: var\(--done-soft\);/);
  });
  it("the live card and the closed card share the buttons and the stack rule", () => {
    expect(turnAskSrc).toContain('data-stack={stack ? "1" : undefined}');
    expect(turnAskSrc).toContain(".turn-ask[data-stack] :global(.aq-opts) {\n    flex-direction: column;");
    expect(answeredSrc).toContain("content: counter(aa-pick);");
    expect(answeredSrc).toContain('data-stack={askStacks(q.options.map((o) => o.label)) ? "1" : undefined}');
    expect(answeredSrc).toContain("const n = numberKey(e);");
  });
});

describe("884b: both looks as a Settings choice", () => {
  const JA = ':where(:root:not([data-layout="classic"])[data-askcard="buttons"])';
  const JB = ':where(:root:not([data-layout="classic"]):not([data-askcard="buttons"]))';
  it("Rows is the default and Buttons stamps data-askcard", async () => {
    const m = await import("./askCardLook.svelte");
    expect(m.parseAskCardLook(null)).toBe("rows");
    expect(m.parseAskCardLook("junk")).toBe("rows");
    expect(m.parseAskCardLook("buttons")).toBe("buttons");
    // No DOM in these tests: a stand-in <html> and storage.
    const store = new Map<string, string>();
    const g = globalThis as Record<string, unknown>;
    g.document = { documentElement: { dataset: {} as Record<string, string> } };
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    m.setAskCardLook("buttons");
    expect(document.documentElement.dataset.askcard).toBe("buttons");
    expect(localStorage.getItem("nightloom.askCard")).toBe("buttons");
    m.setAskCardLook("rows");
    expect(document.documentElement.dataset.askcard).toBeUndefined();
    expect(localStorage.getItem("nightloom.askCard")).toBeNull();
    delete g.document;
    delete g.localStorage;
  });
  it("the box carries both looks, each gated", () => {
    expect(appCss).toContain(`${JB} .nl-ask:is([data-state="open"], [data-state="closed"], [data-answered]) .nl-ask-o > li {\n  counter-increment: nl-ask;`);
    expect(appCss).toMatch(/:not\(\[data-askcard="buttons"\]\)\) \.nl-ask:is\(\[data-state="open"\], \[data-state="closed"\]\) \.nl-ask-o > li::after \{\n  content: "Send ↵";/);
    expect(appCss).toContain(`${JA} .nl-ask:is([data-state="open"], [data-state="closed"], [data-answered]) .nl-ask-o {\n  list-style: none;\n  display: flex;`);
  });
  it("the live card and the closed card carry both looks", () => {
    expect(turnAskSrc).toContain(':global(:where(:root:not([data-layout="classic"])[data-askcard="buttons"])) .turn-ask :global(.aq-opts) {');
    expect(answeredSrc).toContain(':global(:where(:root:not([data-layout="classic"]):not([data-askcard="buttons"]))) .aa-pick {');
    expect(answeredSrc).toContain(':global(:where(:root:not([data-layout="classic"])[data-askcard="buttons"])) .aa-pick {');
    expect(answeredSrc).toContain(".aa-chip.aa-chip-closed {");
  });
  it("Send ↵ sits at the foot, filled amber, and in Buttons only for Other", () => {
    expect(turnAskSrc).not.toContain("{#snippet tail()}");
    expect(turnAskSrc).toMatch(/<div class="ta-foot">[\s\S]*?class="ta-send" disabled=\{!ready \|\| sending\}[\s\S]*?"Send ↵"/);
    expect(turnAskSrc).toContain('const showSend = $derived(classic() || askCardLook.value !== "buttons" || typed);');
    expect(turnAskSrc).toMatch(/\.ta-send \{\n    min-height: 32px;[\s\S]*?background: var\(--accent\);\n    color: var\(--on-accent\);/);
  });
});
