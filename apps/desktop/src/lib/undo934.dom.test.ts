// @vitest-environment happy-dom
/*
 * Item 934 (his bug, repeated, 2026-11-24: "if i make a change in a chat then switch to another chat and then go
 * back, command z does nothing"; "i literally check focus … and it still doesn't work"). The REAL Composer mounted
 * in a DOM, which no earlier test did (886's tested `boxHistoryFor` alone and the Composer by its source): type in
 * chat A, switch to B, back to A, ⌘Z restores the earlier text and ⇧⌘Z redoes — in the plain box and in the
 * formatted one (his setting: the Format switch on, a CodeMirror editor whose history a chat switch dropped), by
 * the key and by the Edit menu's Undo (the Mac's route), across a tab switch (the box unmounts) too; and every
 * other editable box with a kept draft keeps its own history the same way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

// A Mac, to the app (`platform.ts`) and to CodeMirror (its ⌘ is the navigator's).
// happy-dom has no `isContentEditable`; the app asks it of the focused element (`inTextField`).
vi.hoisted(() => {
  (globalThis as { __NIGHTLOOM_PLATFORM__?: string }).__NIGHTLOOM_PLATFORM__ = "macos";
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest("[contenteditable]")?.getAttribute("contenteditable") === "true";
    },
  });
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => Promise.reject(new Error("no backend")) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

// `asides` first: the module cycle through `state` settles in the app's own order.
await import("./asides.svelte");
const { app, runMenuCommand } = await import("./state.svelte");
const { drafts, readDraft } = await import("./drafts.svelte");
const { asideDraftKey } = await import("./asides");
const { forgetHistories, GROUP_MS } = await import("./boxHistory");
const { forgetEditorHistories } = await import("./editorHistory");
const { installFieldUndo, forgetFieldHistories } = await import("./fieldUndo");
const { composerFormat } = await import("./composerFormat.svelte");
const { EditorView } = await import("@codemirror/view");
const Composer = (await import("./Composer.svelte")).default;
const LiveBox = (await import("./LiveBox.svelte")).default;
const NoteEditor = (await import("./NoteEditor.svelte")).default;
const src = (p: string) => import(/* @vite-ignore */ `${p}?raw`).then((m) => m.default as string);

// happy-dom fires `selectionchange` synchronously, inside CodeMirror's own DOM update, where CodeMirror
// refuses the re-entry ("update in progress"); a browser fires it later. CodeMirror is driven by transactions
// here, so it never needs the event.
document.addEventListener("selectionchange", (e) => e.stopImmediatePropagation(), true);

let mounted: Record<string, unknown>[] = [];
let uninstall: (() => void) | null = null;
let now = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  for (const k of Object.keys(drafts)) delete drafts[k];
  forgetHistories();
  forgetEditorHistories();
  forgetFieldHistories();
  composerFormat.on = false;
  app.asides = [];
  // "Connecting": the box is unlocked (`boxLock.ts`) with no backend behind it.
  app.connecting = true;
  app.activeSessionId = "chat-A";
  document.body.innerHTML = "";
  uninstall = installFieldUndo(window as unknown as Window);
});
afterEach(() => {
  for (const c of mounted) unmount(c);
  mounted = [];
  uninstall?.();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  flushSync();
  await tick();
  flushSync();
}
/** A pause longer than a typing run's: the next keystroke is a new undo step. */
function pause(): void {
  now += GROUP_MS + 2000;
  vi.setSystemTime(now);
}
async function show(props: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const c = mount(Composer, { target: document.body, props });
  mounted.push(c);
  await settle();
  return c;
}
async function hide(c: Record<string, unknown>): Promise<void> {
  mounted = mounted.filter((x) => x !== c);
  await unmount(c);
  await settle();
}
async function chat(id: string): Promise<void> {
  app.activeSessionId = id;
  await settle();
}

/** His typing in a plain field, as WebKit reports it: `beforeinput`, the text, `input`. */
function type(ta: HTMLTextAreaElement, s: string): void {
  ta.focus();
  for (const ch of s) {
    ta.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch }));
    const at = ta.selectionStart;
    ta.value = ta.value.slice(0, at) + ch + ta.value.slice(ta.selectionEnd);
    ta.selectionStart = ta.selectionEnd = at + 1;
    ta.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
  }
  flushSync();
}
const plainBox = () => document.querySelector("textarea[data-own-undo]") as HTMLTextAreaElement;
/** ⌘Z / ⇧⌘Z as a key in the box (the route off the Mac, and the Mac's when the menu does not take it). */
function chord(el: Element, redo = false): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: redo ? "Z" : "z", code: "KeyZ", keyCode: 90, metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }));
}
/** The Mac's route: the Edit menu takes ⌘Z and hands the app `undo_app` / `redo_app`. */
function menu(redo = false): void {
  runMenuCommand(redo ? "redo_app" : "undo_app");
}

