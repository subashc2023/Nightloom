import summonSrc from "./composerSummon.svelte.ts?raw";
import composerSrc from "./Composer.svelte?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pasteChord,
  pasteFocusOf,
  pastesToComposer,
  pasteToComposeEvent,
  pasteToComposeKeydown,
  registerPasteHandler,
  type PasteContext,
  type PasteKeyLike,
  type PasteRequest,
} from "./pasteToCompose";
import type { FocusEl } from "./typeToCompose";

// Item 351: ⌘V with the focus outside every text field pastes into the
// open chat's box; a focused text field keeps its own paste.

const key = (more: Partial<PasteKeyLike> = {}): PasteKeyLike => ({
  key: "v",
  code: "KeyV",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...more,
});

describe("pasteChord", () => {
  it("⌘V is a plain paste, ⌥⌘V an attachment (by code: ⌥V types √)", () => {
    expect(pasteChord(key(), true)).toBe("plain");
    expect(pasteChord(key({ altKey: true, key: "√" }), true)).toBe("attach");
  });
  it("Ctrl+V and Ctrl+Alt+V off the Mac", () => {
    expect(pasteChord(key({ metaKey: false, ctrlKey: true }), false)).toBe("plain");
    expect(pasteChord(key({ metaKey: false, ctrlKey: true, altKey: true }), false)).toBe("attach");
    expect(pasteChord(key(), false)).toBe(null);
  });
  it("⌘V on a layout where V is elsewhere goes by the character", () => {
    expect(pasteChord(key({ code: "Period" }), true)).toBe("plain");
  });
  it("not ⌘⇧V (the clipboard history), a held key, a bare V, ⌃V on the Mac, ⌘C", () => {
    expect(pasteChord(key({ shiftKey: true, key: "V" }), true)).toBe(null);
    expect(pasteChord(key({ repeat: true }), true)).toBe(null);
    expect(pasteChord(key({ metaKey: false }), true)).toBe(null);
    expect(pasteChord(key({ metaKey: false, ctrlKey: true }), true)).toBe(null);
    expect(pasteChord(key({ metaKey: true, ctrlKey: true }), true)).toBe(null);
    expect(pasteChord(key({ key: "c", code: "KeyC" }), true)).toBe(null);
  });
});

const ctx = (focus: PasteContext["focus"], more: Partial<PasteContext> = {}): PasteContext => ({
  focus,
  blocked: false,
  composer: true,
  ...more,
});

describe("pastesToComposer", () => {
  it("yes with the focus outside every text field", () => {
    expect(pastesToComposer(ctx("outside"))).toBe(true);
  });
  it("no in a text field, in a floating aside card, blocked, or with no composer", () => {
    expect(pastesToComposer(ctx("editable"))).toBe(false);
    expect(pastesToComposer(ctx("aside"))).toBe(false);
    expect(pastesToComposer(ctx("outside", { blocked: true }))).toBe(false);
    expect(pastesToComposer(ctx("outside", { composer: false }))).toBe(false);
  });
});

function el(tagName: string, more: { contentEditable?: boolean; type?: string; inAside?: boolean } = {}): FocusEl {
  return {
    tagName,
    type: more.type,
    isContentEditable: more.contentEditable ?? false,
    closest: (s: string) => (more.inAside && s.includes("aside") ? {} : null),
    matches: () => false,
  } as unknown as FocusEl;
}

