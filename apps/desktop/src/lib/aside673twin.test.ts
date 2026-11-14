import { describe, expect, it } from "vitest";
import viewSrc from "./AsideView.svelte?raw";
import foldSrc from "./AsideFoldPanel.svelte?raw";

/**
 * Item 673 round 2 (2026-11-12, his pick C1 Twin: "Do twin for the asdies
 * thign"): on Filament the aside tab's header is a card — the composer's own
 * box — with the quoted passage inside it and the composer's row at its foot
 * (about pill, Fold into thread with the Ask-aside coil, Close). Classic keeps
 * round 1's Kicker strip and its thread's lead. Design and numbers:
 * notes/runner-design/673-r2-report-2026-11-12.md (nightshift-code). The
 * suite runs in node, so the layout is pinned by reading the source.
 */
const rule = (sel: string): string => {
  const i = viewSrc.indexOf(`${sel} {`);
  expect(i, sel).toBeGreaterThan(-1);
  return viewSrc.slice(i, viewSrc.indexOf("}", i));
};

describe("673 C1 Twin: the aside tab's header card", () => {
  it("Classic keeps the Kicker strip; Filament draws the twin card", () => {
    const c = viewSrc.indexOf("{#if classic()}\n    <!-- Classic keeps round 1's Kicker strip");
    // Item 685: the header carries its fold classes after the class.
    const t = viewSrc.indexOf('<header class="aside-head twin"');
    expect(c).toBeGreaterThan(-1);
    expect(t).toBeGreaterThan(c);
    expect(viewSrc.slice(c, t)).toMatch(/<header class="aside-head">/);
  });

  it("the card is the composer card's box", () => {
    const r = rule(".twin .aside-head-in");
    // Item 685: the padding moved to the full card's content (the card holds it and the strip).
    expect(rule(".aside-head-full")).toMatch(/padding: 13px 14px 12px;/);
    expect(r).toMatch(/background: var\(--raised\);/);
    expect(r).toMatch(/border: 1px solid var\(--line2\);/);
    expect(r).toMatch(/border-radius: var\(--r2\);/);
    expect(r).toMatch(/box-shadow: 0 8px 24px rgba\(0, 0, 0, 0\.35\);/);
    expect(rule(".twin .aside-head-in::before")).toMatch(/--tk: var\(--bracket, transparent\);/);
  });

  it("the quote is in the card, two lines until clicked; the Filament transcript's lead is not the quote", () => {
    const t = viewSrc.slice(viewSrc.indexOf('<header class="aside-head twin"'), viewSrc.indexOf("</header>", viewSrc.indexOf('<header class="aside-head twin"')));
    expect(t).toMatch(/class="aside-head-quote"[\s\S]*class:open=\{quoteOpen\}/);
    expect(rule(".aside-head-quote")).toMatch(/-webkit-line-clamp: 2;/);
    expect(viewSrc).toMatch(/<AsideTranscript \{aside\} \{open\} owner=\{session\} frame="full" scrollKey=\{[^}]*\}[^/]*\/>/);
    // ~~no `lead=` at all~~ — item 685: the lead is the card's room, never the quote.
    expect(viewSrc).not.toMatch(/<AsideTranscript[^>]*lead=\{quoted\}/);
    expect(viewSrc).toMatch(/<AsideTranscript[^>]*lead=\{room\}/);
    // Classic still leads its own thread with the passage.
    expect(viewSrc).toMatch(/\{@render quoted\(\)\}/);
  });

  it("the foot is the composer's row: about, Fold with the coil, Close at 28 px", () => {
    const t = viewSrc.slice(viewSrc.indexOf('<div class="aside-head-foot">'));
    expect(t).toMatch(/class="aside-about"[\s\S]*<AsideFoldPanel \{aside\} part="button" \{open\} twin \/>[\s\S]*class="ns-btn ghost aside-view-close"/);
    expect(rule(".aside-head-foot :global(.ns-btn.aside-fold)")).toMatch(/min-height: 28px;/);
    expect(foldSrc).toMatch(/class:fil-ghost=\{twin\}/);
    expect(foldSrc).toMatch(/\{#if twin && !classic\(\)\}<FilamentMark kind="aside" \/>\{:else\}<Icon name="think"/);
  });
});
