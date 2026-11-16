import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, asideOf, dismissAside, switchAside } from "./state.svelte";
import type { Aside } from "./state.svelte";
import { pastAsides, pastOf } from "./asideHistory.svelte";
import { refillAsideTab, reopenIntoTab } from "./asideSidebar.svelte";
import { blankDraft } from "./state/asides.svelte";
import * as tabs from "./tabs";
import viewSrc from "./AsideView.svelte?raw";
import layerSrc from "./AsideLayer.svelte?raw";

/**
 * Item 704 (2026-11-15, his "i jus opened an aside and this shit was
 * empty"): an aside tab on chat e1f2156b drew a blank page — its thread had
 * been closed into the chat's Past list (06:48:27Z) while the tab stayed,
 * and `AsideView`'s no-thread branch drew a dim hint under the Jarvis card
 * and no box. The tab now gets an empty aside of its chat, box and all, and
 * offers the lost thread back.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  cancelAside: vi.fn(async () => null),
}));

const answered = (id: number): Aside => ({
  id,
  uid: `uid-${id}`,
  quote: null,
  draft: false,
  turns: [{ seq: id, question: "why", partial: "because", answer: "because", error: null, cancelled: false, cacheRead: 0 }],
  anchor: null,
});

function asideTab(session: string, thread: number): string {
  const t = tabs.land(app.tabs, tabs.focusedPane(app.tabs), { kind: "aside", session, thread }, "new");
  return t.id;
}
function threadOf(tabId: string): number | undefined {
  const c = tabs.tabById(app.tabs, tabId)!.content;
  return c.kind === "aside" ? c.thread : undefined;
}

describe("704: an aside tab whose thread is gone", () => {
  beforeEach(() => {
    switchAside(null);
    app.activeSessionId = null;
    app.asideDiscard = null;
    for (const k of Object.keys(pastAsides.byChat)) delete pastAsides.byChat[k];
    app.connection = { engine: "claude-code" } as typeof app.connection;
  });

  it("is given an empty aside of its chat, with its box, and can reopen the closed thread", () => {
    app.activeSessionId = "chat-704";
    app.asides = [answered(1)];
    const tab = asideTab("chat-704", 1);
    // Closed by its card's × (not the tab's Close): into Past; the tab stays.
    dismissAside(app.asides[0]!);
    expect(asideOf("chat-704", 1)).toBeNull();
    expect(pastOf("chat-704")).toHaveLength(1);

    const id = refillAsideTab(tab);
    expect(id).not.toBeNull();
    expect(threadOf(tab)).toBe(id);
    const blank = asideOf("chat-704", id)!;
    expect(blank).not.toBeNull();
    expect(blankDraft(blank)).toBe(true);
    // Nothing was missing now: a second call makes no second thread.
    expect(refillAsideTab(tab)).toBeNull();
    expect(app.asides).toHaveLength(1);

    expect(reopenIntoTab(tab, pastOf("chat-704")[0]!.key)).toBe(true);
    const back = asideOf("chat-704", threadOf(tab) ?? null)!;
    expect(back.turns[0]!.answer).toBe("because");
    // The empty one went; the Past entry is open again.
    expect(app.asides).toHaveLength(1);
    expect(pastOf("chat-704")).toHaveLength(0);
  });

  it("a tab of a chat that is not the open one is left alone (an aside forks the open chat)", () => {
    app.activeSessionId = "chat-open";
    const tab = asideTab("chat-other", 7);
    expect(refillAsideTab(tab)).toBeNull();
    expect(threadOf(tab)).toBe(7);
  });

  it("the view: the hint has the card's room under Jarvis, the open chat's tab is refilled, the lost thread is offered", () => {
    const i = viewSrc.indexOf("{#if !aside}");
    const branch = viewSrc.slice(i, viewSrc.indexOf("{:else if classic()}", i));
    expect(branch).toContain("{@render room()}");
    expect(viewSrc).toContain("refillAsideTab(id)");
    expect(viewSrc).toContain("reopenIntoTab(tabId, key)");
    // No card in the transcript for an empty aside once its tab closes.
    expect(layerSrc).toContain("!blankDraft(a)");
  });
});
