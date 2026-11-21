// Item 853, fix 2 (2026-11-19, his "typing while in an aside if im not focused on the bar doesnt do shit", and the
// same in the main chat): the keys go to the box of the region he last pressed, even when that press gave WebKit no
// focus to move — the card's head and grip (their mousedown starts a move and is prevented), a button. Before the
// fix the focus left behind (the chat's transcript, a tab) read as "elsewhere" and the key went nowhere.
//
// The suite runs in node (vite.config.ts), so this drives the real listeners — `noteCardPress`, `noteFocusMove`,
// `typeToComposeKeydown`, `pasteToComposeKeydown` — over a small fake of the App's DOM, laid out as the App draws it
// (an anchored card inside the chat's transcript, inside the pane). The WebKit run with real AppKit clicks and keys
// over the real App is `harness/type853` (see its config).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as tc from "./typeToCompose";
import { noteCardPress, typeToComposeKeydown } from "./typeToCompose";

const noteScroll = (e: Event) => (tc as { noteScroll?: (e: Event) => void }).noteScroll?.(e);

// Read through the module so the cases also run (and fail) on the code before the fix, which had neither.
const noteFocusMove = (e: Event) => (tc as { noteFocusMove?: (e: Event) => void }).noteFocusMove?.(e);
const isStaleFocus = (...a: Parameters<typeof tc.isStaleFocus>) => tc.isStaleFocus(...a);
import { pasteToComposeKeydown, registerPasteHandler } from "./pasteToCompose";

/** A fake element: tag, classes, attributes, children; `closest`, `matches`, `querySelector(All)` over simple
 *  selectors (tag, .class, [attr], [attr="v"]), descendant combinators and comma lists. */
class El {
  parentElement: El | null = null;
  children: El[] = [];
  classList: { contains: (c: string) => boolean };
  attrs: Record<string, string>;
  focused = 0;
  value = "";
  disabled = false;
  isContentEditable = false;
  constructor(
    public tagName: string,
    public cls: string[] = [],
    attrs: Record<string, string> = {},
    kids: El[] = [],
  ) {
    this.attrs = attrs;
    this.classList = { contains: (c) => this.cls.includes(c) };
    for (const k of kids) this.add(k);
  }
  add(k: El): El {
    k.parentElement = this;
    this.children.push(k);
    return k;
  }
  get isConnected(): boolean {
    let n: El | null = this;
    while (n.parentElement) n = n.parentElement;
    return n === doc.documentElement;
  }
  getAttribute(a: string): string | null {
    return a in this.attrs ? this.attrs[a] : null;
  }
  contains(o: unknown): boolean {
    for (let n = o as El | null; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  private simple(sel: string): boolean {
    const m = sel.match(/^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)(?::not\(([^)]*)\))?$/i);
    if (!m) return false;
    if (m[1] && m[1].toUpperCase() !== this.tagName) return false;
    for (const c of m[2].split(".").filter(Boolean)) if (!this.cls.includes(c)) return false;
    for (const a of m[3].match(/\[[^\]]+\]/g) ?? []) {
      const [, k, v] = a.match(/^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/) ?? [];
      if (!k || !(k in this.attrs) || (v !== undefined && this.attrs[k] !== v)) return false;
    }
    if (m[4] && this.simple(m[4])) return false;
    return true;
  }
  matches(sel: string): boolean {
    return sel.split(",").some((one) => {
      const parts = one.trim().split(/\s+/);
      if (!this.simple(parts[parts.length - 1])) return false;
      let n = this.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (n && !n.simple(parts[i])) n = n.parentElement;
        if (!n) return false;
        n = n.parentElement;
      }
      return true;
    });
  }
  closest(sel: string): El | null {
    for (let n: El | null = this; n; n = n.parentElement) if (n.matches(sel)) return n;
    return null;
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string): El[] {
    return this.all().filter((e) => e.matches(sel));
  }
  querySelector(sel: string): El | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  focus(): void {
    this.focused += 1;
    doc.activeElement = this;
    noteFocusMove({ target: this } as unknown as Event);
  }
}
class TextArea extends El {
  scrollTop = 0;
  scrollHeight = 0;
  constructor() {
    super("TEXTAREA");
  }
  setSelectionRange(): void {}
}

