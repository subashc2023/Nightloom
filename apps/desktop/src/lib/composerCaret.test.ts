import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CaretKeeper,
  clampSel,
  isEditable,
  isFocusChord,
  mayAutoFocus,
  mayCmdL,
  type DocLike,
  type ElLike,
} from "./composerCaret";
import type { ComposerBox } from "./composerEditor";
import {
  clearDraft,
  draftKey,
  draftSelection,
  drafts,
  enqueueMessage,
  loadDrafts,
  moveDraft,
  readDraft,
  serializeDrafts,
  setDraftSelection,
  setDraftText,
} from "./drafts.svelte";
import { asideDraftKey } from "./asides";
import { app, continueChat, newTab, openSession, reflectTabs, stepTab } from "./state.svelte";
import * as tabs from "./tabs";

/**
 * Nightshift backlog 290: the composer keeps each draft's caret, takes the
 * focus when a chat arrives unless something else has it, and ⌘L focuses
 * it. The suite runs in node, so the box and the document are fakes with
 * the slices `composerCaret.ts` reads; the component's wiring (a key change
 * or a mount calls `arrive`, then `focus` when `mayAutoFocus` allows) is
 * modelled by `arriveAndFocus` below, as `Composer.svelte` does it.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openSession: vi.fn(async (id: string) => [
    { event: "session_created", at: "2026-01-01T00:00:00Z", kind: "build", mode: "normal" },
    { event: "user_message", at: "2026-01-01T00:00:00Z", text: `hello from ${id}` },
  ]),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  continueSession: vi.fn(async () => ({ session: "chat-next", events: [], forked: true })),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

// ---- fakes -------------------------------------------------------------------

class FakeEl implements ElLike {
  parent: FakeEl | null = null;
  classes: string[];
  constructor(
    public tagName: string,
    classes: string[] = [],
    public type?: string,
    public isContentEditable = false,
  ) {
    this.classes = classes;
  }
  in(parent: FakeEl): this {
    this.parent = parent;
    return this;
  }
  closest(selector: string): FakeEl | null {
    const cls = selector.startsWith(".") ? selector.slice(1) : null;
    for (let e: FakeEl | null = this; e; e = e.parent) if (cls && e.classes.includes(cls)) return e;
    return null;
  }
}

class FakeDoc implements DocLike {
  activeElement: ElLike | null = null;
  open = new Set<string>();
  querySelector(selector: string): unknown {
    return selector.split(",").some((s) => this.open.has(s.trim())) ? {} : null;
  }
}

/** A textarea as far as the composer drives one: setting the value puts
 *  the caret at the end, as WebKit does; the setters behave as its do. */
class FakeBox implements ComposerBox {
  selectionStart = 0;
  selectionEnd = 0;
  focusCount = 0;
  el: FakeEl;
  private v = "";
  constructor(
    private readonly doc: FakeDoc,
    root: FakeEl,
  ) {
    this.el = new FakeEl("TEXTAREA").in(root);
  }
  get value(): string {
    return this.v;
  }
  show(text: string): void {
    this.v = text;
    this.selectionStart = this.selectionEnd = text.length;
  }
  focus(): void {
    this.focusCount += 1;
    this.doc.activeElement = this.el;
  }
  get style(): CSSStyleDeclaration {
    return {} as CSSStyleDeclaration;
  }
  scrollHeight = 0;
  offsetHeight = 0;
  clientWidth = 0;
  clientHeight = 0;
  scrollTop = 0;
  closest(): Element | null {
    return null;
  }
  getBoundingClientRect(): DOMRect {
    return {} as DOMRect;
  }
}

const store = { get: draftSelection, set: setDraftSelection };

function setup() {
  const doc = new FakeDoc();
  const root = new FakeEl("DIV", ["composer"]);
  const box = new FakeBox(doc, root);
  const keeper = new CaretKeeper(store);
  return { doc, root, box, keeper };
}

/** The component's switch: keep the old key's caret, show the new draft,
 *  then put its caret back and take the focus when allowed. */