const cm = (within: ParentNode = document) => {
  const dom = within.querySelector(".cm-editor") as HTMLElement | null;
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("no formatted box on the page");
  return view;
};
/** His typing in a formatted box: one CodeMirror typing transaction per run. */
function typeLive(text: string, within: ParentNode = document): void {
  const view = cm(within);
  view.focus();
  const at = view.state.selection.main.head;
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
  flushSync();
}

describe("934: the plain message box keeps each chat's undo history across a chat switch", () => {
  for (const route of ["key", "menu"] as const) {
    it(`A → B → A, then ⌘Z restores the earlier text and ⇧⌘Z redoes (by the ${route})`, async () => {
      await show();
      const step = (redo = false) => (route === "key" ? chord(plainBox(), redo) : (plainBox().focus(), menu(redo)));
      type(plainBox(), "first");
      pause();
      type(plainBox(), " second");
      expect(readDraft("chat-A").text).toBe("first second");

      await chat("chat-B");
      expect(plainBox().value).toBe("");
      type(plainBox(), "other chat");
      await chat("chat-A");
      expect(plainBox().value).toBe("first second");

      step();
      await settle();
      expect(readDraft("chat-A").text).toBe("first");
      expect(plainBox().value).toBe("first");
      step(true);
      await settle();
      expect(readDraft("chat-A").text).toBe("first second");
      step();
      step();
      await settle();
      expect(readDraft("chat-A").text).toBe("");
      // Undo in A never touched B's draft, and B's own history is still B's.
      expect(readDraft("chat-B").text).toBe("other chat");
      await chat("chat-B");
      step();
      await settle();
      expect(readDraft("chat-B").text).toBe("");
      expect(readDraft("chat-A").text).toBe("");
    });
  }

  it("and across a tab switch (the box unmounts and a new one mounts)", async () => {
    const c = await show();
    type(plainBox(), "first");
    pause();
    type(plainBox(), " second");
    await hide(c);
    await show();
    chord(plainBox());
    await settle();
    expect(readDraft("chat-A").text).toBe("first");
    chord(plainBox(), true);
    await settle();
    expect(readDraft("chat-A").text).toBe("first second");
  });
});

