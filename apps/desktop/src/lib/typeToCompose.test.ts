import { describe, expect, it } from "vitest";
import {
  focusKindOf,
  inFocusedPane,
  isPrintable,
  sendsToComposer,
  TYPE_BLOCKERS,
  type ComposeContext,
  type FocusEl,
  type KeyLike,
} from "./typeToCompose";

// Item 316: a printable keystroke with the focus outside the chat's box
// moves the focus there (the character follows); everything else is left
// alone.

const k = (key: string, more: Partial<KeyLike> = {}): KeyLike => ({ key, metaKey: false, ctrlKey: false, ...more });
const at = (focus: ComposeContext["focus"], more: Partial<ComposeContext> = {}): ComposeContext => ({
  focus,
  blocked: false,
  composer: true,
  ...more,
});

describe("sendsToComposer — yes", () => {
  it("a letter, a digit, punctuation with nothing focused", () => {
    for (const key of ["h", "7", ".", "/", "?", "'"]) expect(sendsToComposer(k(key), at("none"))).toBe(true);
  });
  it("from the transcript (non-editable content)", () => {
    expect(sendsToComposer(k("h"), at("content"))).toBe(true);
  });
  it("a capital with Shift", () => {
    expect(sendsToComposer(k("H", { shiftKey: true }), at("content"))).toBe(true);
  });
  it("an ⌥ character", () => {
    expect(sendsToComposer(k("π", { altKey: true }), at("content"))).toBe(true);
    expect(sendsToComposer(k("é"), at("none"))).toBe(true);
  });
  it("Space from content or nothing", () => {
    expect(sendsToComposer(k(" "), at("content"))).toBe(true);
    expect(sendsToComposer(k(" "), at("none"))).toBe(true);
  });
  it("a letter on a focused button (a button types nothing)", () => {
    expect(sendsToComposer(k("h"), at("control"))).toBe(true);
  });
  it("an astral character (one code point, two UTF-16 units)", () => {
    expect(sendsToComposer(k("😀"), at("content"))).toBe(true);
  });
});

describe("sendsToComposer — no", () => {
  it("any ⌘ or ⌃ chord (⌘C copies a selection as before)", () => {
    expect(sendsToComposer(k("c", { metaKey: true }), at("content"))).toBe(false);
    expect(sendsToComposer(k("a", { ctrlKey: true }), at("content"))).toBe(false);
    expect(sendsToComposer(k("C", { metaKey: true, shiftKey: true }), at("none"))).toBe(false);
  });
  it("keys that type nothing", () => {
    for (const key of ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Backspace", "Delete", "F5", "Dead", "Shift", "Meta", "Home", "PageUp", ""])
      expect(sendsToComposer(k(key), at("content"))).toBe(false);
  });
  it("Space on a focused control (it presses it)", () => {
    expect(sendsToComposer(k(" "), at("control"))).toBe(false);
  });
  it("focus in anything he types in", () => {
    expect(sendsToComposer(k("h"), at("editable"))).toBe(false);
  });
  it("focus outside the chat's pane or in an aside card", () => {
    expect(sendsToComposer(k("h"), at("elsewhere"))).toBe(false);
  });
  it("a dialog, sheet, menu or the find bar open", () => {
    expect(sendsToComposer(k("h"), at("content", { blocked: true }))).toBe(false);
  });
  it("an IME composing", () => {
    expect(sendsToComposer(k("n", { isComposing: true }), at("content"))).toBe(false);
    expect(sendsToComposer(k("Process", { keyCode: 229 }), at("content"))).toBe(false);
    expect(sendsToComposer(k("n", { keyCode: 229 }), at("content"))).toBe(false);
  });
  it("no chat composer mounted", () => {
    expect(sendsToComposer(k("h"), at("none", { composer: false }))).toBe(false);
  });
  it("a held key's repeats", () => {
    expect(sendsToComposer(k("h", { repeat: true }), at("content"))).toBe(false);
  });
});

describe("isPrintable", () => {
  it("rejects control characters and multi-character names", () => {
    expect(isPrintable("\u0000")).toBe(false);
    expect(isPrintable("\u007f")).toBe(false);
    expect(isPrintable("\u0085")).toBe(false);
    expect(isPrintable("Enter")).toBe(false);
    expect(isPrintable("a")).toBe(true);
  });
});

/** A fake element: a tag, optional input type / contenteditable, and the selectors it matches or sits under. */
function el(tag: string, o: { type?: string; editable?: boolean; matches?: string[]; under?: string[] } = {}): FocusEl {
  return {
    tagName: tag,
    type: o.type,
    isContentEditable: o.editable ?? false,
    matches: (sel: string) => (o.matches ?? []).some((m) => sel.split(", ").includes(m)),
    closest: (sel: string) => ((o.under ?? []).some((u) => sel.split(", ").includes(u)) ? {} : null),
  };
}
const inside = { contains: () => true };
const outside = { contains: () => false };

describe("focusKindOf", () => {
  it("nothing focused, or the body", () => {
    expect(focusKindOf(null, false, inside)).toBe("none");
    expect(focusKindOf(el("BODY"), true, inside)).toBe("none");
  });
  it("text fields of every kind are editable — search, find bar, rename, note, question card's Other", () => {
    expect(focusKindOf(el("INPUT"), false, inside)).toBe("editable");
    expect(focusKindOf(el("INPUT", { type: "search" }), false, outside)).toBe("editable");
    expect(focusKindOf(el("TEXTAREA"), false, inside)).toBe("editable");
    expect(focusKindOf(el("DIV", { editable: true }), false, inside)).toBe("editable");
    expect(focusKindOf(el("SELECT"), false, inside)).toBe("editable");
  });
  it("a checkbox or button input is a control, not editable", () => {
    expect(focusKindOf(el("INPUT", { type: "checkbox", matches: ["input"] }), false, inside)).toBe("control");
  });
  it("a button or link in the pane is a control", () => {
    expect(focusKindOf(el("BUTTON", { matches: ["button"] }), false, inside)).toBe("control");
    expect(focusKindOf(el("A", { matches: ["a[href]"] }), false, inside)).toBe("control");
  });
  it("the transcript's scroll box is content", () => {
    expect(focusKindOf(el("DIV"), false, inside)).toBe("content");
  });
  it("outside the chat's pane (the sidebar) is elsewhere", () => {
    expect(focusKindOf(el("BUTTON", { matches: ["button"] }), false, outside)).toBe("elsewhere");
    expect(focusKindOf(el("DIV"), false, null)).toBe("elsewhere");
  });
  it("inside a floating aside card is elsewhere", () => {
    expect(focusKindOf(el("BUTTON", { matches: ["button"], under: [".aside-card"] }), false, inside)).toBe("elsewhere");
  });
});

describe("TYPE_BLOCKERS", () => {
  it("covers modals, dialogs, menus, the find bar and the palette", () => {
    for (const s of ['[aria-modal="true"]', '[role="dialog"]', '[role="menu"]', ".find-bar", ".pal", ".settings-overlay"])
      expect(TYPE_BLOCKERS).toContain(s);
  });
});

describe("inFocusedPane (316 review)", () => {
  const composer = {};
  it("the composer's pane is the focused one", () => {
    expect(inFocusedPane(composer, { contains: (el) => el === composer })).toBe(true);
  });
  it("the other pane is focused (a click on a note's text there): left alone", () => {
    expect(inFocusedPane(composer, { contains: () => false })).toBe(false);
  });
  it("no pane marked focused reads as yes", () => {
    expect(inFocusedPane(composer, null)).toBe(true);
  });
});