function switchTo(
  s: ReturnType<typeof setup>,
  from: string | null,
  to: string,
): { focused: boolean } {
  if (from !== null) s.keeper.record(from, s.box, readDraft(from).text);
  s.box.show(readDraft(to).text);
  return arriveAndFocus(s, to);
}

function arriveAndFocus(s: ReturnType<typeof setup>, key: string): { focused: boolean } {
  s.keeper.arrive(key);
  const had = s.doc.activeElement === s.box.el;
  if (had || mayAutoFocus(s.doc, s.root)) {
    s.keeper.focus(key, s.box, had, false);
    return { focused: true };
  }
  return { focused: false };
}

/** He puts the caret somewhere: the box moves, the keyup records. */
function place(s: ReturnType<typeof setup>, key: string, start: number, end = start): void {
  s.box.selectionStart = start;
  s.box.selectionEnd = end;
  s.keeper.record(key, s.box, readDraft(key).text);
}

function wipe(): void {
  for (const k of Object.keys(drafts)) delete drafts[k];
}

beforeEach(wipe);
afterEach(wipe);

// ---- the kept caret ------------------------------------------------------------

describe("the caret is kept per chat", () => {
  it("a switch away and back puts each chat's caret and selection back", () => {
    const s = setup();
    setDraftText("a", "hello world");
    setDraftText("b", "second chat draft");
    switchTo(s, null, "a");
    place(s, "a", 2, 5);
    switchTo(s, "a", "b");
    place(s, "b", 7);
    switchTo(s, "b", "a");
    expect([s.box.selectionStart, s.box.selectionEnd]).toEqual([2, 5]);
    expect(s.box.value).toBe("hello world");
    switchTo(s, "a", "b");
    expect([s.box.selectionStart, s.box.selectionEnd]).toEqual([7, 7]);
  });

  it("an aside's box keeps its own, under its aside key", () => {
    const s = setup();
    const k = asideDraftKey({ uid: "u1" } as never);
    expect(k).toBe("aside:u1");
    setDraftText(k, "why is this slow?");
    setDraftText("a", "chat words");
    switchTo(s, null, k);
    place(s, k, 4, 6);
    switchTo(s, k, "a");
    place(s, "a", 1);
    // The card unmounts and mounts again (its chat came back).
    const s2 = setup();
    switchTo(s2, null, k);
    expect([s2.box.selectionStart, s2.box.selectionEnd]).toEqual([4, 6]);
    expect(draftSelection("a")).toEqual({ start: 1, end: 1 });
  });

  it("is written with the draft and read back after a reload", () => {
    setDraftText("a", "the draft survives a quit");
    setDraftSelection("a", 4, 9);
    const raw = serializeDrafts(drafts);
    const back = loadDrafts({ getItem: () => raw });
    expect(back.a).toEqual({ text: "the draft survives a quit", attachments: [], queue: [], sel: { start: 4, end: 9 } });
    // A store from before 290 (no `sel`) reads as before.
    const old = loadDrafts({ getItem: () => JSON.stringify({ b: { text: "x", attachments: [], queue: [] } }) });
    expect(old.b).toEqual({ text: "x", attachments: [], queue: [] });
    // A malformed caret costs the caret, never the text.
    const bad = loadDrafts({ getItem: () => JSON.stringify({ c: { text: "keep me", sel: { start: -1, end: "x" } } }) });
    expect(bad.c?.text).toBe("keep me");
    expect(bad.c?.sel).toBeUndefined();
    // After the reload the keeper puts it back.
    wipe();
    Object.assign(drafts, back);
    const s = setup();
    switchTo(s, null, "a");
    expect([s.box.selectionStart, s.box.selectionEnd]).toEqual([4, 9]);
  });

  it("clamps a caret past a shorter draft and never changes the text", () => {
    const s = setup();
    setDraftText("a", "a long draft of words");
    setDraftSelection("a", 15, 20);
    setDraftText("a", "short");
    switchTo(s, null, "a");
    expect(s.box.value).toBe("short");
    expect(readDraft("a").text).toBe("short");
    expect([s.box.selectionStart, s.box.selectionEnd]).toEqual([5, 5]);
    expect(clampSel({ start: 9, end: 2 }, 4)).toEqual({ start: 2, end: 4 });
    expect(clampSel(null, 4)).toBeNull();
  });

  it("an empty box keeps nothing; a send drops the caret with the text; a move carries it", () => {
    setDraftSelection("none", 3, 3);
    expect(drafts.none).toBeUndefined();
    setDraftText("a", "held and typed");
    setDraftSelection("a", 2, 2);
    enqueueMessage("a", "held", []);
    clearDraft("a");
    expect(readDraft("a").queue).toHaveLength(1);
    expect(draftSelection("a")).toBeNull();
    setDraftText("new:p:normal", "first message");
    setDraftSelection("new:p:normal", 5, 5);
    moveDraft("new:p:normal", "chat-1");
    expect(draftSelection("chat-1")).toEqual({ start: 5, end: 5 });
  });

  it("does not record the browser's caret over a kept one that has not gone back yet", () => {
    const s = setup();
    setDraftText("a", "abcdef");
    setDraftSelection("a", 2, 2);
    s.doc.open.add('[aria-modal="true"]');
    s.box.show("abcdef");
    expect(arriveAndFocus(s, "a").focused).toBe(false);
    // The box shows the draft with the caret at its end; a stray record
    // must not take that for his.
    s.keeper.record("a", s.box, "abcdef");
    expect(draftSelection("a")).toEqual({ start: 2, end: 2 });
    // A click into the box: the click places the caret; nothing jumps.
    s.box.selectionStart = s.box.selectionEnd = 4;
    s.keeper.focusIn("a", s.box, true);
    expect(s.box.selectionStart).toBe(4);
    // A keyboard focus instead puts the kept caret back.
    const t = setup();
    t.box.show("abcdef");
    t.keeper.arrive("a");
    t.keeper.focusIn("a", t.box, false);
    expect(t.box.selectionStart).toBe(2);
  });
});