describe("934: the formatted message box (Format on, his setting) keeps each chat's undo history", () => {
  beforeEach(() => {
    composerFormat.on = true;
  });

  for (const route of ["key", "menu"] as const) {
    it(`A → B → A, then ⌘Z restores the earlier text and ⇧⌘Z redoes (by the ${route})`, async () => {
      await show();
      expect(document.querySelector("textarea[data-own-undo]")).toBeNull();
      const step = (redo = false) => {
        cm().focus();
        if (route === "key") chord(cm().contentDOM, redo);
        else menu(redo);
        flushSync();
      };
      typeLive("first");
      pause();
      typeLive(" second");
      expect(readDraft("chat-A").text).toBe("first second");

      await chat("chat-B");
      expect(cm().state.doc.toString()).toBe("");
      // B starts with nothing to undo: A's history did not come along.
      step();
      await settle();
      expect(readDraft("chat-B").text).toBe("");
      typeLive("other chat");
      await chat("chat-A");
      expect(cm().state.doc.toString()).toBe("first second");

      step();
      await settle();
      expect(readDraft("chat-A").text).toBe("first");
      expect(cm().state.doc.toString()).toBe("first");
      step(true);
      await settle();
      expect(readDraft("chat-A").text).toBe("first second");
      step();
      step();
      await settle();
      expect(readDraft("chat-A").text).toBe("");
      expect(readDraft("chat-B").text).toBe("other chat");
      await chat("chat-B");
      step();
      await settle();
      expect(readDraft("chat-B").text).toBe("");
      expect(readDraft("chat-A").text).toBe("");
    });
  }

  it("and across a tab switch (the box unmounts and a new one mounts)", async () => {
    const c = await show();
    typeLive("first");
    pause();
    typeLive(" second");
    await hide(c);
    await show();
    cm().focus();
    menu();
    await settle();
    expect(readDraft("chat-A").text).toBe("first");
    menu(true);
    await settle();
    expect(readDraft("chat-A").text).toBe("first second");
  });

  it("a draft that changed while its box was away starts a fresh history, never one for another text", async () => {
    await show();
    typeLive("first");
    await chat("chat-B");
    readDraft("chat-A").text = "set elsewhere";
    await chat("chat-A");
    expect(cm().state.doc.toString()).toBe("set elsewhere");
    cm().focus();
    menu();
    await settle();
    expect(readDraft("chat-A").text).toBe("set elsewhere");
  });
});

describe("934: an aside's box keeps its own history (the same Composer, the thread's key)", () => {
  const thread = (id: number) => ({ id, uid: `uid-${id}`, quote: null, draft: false, anchor: null, turns: [] }) as never;
  for (const format of [false, true]) {
    it(`the chat's box → the aside's → the chat's, ${format ? "formatted" : "plain"}`, async () => {
      composerFormat.on = format;
      const a = thread(7);
      app.asides = [a];
      const typeIn = (s: string) => (format ? typeLive(s) : type(plainBox(), s));
      const undo = () => {
        if (format) {
          cm().focus();
          menu();
        } else chord(plainBox());
      };
      let c = await show();
      typeIn("chat words");
      pause();
      typeIn(" more");
      await hide(c);
      c = await show({ aside: a, takeFocus: true });
      typeIn("aside words");
      pause();
      typeIn(" more");
      await hide(c);
      c = await show();
      undo();
      await settle();
      expect(readDraft("chat-A").text).toBe("chat words");
      expect(readDraft(asideDraftKey(a)).text).toBe("aside words more");
      await hide(c);
      await show({ aside: a, takeFocus: true });
      undo();
      await settle();
      expect(readDraft(asideDraftKey(a)).text).toBe("aside words");
      expect(readDraft("chat-A").text).toBe("chat words");
    });
  }
});

describe("934: a formatted box alone (LiveBox — the composer's and the edit box's)", () => {
  it("keeps a history per `historyKey` across a key change and a remount; none without a key", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const props = { value: "" };
    let c = mount(LiveBox, { target: host, props: { value: "", historyKey: "edit:chat-A:3", onchange: (v: string) => (props.value = v) } });
    await settle();
    typeLive("first", host);
    pause();
    typeLive(" second", host);
    await unmount(c);
    c = mount(LiveBox, { target: host, props: { value: "first second", historyKey: "edit:chat-A:3", onchange: (v: string) => (props.value = v) } });
    await settle();
    cm(host).focus();
    menu();
    await settle();
    expect(props.value).toBe("first");
    await unmount(c);
    // No key: a fresh history, as before 934.
    c = mount(LiveBox, { target: host, props: { value: "first", onchange: (v: string) => (props.value = v) } });
    await settle();
    cm(host).focus();
    menu();
    await settle();
    expect(props.value).toBe("first");
    await unmount(c);
  });

  it("the edit box is given its chat's and message's key, in both layouts", async () => {
    for (const p of ["./Transcript.svelte", "./TranscriptClassic.svelte"]) expect(await src(p)).toContain("historyKey={T.editHistoryKey}");
    const logic = await src("./transcript/logic.svelte.ts");
    expect(logic).toContain("return editing ? `edit:${sessionKey}:${editing.index}` : null;");
    // The plain edit box's history goes into the stash with the editor and comes back with it.
    expect(logic).toContain("hist: editHist");
    expect(logic.match(/takeEditHist\(back\);/g)?.length).toBe(2);
  });
});

