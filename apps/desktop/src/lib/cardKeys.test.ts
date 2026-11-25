import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cardDigit, cardOwnsKey } from "./cardKeys";

// Item 974: digits and Enter on a waiting card are the card's, never while he types.
const k = (key: string, more: Record<string, unknown> = {}) => ({ key, metaKey: false, ctrlKey: false, ...more });
const el = (tag: string, inCard: boolean, more: Record<string, unknown> = {}) => ({
  tagName: tag,
  ...more,
  closest: (sel: string) => (inCard && sel === "[data-keycard]" ? {} : null),
});

describe("cardDigit", () => {
  it("1–9 map to 0–8", () => {
    expect(cardDigit(k("1"))).toBe(0);
    expect(cardDigit(k("9"))).toBe(8);
  });
  it("0, letters, chords, IME and repeats are not digits", () => {
    expect(cardDigit(k("0"))).toBeNull();
    expect(cardDigit(k("a"))).toBeNull();
    expect(cardDigit(k("1", { metaKey: true }))).toBeNull();
    expect(cardDigit(k("1", { altKey: true }))).toBeNull();
    expect(cardDigit(k("1", { isComposing: true }))).toBeNull();
    expect(cardDigit(k("1", { repeat: true }))).toBeNull();
  });
});

describe("cardOwnsKey", () => {
  it("a digit or Enter on a card's box, button or radio", () => {
    expect(cardOwnsKey(k("2"), el("DIV", true))).toBe(true);
    expect(cardOwnsKey(k("Enter"), el("BUTTON", true))).toBe(true);
    expect(cardOwnsKey(k("3"), el("INPUT", true, { type: "radio" }))).toBe(true);
  });
  it("never in a field he types in, even inside a card", () => {
    expect(cardOwnsKey(k("2"), el("TEXTAREA", true))).toBe(false);
    expect(cardOwnsKey(k("2"), el("INPUT", true, { type: "text" }))).toBe(false);
    expect(cardOwnsKey(k("Enter"), el("DIV", true, { isContentEditable: true }))).toBe(false);
  });
  it("letters still go to the message box; outside a card nothing changes", () => {
    expect(cardOwnsKey(k("h"), el("DIV", true))).toBe(false);
    expect(cardOwnsKey(k("2"), el("DIV", false))).toBe(false);
    expect(cardOwnsKey(k("2"), null)).toBe(false);
  });
});

describe("every waiting card takes the keys (the class)", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  it("type-to-compose asks cardOwnsKey before it moves a key", () => {
    const s = read("./typeToCompose.ts");
    expect(s.indexOf("cardOwnsKey(e, active)")).toBeGreaterThan(-1);
    expect(s.indexOf("cardOwnsKey(e, active)")).toBeLessThan(s.indexOf("const found = composerTarget(doc);"));
  });
  it("question cards are key cards; button cards use keyPicks with numbered buttons", () => {
    expect(read("./AskQuestions.svelte")).toContain("data-keycard");
    for (const f of ["./ApprovalPrompt.svelte", "./PlaywrightCard.svelte", "./StuckCard.svelte", "./DriveCard.svelte", "./SecretCard.svelte"]) {
      const s = read(f);
      expect(s, f).toContain("use:keyPicks");
      expect(s, f).toContain("data-pick");
    }
    expect(read("./NeedsYou.svelte")).toContain('use:keyPicks={{ scope: ".row", pick: ".answer" }}');
    expect(read("./homeStage/views/Watch.svelte")).toContain("use:keyPicks");
  });
});
