import composerSrc from "./Composer.svelte?raw";
import summonSrc from "./composerSummon.svelte.ts?raw";
import typeSrc from "./typeToCompose.ts?raw";
import pasteSrc from "./pasteToCompose.ts?raw";
import cardSrc from "./AsideCard.svelte?raw";
import { describe, expect, it } from "vitest";
import { ASIDE_BEHAVIOURS, ASIDE_HIDDEN, COMPOSER_ASIDE_GATES } from "./asideControls";
import { focusKindOf, pickTarget, sendsToComposer, type Candidate, type FocusEl } from "./typeToCompose";
import { pasteFocusOf } from "./pasteToCompose";

// Item 853 (2026-11-18): every behaviour of the chat's box reaches an
// aside's box — an aside tab's and an aside card's — unless the table in
// asideControls.ts says why not. These fail when a behaviour is wired to
// the chat's box alone.

/** The behaviours his Definition of done names, each of which must have a row. */
const NAMED = [
  "typeToFocus",
  "enterSendsFromAnywhere",
  "pasteFromOutside",
  "pasteInBox",
  "drafts",
  "queueUpArrow",
  "escapeInBox",
  "cmdL",
  "stopChord",
  "sizingAndReset",
  "sendLater",
  "queue",
  "slash",
  "palette",
];

describe("853: the behaviour table", () => {
  it("names every behaviour of the chat's box he listed, for the tab and the card", () => {
    for (const id of NAMED) {
      const row = ASIDE_BEHAVIOURS[id];
      expect(row, id).toBeDefined();
      for (const p of [row.tab, row.card]) expect(p === "same" || p === "fixed-853" || p.startsWith("n/a: "), `${id}: ${p}`).toBe(true);
    }
  });
  it("an n/a that cites ASIDE_HIDDEN names a real entry", () => {
    for (const [id, row] of Object.entries(ASIDE_BEHAVIOURS))
      for (const p of [row.tab, row.card]) {
        const m = /ASIDE_HIDDEN\.(\w+)/.exec(p);
        if (m) expect(m[1] in ASIDE_HIDDEN, `${id}: ${p}`).toBe(true);
      }
  });
});

describe("853: no behaviour gated to the chat's box without a row", () => {
  const script = composerSrc.slice(0, composerSrc.indexOf("</script>")).split("\n");
  const GATE = /if \(aside\b|aside \? undefined|\(aside \|\||^\s+aside$/;
  const gates: string[] = [];
  script.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    if (GATE.test(line)) gates.push(script.slice(i, i + 3).join("\n"));
  });
  it("finds the gates (the scan still reads the file)", () => {
    expect(gates.length).toBeGreaterThan(10);
  });
  it("every gate on `aside` in Composer.svelte is listed in COMPOSER_ASIDE_GATES", () => {
    for (const g of gates) expect(COMPOSER_ASIDE_GATES.some((e) => g.includes(e.match)), `unlisted gate:\n${g}`).toBe(true);
  });
  it("every listed gate still exists (no stale row)", () => {
    for (const e of COMPOSER_ASIDE_GATES) expect(gates.some((g) => g.includes(e.match)), e.match).toBe(true);
  });
});

describe("853: the window's routing reaches every box", () => {
  it("no router picks the chat's box by excluding asides", () => {
    for (const src of [typeSrc, pasteSrc, summonSrc]) expect(src).not.toMatch(/querySelector(All)?\([^)]*:not\(\.aside\)/);
  });
  it("an aside's box keeps the window's listeners on, as the chat's does", () => {
    expect(composerSrc).toContain("(aside ? boxMounted() : chatBoxMounted())");
    expect(summonSrc).toMatch(/allBoxes === 1\) listenForTyping\(true\)/);
    expect(summonSrc).toContain('window.addEventListener("pointerdown", noteCardPress, true);');
  });
  it("every box registers for ⌘V from outside, and ⌘L asks the box meant", () => {
    expect(composerSrc).toMatch(/if \(!el\) return;\s*return registerPasteHandler\(el, pasteFromOutside\);/);
    expect(composerSrc).toContain("if (!untrack(() => isSummonTarget(root))) return;");
  });
  it("a card's Escape leaves one its box already took", () => {
    expect(cardSrc).toContain("if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;");
  });
});

// The pick, on fakes: R/B/C are plain tags.
const c = (root: string, kind: Candidate["kind"], inPane: boolean, card: string | null = null): Candidate<string, string, string> => ({
  root,
  box: `${root}-box`,
  kind,
  card,
  inPane,
});

describe("853: pickTarget — the box meant", () => {
  it("an aside tab in front of the focused pane takes the keys (the bug)", () => {
    expect(pickTarget([c("tab", "tab", true)], null, null)?.root).toBe("tab");
  });
  it("the focused pane's aside tab beats the chat's box in the other pane", () => {
    const t = pickTarget([c("chat", "chat", false), c("tab", "tab", true)], null, null);
    expect(t?.root).toBe("tab");
    expect(t?.inPane).toBe(true);
  });
  it("a card he last pressed on beats the chat's box under it", () => {
    const t = pickTarget([c("chat", "chat", true), c("cardbox", "card", true, "card1")], null, "card1");
    expect(t?.root).toBe("cardbox");
  });
  it("a card the focus is in beats the one last pressed", () => {
    const cs = [c("a", "card", true, "A"), c("b", "card", true, "B"), c("chat", "chat", true)];
    expect(pickTarget(cs, "B", "A")?.root).toBe("b");
  });
  it("a card that is gone (or draws no box) falls back to the chat's box", () => {
    expect(pickTarget([c("chat", "chat", true)], null, "gone")?.root).toBe("chat");
  });
  it("a card never takes keys he did not mean for it", () => {
    expect(pickTarget([c("chat", "chat", true), c("cardbox", "card", true, "X")], null, null)?.root).toBe("chat");
  });
  it("no box in the focused pane: the chat's, refused by inPane as before", () => {
    const t = pickTarget([c("tab", "tab", false), c("chat", "chat", false)], null, null);
    expect(t?.root).toBe("chat");
    expect(t?.inPane).toBe(false);
  });
});

function el(o: { card?: unknown; button?: boolean } = {}): FocusEl {
  return {
    tagName: o.button ? "BUTTON" : "DIV",
    isContentEditable: false,
    matches: (s: string) => !!o.button && s.split(", ").includes("button"),
    closest: (s: string) => (s === ".aside-card" && o.card ? o.card : null) as never,
  };
}

describe("853: the card's own controls are the card's box's", () => {
  const card = { contains: () => true };
  it("typing on the card's text or its buttons goes to its box", () => {
    expect(focusKindOf(el({ card }), false, card)).toBe("content");
    expect(focusKindOf(el({ card, button: true }), false, card)).toBe("control");
    expect(sendsToComposer({ key: "h", metaKey: false, ctrlKey: false }, { focus: "content", blocked: false, composer: true })).toBe(true);
  });
  it("another card's controls stay refused", () => {
    expect(focusKindOf(el({ card: {} }), false, card)).toBe("elsewhere");
    expect(pasteFocusOf(el({ card: {} }), false, card)).toBe("aside");
  });
  it("⌘V on the card's own controls pastes into its box", () => {
    expect(pasteFocusOf(el({ card }), false, card)).toBe("outside");
  });
  it("an aside tab's box buttons are a control of its pane, not elsewhere", () => {
    expect(focusKindOf(el({ button: true }), false, { contains: () => true })).toBe("control");
  });
});