// ---- focus when a chat arrives -----------------------------------------------------

describe("focus lands in the box", () => {
  beforeEach(() => {
    app.tabs = tabs.emptyWorkspace();
    app.openNext = "replace";
    app.activeSessionId = null;
    app.events = [];
    app.view = "chat";
    app.openNote = null;
    app.busy = false;
    app.toasts = [];
  });

  const keyNow = () => draftKey(app.activeSessionId, app.project?.id, app.pendingMode);

  it("on a chat switch, a new chat, Ctrl+Tab and Continue — each a new key the box arrives at", async () => {
    const s = setup();
    const body = new FakeEl("BODY");
    s.doc.activeElement = body;

    await openSession("a");
    reflectTabs();
    setDraftText("a", "draft in a");
    let k = keyNow();
    expect(k).toBe("a");
    expect(switchTo(s, null, k).focused).toBe(true);
    expect(s.doc.activeElement).toBe(s.box.el);
    expect(s.box.selectionStart).toBe("draft in a".length);
    place(s, "a", 0);

    // A sidebar click: the focus is on nothing he types in.
    s.doc.activeElement = body;
    app.openNext = "new";
    await openSession("b");
    reflectTabs();
    const prev = k;
    k = keyNow();
    expect(k).toBe("b");
    expect(switchTo(s, prev, k).focused).toBe(true);

    // Ctrl+Tab (item 286) runs `next_tab`, which is `stepTab(1)`; the box
    // had the focus and keeps it, with the arriving chat's caret.
    await stepTab(1);
    const k2 = keyNow();
    expect(k2).toBe("a");
    const before = s.box.focusCount;
    expect(switchTo(s, k, k2).focused).toBe(true);
    expect(s.box.focusCount).toBe(before); // already focused: not refocused
    expect(s.box.selectionStart).toBe(0);

    // A new chat: the pending chat's key.
    s.doc.activeElement = body;
    await newTab();
    const k3 = keyNow();
    expect(k3.startsWith("new:")).toBe(true);
    expect(switchTo(s, k2, k3).focused).toBe(true);
    expect(s.doc.activeElement).toBe(s.box.el);

    // Continue (the wrap-up's hand-off) opens the linked chat.
    s.doc.activeElement = body;
    app.activeSessionId = "a";
    await continueChat();
    const k4 = keyNow();
    expect(k4).toBe("chat-next");
    expect(switchTo(s, "a", k4).focused).toBe(true);
    expect(s.box.selectionStart).toBe(s.box.value.length);
  });

  it("never takes the focus from a modal, the find bar, a menu or another field", () => {
    const blockers = ['[aria-modal="true"]', ".settings-overlay", ".find-bar", '[role="menu"]', '[role="dialog"]', ".scrim"];
    for (const b of blockers) {
      const s = setup();
      setDraftText("a", "x");
      s.doc.open.add(b);
      expect(switchTo(s, null, "a").focused, b).toBe(false);
      expect(s.box.focusCount, b).toBe(0);
    }
    // The find bar's field focused (and the bar open): no steal.
    const f = setup();
    f.doc.activeElement = new FakeEl("INPUT", ["find-field"], "text").in(new FakeEl("DIV", ["find-bar"]));
    expect(switchTo(f, null, "a").focused).toBe(false);
    // A rename field, a note editor (contenteditable), a select.
    for (const el of [new FakeEl("INPUT", [], "text"), new FakeEl("DIV", [], undefined, true), new FakeEl("SELECT")]) {
      const s = setup();
      s.doc.activeElement = el;
      expect(switchTo(s, null, "a").focused).toBe(false);
    }
    // A focused button is not a field: a sidebar row by keyboard.
    const b = setup();
    b.doc.activeElement = new FakeEl("BUTTON");
    expect(switchTo(b, null, "a").focused).toBe(true);
    expect(isEditable(new FakeEl("INPUT", [], "checkbox"))).toBe(false);
  });
});

