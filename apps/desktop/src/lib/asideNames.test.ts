import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASIDE_NAME_MAX, asideLabel, cleanAsideName, loadAsides, serializeAsides } from "./asides";
import { answerAsideDiscard, app, setAsideUnsent, switchAside } from "./state.svelte";
import type { Aside } from "./state.svelte";
import { renameAside } from "./asides.svelte";
import { pastAsides, pastOf, renamePast, reopenPast } from "./asideHistory.svelte";
import { asideTabName, asidesListedOf, closeAsideToChat } from "./asideSidebar.svelte";
import * as tabs from "./tabs";

/**
 * Items 265 (an aside can be named; the name survives a relaunch and a
 * close-and-reopen, and shows where the aside is named) and 266 (Close on
 * the aside's tab moves it to the chat's Past list and goes back to the
 * chat).
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  cancelAside: vi.fn(async () => null),
}));

const answered = (id: number, question = "why"): Aside => ({
  id,
  quote: { text: `passage ${id}`, role: "assistant", ordinal: id },
  draft: false,
  turns: [{ seq: id, question, partial: "because", answer: "because", error: null, cancelled: false, cacheRead: 0 }],
  anchor: null,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("an aside's name (item 265)", () => {
  it("is kept one line, trimmed and capped; blank is no name", () => {
    expect(cleanAsideName("  the  cache\nquestion ")).toBe("the cache question");
    expect(cleanAsideName("   ")).toBeNull();
    expect(cleanAsideName(3)).toBeNull();
    expect(cleanAsideName("x".repeat(200))!.length).toBe(ASIDE_NAME_MAX);
  });

  it("labels a thread by its name, else its first question, else its passage", () => {
    const a = answered(1, "what does the cache hold?");
    expect(asideLabel(a)).toBe("what does the cache hold?");
    expect(asideLabel({ ...a, name: "Cache" })).toBe("Cache");
    expect(asideLabel({ ...a, turns: [] })).toBe("passage 1");
    expect(asideLabel({ ...a, turns: [], quote: null })).toBe("Aside");
  });

  it("is written with the thread and read back after a relaunch", () => {
    const map = new Map<string, Aside[]>([["c", [{ ...answered(1), name: "Cache" }, answered(2)]]]);
    const back = loadAsides({ getItem: () => serializeAsides(map) }).get("c")!;
    expect(back.map((a) => a.name)).toEqual(["Cache", undefined]);
  });

  it("is kept on a draft kept for its unsent text", () => {
    const d: Aside = { id: 5, quote: null, draft: true, turns: [], anchor: null, unsent: "half", name: "Draft one" };
    const back = loadAsides({ getItem: () => serializeAsides(new Map([["c", [d]]])) }).get("c")!;
    expect(back[0]!.name).toBe("Draft one");
  });
});

describe("renaming, closing into Past, reopening (items 265, 266)", () => {
  beforeEach(() => {
    switchAside(null);
    app.activeSessionId = null;
    app.asideDiscard = null;
    for (const k of Object.keys(pastAsides.byChat)) delete pastAsides.byChat[k];
    app.connection = { engine: "claude-code" } as typeof app.connection;
  });

  it("a rename shows on the thread, its tab, and survives a close to Past and a reopen", () => {
    app.activeSessionId = "chat-n1";
    app.asides = [answered(11)];
    const a = app.asides[0]!;
    renameAside(a, "  Cache  question ");
    expect(a.name).toBe("Cache question");
    expect(asideTabName("chat-n1", 11)).toBe("Cache question");
    renameAside(a, "   ");
    expect(a.name).toBeUndefined();
    expect(asideTabName("chat-n1", 11)).toBeNull();
    renameAside(a, "Cache");

    closeAsideToChat("chat-n1", a);
    expect(app.asides.length).toBe(0);
    const past = pastOf("chat-n1");
    expect(past[0]!.thread.name).toBe("Cache");

    renamePast("chat-n1", past[0]!.key, "Cache, again");
    const back = reopenPast(past[0]!.key)!;
    expect(back.name).toBe("Cache, again");
  });

  it("lists a stashed chat's threads, and not an empty draft", () => {
    app.activeSessionId = "chat-n2";
    app.asides = [answered(21), { id: 22, quote: null, draft: true, turns: [], anchor: null }];
    expect(asidesListedOf("chat-n2").map((a) => a.id)).toEqual([21]);
    switchAside("chat-other");
    app.activeSessionId = "chat-other";
    expect(asidesListedOf("chat-n2").map((a) => a.id)).toEqual([21]);
  });
});

describe("Close on the aside's tab (item 266)", () => {
  beforeEach(() => {
    switchAside(null);
    app.activeSessionId = null;
    app.asideDiscard = null;
    for (const k of Object.keys(pastAsides.byChat)) delete pastAsides.byChat[k];
    app.connection = { engine: "claude-code" } as typeof app.connection;
    app.view = "chat";
  });

  it("moves the thread to Past, closes the aside's tab and brings the chat's tab to the front", async () => {
    app.activeSessionId = "chat-t1";
    app.asides = [answered(31)];
    const chat = tabs.makeTab({ kind: "chat", session: "chat-t1" });
    const side = tabs.makeTab({ kind: "aside", session: "chat-t1", thread: 31 });
    const pane = tabs.makePane([chat, side]);
    pane.active = side.id;
    app.tabs = { panes: [pane], focused: pane.id };

    closeAsideToChat("chat-t1", app.asides[0]!, side.id);
    await settle();
    expect(pastOf("chat-t1").length).toBe(1);
    const p = app.tabs.panes[0]!;
    expect(p.tabs.map((t) => t.content.kind)).toEqual(["chat"]);
    expect(p.active).toBe(chat.id);
  });

  it("with no tab of the chat open, the aside's tab becomes the chat's", async () => {
    app.activeSessionId = "chat-t2";
    app.asides = [answered(41)];
    const side = tabs.makeTab({ kind: "aside", session: "chat-t2", thread: 41 });
    const pane = tabs.makePane([side]);
    app.tabs = { panes: [pane], focused: pane.id };

    closeAsideToChat("chat-t2", app.asides[0]!, side.id);
    await settle();
    expect(pastOf("chat-t2").length).toBe(1);
    expect(app.tabs.panes[0]!.tabs.map((t) => t.content)).toEqual([{ kind: "chat", session: "chat-t2" }]);
  });

  it("with unsent text it asks first; Discard then closes and goes back, Keep leaves both", async () => {
    app.activeSessionId = "chat-t3";
    app.asides = [answered(51), answered(52)];
    const chat = tabs.makeTab({ kind: "chat", session: "chat-t3" });
    const s1 = tabs.makeTab({ kind: "aside", session: "chat-t3", thread: 51 });
    const s2 = tabs.makeTab({ kind: "aside", session: "chat-t3", thread: 52 });
    const pane = tabs.makePane([chat, s1, s2]);
    pane.active = s1.id;
    app.tabs = { panes: [pane], focused: pane.id };

    setAsideUnsent(app.asides[0]!, "half a follow-up");
    closeAsideToChat("chat-t3", app.asides[0]!, s1.id);
    expect(app.asideDiscard?.id).toBe(51);
    answerAsideDiscard(false);
    await settle();
    expect(app.asides.map((a) => a.id)).toEqual([51, 52]);
    expect(app.tabs.panes[0]!.active).toBe(s1.id);

    closeAsideToChat("chat-t3", app.asides[0]!, s1.id);
    answerAsideDiscard(true);
    await settle();
    expect(app.asides.map((a) => a.id)).toEqual([52]);
    expect(app.tabs.panes[0]!.tabs.map((t) => t.id)).toEqual([chat.id, s2.id]);
    expect(app.tabs.panes[0]!.active).toBe(chat.id);
  });
});
