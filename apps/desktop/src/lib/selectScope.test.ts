// Item 646: chrome cannot be selected, content can; ⌘A selects the pane he is in.
import { describe, expect, it } from "vitest";
import { installSelectScope, isField, selectScope } from "./selectScope";
import mainSrc from "../main.ts?raw";
// vitest empties CSS imports (codeCopy.test.ts), so the rules are read from disk; the module name is built so the
// type check (no Node types in this app) does not resolve it.
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const appCss = fs.readFileSync(new URL("../app.css", import.meta.url), "utf8");

/** The item's section of app.css: from its heading to the end of the file. */
const section = appCss.slice(appCss.lastIndexOf("/*", appCss.indexOf("---- what can be selected (item 646)")));

/** The selector list of the first rule in `css` whose body sets user-select to `value`, after `from`. */
function selectorsFor(css: string, value: "none" | "text", from = 0): string[] {
  const rx = new RegExp(`([^{}]+)\\{\\s*-webkit-user-select: ${value};\\s*user-select: ${value};\\s*\\}`, "g");
  rx.lastIndex = from;
  const out: string[] = [];
  for (let m = rx.exec(css); m; m = rx.exec(css)) {
    out.push(
      ...m[1]
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return out;
}

describe("app.css: what can be selected", () => {
  it("has the section, after every other rule", () => {
    expect(appCss).toContain("---- what can be selected (item 646)");
    expect(section.length).toBeGreaterThan(0);
  });
  it("makes the body (so all chrome) unselectable", () => {
    expect(selectorsFor(section, "none")).toContain("body");
  });
  it("lets content opt back in: messages, code, Markdown, fields, editors, errors", () => {
    const text = selectorsFor(section, "text");
    for (const s of [
      "input",
      "textarea",
      '[contenteditable]:not([contenteditable="false"])',
      ".cm-editor",
      "pre",
      "code",
      ".markdown",
      ".transcript",
      ".aside-thread",
      ".assistant",
      ".user-bubble",
      ".error-banner",
      ".toast-text",
    ])
      expect(text).toContain(s);
  });
  it("takes chrome inside content back out: buttons, tabs, menu items, a turn's tools", () => {
    const none = selectorsFor(section, "none");
    for (const s of ["button", '[role="tab"]', '[role="menuitem"]', ".turn-tools"]) expect(none).toContain(s);
  });
  it("is not gated by layout (Classic too)", () => {
    expect(section).not.toMatch(/data-layout/);
  });
  it("never lets the new-chat screen's pieces opt in", () => {
    const text = selectorsFor(section, "text").join(" ");
    for (const s of ["welcome", "dial", "mode", "thread-list"]) expect(text).not.toContain(s);
  });
});

// ---- a little fake DOM: enough for closest() over class and attribute selectors ----

type Fake = {
  tagName: string;
  nodeType: 1;
  cls: string[];
  attrs: Record<string, string>;
  parentElement: Fake | null;
  isConnected: boolean;
  closest(sel: string): Fake | null;
  getAttribute(n: string): string | null;
};

function matches(el: Fake, one: string): boolean {
  const s = one.trim();
  const neg = /^(.*):not\((.*)\)$/.exec(s);
  if (neg) return matches(el, neg[1]) && !matches(el, neg[2]);
  if (s.startsWith(".")) return el.cls.includes(s.slice(1));
  const a = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
  if (a) return a[2] === undefined ? a[1] in el.attrs : el.attrs[a[1]] === a[2];
  return el.tagName === s.toUpperCase();
}

function el(tag: string, cls: string[] = [], parent: Fake | null = null, attrs: Record<string, string> = {}): Fake {
  const me: Fake = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    cls,
    attrs,
    parentElement: parent,
    isConnected: true,
    closest(sel) {
      for (let n: Fake | null = me; n; n = n.parentElement) if (sel.split(",").some((p) => matches(n!, p))) return n;
      return null;
    },
    getAttribute: (n) => attrs[n] ?? null,
  };
  return me;
}

// The app's shape: a pane's tab content holding a chat (a transcript and its composer), the sidebar beside it.
const shell = el("div", ["shell"]);
const sidebar = el("aside", ["sidebar"], shell);
const sideRow = el("button", ["row"], sidebar);
const content = el("div", ["content"], shell);
const inner = el("div", ["content"], content); // a component's own `.content` inside the tab's
const transcript = el("div", ["transcript"], content);
const message = el("div", ["assistant"], transcript);
const para = el("p", [], message);
const welcome = el("div", ["welcome"], inner);
const dialLabel = el("span", ["dial-label"], welcome);
const composer = el("textarea", ["box"], content);
const note = el("div", ["cm-content"], content, { contenteditable: "true" });
const readOnly = el("div", ["cm-content"], content, { contenteditable: "false" });
const settings = el("div", ["settings-overlay"], shell);
const settingsLabel = el("label", [], settings);

describe("selectScope: what ⌘A selects", () => {
  it("in a chat: the transcript, not the pane", () => {
    expect(selectScope(para as unknown as Element)).toBe(transcript);
  });
  it("on the new-chat screen: the tab's content (whose chrome paints nothing), never a nested .content", () => {
    expect(selectScope(dialLabel as unknown as Element)).toBe(content);
  });
  it("in a dialog or overlay: that", () => {
    expect(selectScope(settingsLabel as unknown as Element)).toBe(settings);
  });
  it("in the sidebar: nothing", () => {
    expect(selectScope(sideRow as unknown as Element)).toBeNull();
    expect(selectScope(null)).toBeNull();
  });
  it("knows a field from chrome", () => {
    expect(isField(composer as unknown as Element)).toBe(true);
    expect(isField(note as unknown as Element)).toBe(true);
    expect(isField(readOnly as unknown as Element)).toBe(false);
    expect(isField(para as unknown as Element)).toBe(false);
  });
});

describe("installSelectScope: the ⌘A handler", () => {
  function rig(active: Fake | null = null) {
    const handlers: Record<string, (e: unknown) => void> = {};
    const calls: { all?: unknown; cleared: number } = { cleared: 0 };
    const selection = {
      anchorNode: null,
      selectAllChildren: (n: unknown) => (calls.all = n),
      removeAllRanges: () => calls.cleared++,
    };
    const win = {
      document: { activeElement: active, body: null, getSelection: () => selection },
      addEventListener: (t: string, f: (e: unknown) => void) => (handlers[t] = f),
      removeEventListener: (t: string) => delete handlers[t],
    };
    const off = installSelectScope(win as unknown as Window);
    const key = (target: Fake | null, mods: Partial<KeyboardEvent> = {}) => {
      let prevented = false;
      handlers.keydown({ key: "a", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target, ...mods, preventDefault: () => (prevented = true) });
      return prevented;
    };
    const down = (target: Fake) => handlers.pointerdown({ target });
    return { calls, key, down, off, handlers };
  }

  it("after a click in a message, ⌘A selects that transcript", () => {
    const r = rig();
    r.down(para);
    expect(r.key(null)).toBe(true);
    expect(r.calls.all).toBe(transcript);
  });
  it("after a click in the sidebar, ⌘A selects nothing (and clears what was selected)", () => {
    const r = rig();
    r.down(sideRow);
    expect(r.key(null)).toBe(true);
    expect(r.calls.all).toBeUndefined();
    expect(r.calls.cleared).toBe(1);
  });
  it("in the composer or a note, ⌘A is the field's own", () => {
    const r = rig(composer);
    r.down(composer);
    expect(r.key(composer)).toBe(false);
    const n = rig(note);
    expect(n.key(note)).toBe(false);
    expect(r.calls.all).toBeUndefined();
  });
  it("leaves ⇧⌘A, ⌥⌘A, ⌃A and other keys alone", () => {
    const r = rig();
    r.down(para);
    expect(r.key(null, { shiftKey: true })).toBe(false);
    expect(r.key(null, { altKey: true })).toBe(false);
    expect(r.key(null, { metaKey: false, ctrlKey: true })).toBe(false);
    expect(r.key(null, { key: "c" })).toBe(false);
  });
  it("uninstalls", () => {
    const r = rig();
    r.off();
    expect(r.handlers.keydown).toBeUndefined();
  });
  it("is installed at startup", () => {
    expect(mainSrc).toMatch(/installSelectScope\(\);/);
  });
});