let doc: { documentElement: El; body: El; activeElement: El | null; querySelector(s: string): El | null; querySelectorAll(s: string): El[] };
let chatBox: El, cardBox: El, transcript: El, cardHead: El, cardThread: El, tab: El, sidebarRow: El, topBar: El, pane2: El, pane2Text: El, pane2Box: El;

function build(): void {
  const html = new El("HTML");
  const body = html.add(new El("BODY"));
  doc = { documentElement: html, body, activeElement: body, querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s) };
  sidebarRow = body.add(new El("DIV", ["sidebar-row"], { tabindex: "0" }));
  const pane = body.add(new El("SECTION", ["pane", "focused"]));
  tab = pane.add(new El("DIV", ["tab"], { role: "tab", tabindex: "0" }));
  topBar = pane.add(new El("HEADER", ["topbar"]));
  transcript = pane.add(new El("DIV", ["transcript"], { tabindex: "-1" }));
  // An anchored card sits in the chat's transcript, beside its passage.
  const card = transcript.add(new El("DIV", ["aside-card"]));
  cardHead = card.add(new El("DIV", ["aside-card-head"]));
  cardThread = card.add(new El("DIV", ["transcript"], { tabindex: "-1" }));
  cardBox = card.add(new El("DIV", ["composer", "aside"])).add(new El("DIV", ["ta-wrap"])).add(new TextArea());
  chatBox = pane.add(new El("DIV", ["composer"])).add(new El("DIV", ["ta-wrap"])).add(new TextArea());
  // The other split pane: an aside tab, its own transcript and box.
  pane2 = body.add(new El("SECTION", ["pane"], { "data-pane": "p2" }));
  pane2Text = pane2.add(new El("DIV", ["transcript"], { tabindex: "-1" }));
  pane2Box = pane2.add(new El("DIV", ["composer", "aside"])).add(new El("DIV", ["ta-wrap"])).add(new TextArea());
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = doc;
  g.HTMLTextAreaElement = TextArea;
}

/** A press as WebKit gives it: pointerdown (the listener), then the focus — moved to `focusTo`, or left as it was
 *  (a prevented mousedown, a button). */
function press(on: El, focusTo: El | null): void {
  noteCardPress({ target: on } as unknown as Event);
  focusTo?.focus();
}

/** A typed "h": the window's capture listener; true when it moved the focus into `box`. */
const panesFocused: El[] = [];
function typeInto(box: El): boolean {
  const before = box.focused;
  const e = { key: "h", code: "KeyH", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 72, defaultPrevented: false };
  typeToComposeKeydown(e as unknown as KeyboardEvent, undefined, undefined, (p) => panesFocused.push(p as unknown as El));
  return box.focused > before && doc.activeElement === box;
}

beforeEach(async () => {
  build();
  // Let the previous test's press settle (`pressing` clears on a timeout).
  await new Promise((r) => setTimeout(r, 1));
  noteCardPress({ target: doc.body } as unknown as Event);
  await new Promise((r) => setTimeout(r, 1));
});
afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.HTMLTextAreaElement;
});