// ---- ⌘L ------------------------------------------------------------------------------

describe("⌘L", () => {
  const ev = (o: Partial<KeyboardEvent>) =>
    ({ code: "KeyL", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;

  it("is ⌘L on macOS and Ctrl+L elsewhere, nothing else", () => {
    expect(isFocusChord(ev({ metaKey: true }), true)).toBe(true);
    expect(isFocusChord(ev({ ctrlKey: true }), true)).toBe(false);
    expect(isFocusChord(ev({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isFocusChord(ev({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isFocusChord(ev({ ctrlKey: true }), false)).toBe(true);
    expect(isFocusChord(ev({ metaKey: true }), false)).toBe(false);
    expect(isFocusChord(ev({ code: "KeyK", metaKey: true }), true)).toBe(false);
  });

  it("focuses the box with the caret at the end of the draft, or where he left it", () => {
    const s = setup();
    setDraftText("a", "the end is here");
    s.box.show("the end is here");
    s.box.selectionStart = s.box.selectionEnd = 0;
    s.doc.activeElement = new FakeEl("BODY");
    s.keeper.focus("a", s.box, false, true);
    expect(s.doc.activeElement).toBe(s.box.el);
    expect(s.box.selectionStart).toBe("the end is here".length);
    // With a kept caret, that one.
    setDraftSelection("a", 4, 7);
    s.doc.activeElement = new FakeEl("BODY");
    s.keeper.focus("a", s.box, false, true);
    expect([s.box.selectionStart, s.box.selectionEnd]).toEqual([4, 7]);
    // Already in the box: the caret stays where it is.
    s.box.selectionStart = s.box.selectionEnd = 2;
    s.keeper.focus("a", s.box, true, true);
    expect(s.box.selectionStart).toBe(2);
  });

  it("works from the find bar or another field, not under a modal or from the terminal", () => {
    const d = new FakeDoc();
    d.activeElement = new FakeEl("INPUT", [], "text").in(new FakeEl("DIV", ["find-bar"]));
    d.open.add(".find-bar");
    expect(mayCmdL(d)).toBe(true);
    d.open.add(".settings-overlay");
    expect(mayCmdL(d)).toBe(false);
    const t = new FakeDoc();
    t.activeElement = new FakeEl("TEXTAREA").in(new FakeEl("DIV", ["xterm"]));
    expect(mayCmdL(t)).toBe(false);
    const p = new FakeDoc();
    p.open.add(".pal");
    expect(mayCmdL(p)).toBe(false);
  });
});
