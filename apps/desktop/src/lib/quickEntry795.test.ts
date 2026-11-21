import { describe, expect, it } from "vitest";
import {
  KEYS,
  loadDraft,
  openingProject,
  openingTarget,
  readContext,
  recordShortcut,
  remember,
  restoreDraft,
  saveDraft,
  sendOf,
  shortcutLabel,
  targetName,
  writeContext,
  type QuickContext,
} from "./quickEntry";

function store(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

const key = (code: string, k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const ctx: QuickContext = {
  chat: { id: "c1", title: "Tab drag bug" },
  project: { id: "p1", name: "Nightloom" },
  projects: [
    { id: "p1", name: "Nightloom" },
    { id: "p2", name: "Nightshift" },
  ],
};

describe("795 Quick Entry: the recorder", () => {
  it("records modifiers in the Rust parser's form, by physical key", () => {
    expect(recordShortcut(key("Space", " ", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+Space");
    expect(recordShortcut(key("KeyK", "K", { metaKey: true, shiftKey: true }))).toBe("Shift+Cmd+KeyK");
    expect(recordShortcut(key("Digit1", "¡", { altKey: true }))).toBe("Alt+Digit1");
  });
  it("waits while only modifiers are down and refuses Shift alone or an unknown key", () => {
    expect(recordShortcut(key("AltLeft", "Alt", { altKey: true }))).toBeNull();
    expect(recordShortcut(key("KeyA", "A", { shiftKey: true }))).toBeNull();
    expect(recordShortcut(key("KeyA", "a"))).toBeNull();
    expect(recordShortcut(key("Enter", "Enter", { metaKey: true }))).toBeNull();
  });
  it("labels in the Mac's order", () => {
    expect(shortcutLabel("Shift+Cmd+KeyK")).toBe("⇧⌘K");
    expect(shortcutLabel("Ctrl+Alt+Space")).toBe("⌃⌥Space");
    expect(shortcutLabel("Alt+Slash")).toBe("⌥/");
    expect(shortcutLabel(null)).toBe("Off");
  });
});

describe("795 Quick Entry: targets and drafts", () => {
  it("round-trips the context and drops malformed parts", () => {
    const s = store();
    writeContext(s, ctx);
    expect(readContext(s)).toEqual(ctx);
    s.setItem(KEYS.context, JSON.stringify({ chat: { id: 3 }, projects: [{ id: "x" }, { id: "y", name: "Y" }] }));
    expect(readContext(s)).toEqual({ chat: null, project: null, projects: [{ id: "y", name: "Y" }] });
    s.setItem(KEYS.context, "{not json");
    expect(readContext(s).chat).toBeNull();
  });
  it("opens on the last target used, falling back to a new chat with no chat on record", () => {
    const s = store();
    expect(openingTarget(s, ctx)).toBe("last");
    remember(s, "aside", null);
    expect(openingTarget(s, ctx)).toBe("aside");
    expect(openingTarget(s, { ...ctx, chat: null })).toBe("new");
    remember(s, "new", "p2");
    expect(openingTarget(s, ctx)).toBe("new");
    expect(openingProject(s, ctx)).toBe("p2");
    expect(openingProject(s, { ...ctx, projects: [ctx.projects[0]] })).toBe("p1");
  });
  it("keeps a draft until a send, and puts a refused send back after what was typed since", () => {
    const s = store();
    saveDraft(s, "half a thought");
    expect(loadDraft(s)).toBe("half a thought");
    saveDraft(s, "");
    expect(s.getItem(KEYS.draft)).toBeNull();
    restoreDraft(s, "the refused words");
    expect(loadDraft(s)).toBe("the refused words");
    saveDraft(s, "new words");
    restoreDraft(s, "refused again");
    expect(loadDraft(s)).toBe("new words\n\nrefused again");
  });
  it("builds the send for each target, naming the chat it opened on", () => {
    expect(sendOf("last", "  hi  ", ctx, "p2")).toEqual({ target: "last", text: "hi", project: "p1", chat: "c1" });
    expect(sendOf("aside", "why?", ctx, null)).toEqual({ target: "aside", text: "why?", project: "p1", chat: "c1" });
    expect(sendOf("new", "start", ctx, "p2")).toEqual({ target: "new", text: "start", project: "p2", chat: null });
    expect(sendOf("last", "   ", ctx, null)).toBe("type something first");
    expect(typeof sendOf("aside", "x", { ...ctx, chat: null }, null)).toBe("string");
  });
  it("names the targets", () => {
    expect(targetName("last", ctx)).toBe("To: Tab drag bug");
    expect(targetName("aside", ctx)).toBe("Aside on: Tab drag bug");
    expect(targetName("new", ctx)).toBe("New chat");
  });
});