describe("934: a note's editor keeps its buffer's history when it remounts", () => {
  it("unmount, mount on the same buffer, ⌘Z still undoes; another buffer's history is its own", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    let text = "";
    const open = (key: string, value: string) =>
      mount(NoteEditor, {
        target: host,
        props: {
          get value() {
            return value;
          },
          set value(v: string) {
            value = v;
            text = v;
          },
          historyKey: key,
        },
      });
    let c = open("note:project:a.md", "");
    await settle();
    typeLive("first", host);
    pause();
    typeLive(" second", host);
    expect(text).toBe("first second");
    await unmount(c);
    c = open("note:project:b.md", "first second");
    await settle();
    cm(host).focus();
    menu();
    await settle();
    // b.md holds the same words but none of a.md's history.
    expect(cm(host).state.doc.toString()).toBe("first second");
    await unmount(c);
    c = open("note:project:a.md", "first second");
    await settle();
    cm(host).focus();
    menu();
    await settle();
    expect(cm(host).state.doc.toString()).toBe("first");
    menu(true);
    await settle();
    expect(cm(host).state.doc.toString()).toBe("first second");
    await unmount(c);
    expect(await src("./NoteView.svelte")).toContain("historyKey={bufferKey === null ? null : `note:${bufferKey}`}");
  });
});

describe("934: a plain field with a kept draft (`data-undo-key`: the comment box, a Needs-you reply)", () => {
  function field(key: string | null, value: string): HTMLTextAreaElement {
    const ta = document.body.appendChild(document.createElement("textarea"));
    if (key) ta.setAttribute("data-undo-key", key);
    ta.value = value;
    return ta;
  }

  it("the history is the draft's: a new element on the same key undoes what the old one typed", async () => {
    let ta = field("needs:row-1", "");
    type(ta, "first");
    pause();
    type(ta, " second");
    ta.remove();
    ta = field("needs:row-1", "first second");
    ta.focus();
    menu();
    expect(ta.value).toBe("first");
    menu(true);
    expect(ta.value).toBe("first second");
    // Without a key the history is the element's, as before: a new element has none.
    let bare = field(null, "");
    type(bare, "typed");
    bare.remove();
    bare = field(null, "typed");
    bare.focus();
    menu();
    expect(bare.value).toBe("typed");
  });

  it("one element shown for two drafts in turn keeps two histories (the comment box)", async () => {
    const ta = field("comment:chat-A:1", "");
    type(ta, "on passage one");
    // The same element, now the next comment's (Svelte reuses it).
    ta.setAttribute("data-undo-key", "comment:chat-A:2");
    ta.value = "";
    type(ta, "on passage two");
    menu();
    expect(ta.value).toBe("");
    menu();
    // Never the other comment's words.
    expect(ta.value).toBe("");
    ta.setAttribute("data-undo-key", "comment:chat-A:1");
    ta.value = "on passage one";
    menu();
    expect(ta.value).toBe("");
    menu(true);
    expect(ta.value).toBe("on passage one");
  });

  it("the comment box and the Needs-you reply name their drafts", async () => {
    expect(await src("./Composer.svelte")).toContain("data-undo-key={`comment:${key}:${oc.id}`}");
    expect(await src("./NeedsYou.svelte")).toContain("data-undo-key={`needs:${row.id}`}");
  });
});