describe("pasteFocusOf", () => {
  it("nothing, the body, a button, the transcript, the sidebar: outside", () => {
    expect(pasteFocusOf(null, false)).toBe("outside");
    expect(pasteFocusOf(el("BODY"), true)).toBe("outside");
    expect(pasteFocusOf(el("BUTTON"), false)).toBe("outside");
    expect(pasteFocusOf(el("DIV"), false)).toBe("outside");
    expect(pasteFocusOf(el("INPUT", { type: "checkbox" }), false)).toBe("outside");
  });
  it("search, a note, the edit box, an aside's box, the terminal: editable", () => {
    expect(pasteFocusOf(el("INPUT", { type: "search" }), false)).toBe("editable");
    expect(pasteFocusOf(el("TEXTAREA"), false)).toBe("editable");
    expect(pasteFocusOf(el("DIV", { contentEditable: true }), false)).toBe("editable");
    expect(pasteFocusOf(el("TEXTAREA", { inAside: true }), false)).toBe("editable");
  });
  it("a control in a floating aside card: aside", () => {
    expect(pasteFocusOf(el("BUTTON", { inAside: true }), false)).toBe("aside");
  });
});

// The DOM side, on a fake document: the chat's composer, its box, and
// whatever has the focus.
describe("pasteToComposeKeydown / pasteToComposeEvent", () => {
  class FakeTextarea {
    disabled = false;
    getAttribute() {
      return null;
    }
    closest() {
      return null;
    }
  }
  const box = new FakeTextarea();
  const root = {
    closest: () => null,
    querySelector: () => box,
  };
  const body = el("BODY");
  let active: FocusEl = body;
  let blocked = false;
  let seen: PasteRequest[] = [];
  let off: () => void = () => {};

  beforeEach(() => {
    active = body;
    blocked = false;
    seen = [];
    vi.stubGlobal("HTMLTextAreaElement", FakeTextarea);
    vi.stubGlobal("document", {
      get activeElement() {
        return active;
      },
      body,
      documentElement: {},
      querySelector: (s: string) => (s === "section.pane.focused" ? null : blocked ? {} : null),
      querySelectorAll: () => [root],
    });
    off = registerPasteHandler(root as unknown as Element, (r) => seen.push(r));
  });
  afterEach(() => {
    off();
    vi.unstubAllGlobals();
  });

  const down = (more: Partial<PasteKeyLike> = {}) => {
    const e = { ...key(more), defaultPrevented: false, preventDefault: vi.fn() };
    pasteToComposeKeydown(e as unknown as KeyboardEvent, true);
    return e;
  };

  it("⌘V on the transcript is prevented and handed to the composer", () => {
    active = el("DIV");
    const e = down();
    expect(e.preventDefault).toHaveBeenCalled();
    expect(seen).toEqual([{ kind: "plain" }]);
  });
  it("⌥⌘V with nothing focused asks for the attachment paste", () => {
    down({ altKey: true, key: "√" });
    expect(seen).toEqual([{ kind: "attach" }]);
  });
  it("⌘V in another text field is left to it", () => {
    active = el("INPUT", { type: "text" });
    const e = down();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
  it("⌘V with a modal or menu open is left alone", () => {
    blocked = true;
    const e = down();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
  it("no composer listening (an aside's box only): left alone", () => {
    off();
    const e = down();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
  it("a paste event with nothing to paste into goes to the composer; one in a field does not", () => {
    const pe = { defaultPrevented: false } as unknown as ClipboardEvent;
    pasteToComposeEvent(pe);
    expect(seen).toEqual([{ event: pe }]);
    active = el("TEXTAREA");
    pasteToComposeEvent({ defaultPrevented: false } as unknown as ClipboardEvent);
    expect(seen.length).toBe(1);
  });
});

// Wave 8 review: the rule above is pure; these pin the wiring, which no
// test exercised (removing either listener or the handler failed nothing).

describe("351: the wiring", () => {
  it("the window listens for ⌘V and for a stray paste, capture phase, and lets both go", () => {
    expect(summonSrc).toContain("pasteToComposeKeydown(e, isMac);");
    expect(summonSrc).toContain('window.addEventListener("paste", pasteToComposeEvent, true);');
    expect(summonSrc).toContain('window.removeEventListener("paste", pasteToComposeEvent, true);');
  });
  it("the chat's composer (not an aside's) registers its handler", () => {
    expect(composerSrc).toMatch(/if \(aside \|\| !el\) return;\s*return registerPasteHandler\(el, pasteFromOutside\);/);
  });
});