describe("853 fix 2: the box of the region he last pressed", () => {
  it("the card's head pressed (no focus move) with the focus left in the chat's transcript → the card's box", async () => {
    transcript.focus();
    await new Promise((r) => setTimeout(r, 1));
    press(cardHead, null);
    expect(typeInto(cardBox)).toBe(true);
    expect(chatBox.focused).toBe(0);
  });

  it("the card's head pressed with the focus left on a tab of the strip → the card's box", async () => {
    tab.focus();
    await new Promise((r) => setTimeout(r, 1));
    press(cardHead, null);
    expect(typeInto(cardBox)).toBe(true);
  });

  it("the card's head pressed with the focus left in the chat's box → the card's box, not the chat's", async () => {
    chatBox.focus();
    await new Promise((r) => setTimeout(r, 1));
    press(cardHead, null);
    expect(typeInto(cardBox)).toBe(true);
  });

  it("the card's thread pressed (its transcript takes the focus) → the card's box, as before", () => {
    press(cardThread, cardThread);
    expect(typeInto(cardBox)).toBe(true);
  });

  it("the card's foot pressed, the focus landing on the chat's transcript around it → the card's box", () => {
    press(cardHead, transcript);
    expect(typeInto(cardBox)).toBe(true);
  });

  it("the chat's top bar pressed with the focus left on the sidebar → the chat's box", async () => {
    sidebarRow.focus();
    await new Promise((r) => setTimeout(r, 1));
    press(topBar, null);
    expect(typeInto(chatBox)).toBe(true);
  });

  it("the chat's transcript pressed → the chat's box, as before", () => {
    press(transcript, transcript);
    expect(typeInto(chatBox)).toBe(true);
  });

  it("a field the focus moves to by itself after the press (Tab) is his: its keys are its own", async () => {
    press(cardHead, null);
    await new Promise((r) => setTimeout(r, 1));
    chatBox.focus(); // Tab, after the press settled
    typeInto(cardBox);
    expect(cardBox.focused).toBe(0);
    expect(doc.activeElement).toBe(chatBox);
  });

  it("a press outside any pane (the sidebar) leaves the old rule: its focused row is elsewhere", () => {
    press(sidebarRow, sidebarRow);
    expect(typeInto(chatBox)).toBe(false);
  });

  it("⌘V with the focus left in the chat's transcript after a press on the card's head pastes into the card", async () => {
    transcript.focus();
    await new Promise((r) => setTimeout(r, 1));
    press(cardHead, null);
    const got: string[] = [];
    const offCard = registerPasteHandler(cardBox.parentElement!.parentElement as unknown as Element, () => got.push("card"));
    const offChat = registerPasteHandler(chatBox.parentElement!.parentElement as unknown as Element, () => got.push("chat"));
    const e = { key: "v", code: "KeyV", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, preventDefault() {} };
    pasteToComposeKeydown(e as unknown as KeyboardEvent, true);
    offCard();
    offChat();
    expect(got).toEqual(["card"]);
  });
});

/** A wheel or trackpad scroll over `on`: no focus moves. */
function scroll(on: El): void {
  noteScroll({ target: on } as unknown as Event);
}

describe("853 / blocker 2204: a scroll marks the place under it", () => {
  it("the card's answer scrolled with the focus in the chat's box → the card's box", async () => {
    chatBox.focus();
    await new Promise((r) => setTimeout(r, 1));
    scroll(cardThread);
    expect(typeInto(cardBox)).toBe(true);
    expect(doc.activeElement).toBe(cardBox);
  });

  it("the card's answer scrolled with the focus on the chat's transcript → the card's box", async () => {
    transcript.focus();
    await new Promise((r) => setTimeout(r, 1));
    scroll(cardThread);
    expect(typeInto(cardBox)).toBe(true);
  });

  it("the chat's transcript scrolled with the focus in the card's box → the chat's box", async () => {
    cardBox.focus();
    await new Promise((r) => setTimeout(r, 1));
    scroll(transcript);
    expect(typeInto(chatBox)).toBe(true);
  });

  it("the card scrolled while typing in its own box: the box stays his (no focus move, keys its own)", async () => {
    cardBox.focus();
    await new Promise((r) => setTimeout(r, 1));
    const n = cardBox.focused;
    scroll(cardThread);
    expect(cardBox.focused).toBe(n);
    typeInto(cardBox);
    expect(doc.activeElement).toBe(cardBox);
    expect(chatBox.focused).toBe(0);
  });

  it("the chat scrolled while typing in its box: the box stays his", async () => {
    chatBox.focus();
    await new Promise((r) => setTimeout(r, 1));
    scroll(transcript);
    typeInto(chatBox);
    expect(doc.activeElement).toBe(chatBox);
  });

  it("the other split pane scrolled → that pane's box, and that pane is focused", async () => {
    chatBox.focus();
    await new Promise((r) => setTimeout(r, 1));
    panesFocused.length = 0;
    scroll(pane2Text);
    expect(typeInto(pane2Box)).toBe(true);
    expect(panesFocused).toEqual([pane2]);
  });

  it("a scroll moves no focus by itself", () => {
    transcript.focus();
    scroll(cardThread);
    expect(doc.activeElement).toBe(transcript);
  });
});

describe("isStaleFocus", () => {
  const region = { contains: (el: unknown) => el === "inside" };
  it("is stale only when the pressed region is the target's and the focus is outside it", () => {
    expect(isStaleFocus(region, region, "outside", false)).toBe(true);
    expect(isStaleFocus(region, region, "inside", false)).toBe(false);
    expect(isStaleFocus(region, { contains: () => false }, "outside", false)).toBe(false);
    expect(isStaleFocus(null, region, "outside", false)).toBe(false);
    expect(isStaleFocus(region, region, "outside", true)).toBe(false);
  });
});
