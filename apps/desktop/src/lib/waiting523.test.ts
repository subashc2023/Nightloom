import { beforeEach, describe, expect, it, vi } from "vitest";
import noticesSource from "./WaitingNotices.svelte?raw";
import appSource from "../App.svelte?raw";
import promptSource from "./ApprovalPrompt.svelte?raw";
import playwrightSource from "./PlaywrightCard.svelte?raw";

/*
 * Nightshift item 523 (2026-11-09; his words: "it isn't even shown to me if i'm anywhere else in the app that
 * i have this thing waiting on me. some like popup in the bottom right that doesn't disappear unless i click x
 * that can jump me straight to the question"). The rule is pure (`waitingNotices`); the jump is `openWaiting`.
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { closeWaiting, MAX_SHOWN, noticeText, pruneClosed, setCardVisible, trackCard, waitingIds, waitingNotices, waitingView } = await import("./waitingNotice.svelte");
const { app, openWaiting } = await import("./state.svelte");

const req = (id: string, name = "AskUserQuestion", chat?: string) => ({ id, name, input: {}, effect: "mutating", chat }) as never;
const names: Record<string, string> = { a: "PoC thread", b: "Grant draft", c: "Reading group" };
const nameOf = (chat: string | null) => (chat ? (names[chat] ?? chat) : "the new chat");

function source(over: Partial<Parameters<typeof waitingNotices>[0]> = {}): Parameters<typeof waitingNotices>[0] {
  return { active: "a", pending: [], parked: null, background: {}, visible: waitingView.visible, closed: waitingView.closed, nameOf, ...over };
}

beforeEach(() => {
  for (const k of Object.keys(waitingView.visible)) delete waitingView.visible[k];
  for (const k of Object.keys(waitingView.closed)) delete waitingView.closed[k];
});

describe("523: which chats get a notice", () => {
  it("a chat off screen with a question waiting: one notice, naming it, that opens the chat", () => {
    const s = source({ background: { b: { session: "b", approvals: [req("q1", "AskUserQuestion", "b")] } } });
    const n = waitingNotices(s);
    expect(n).toEqual([{ chat: "b", id: "q1", kind: "question", name: "Grant draft", count: 1, where: "background" }]);
    expect(noticeText(n[0]!)).toEqual({ title: "Grant draft", what: "has a question for you", go: "Open the chat" });
  });

  it("a permission prompt, a plan and a browser prompt each say what waits", () => {
    const kinds = ["Bash", "ExitPlanMode", "mcp__playwright__browser_navigate"].map(
      (name) => noticeText(waitingNotices(source({ background: { b: { session: "b", approvals: [req("x", name, "b")] } } }))[0]!).what,
    );
    expect(kinds).toEqual(["is asking for permission", "has a plan waiting for your approval", "is asking to use the browser"]);
  });

  it("the chat on screen: no notice while any of its card is in view, one once it is scrolled away or behind a page", () => {
    const pending = [req("q1", "AskUserQuestion", "a")];
    // The card is mounted and reports itself in view.
    setCardVisible("q1", true);
    expect(waitingNotices(source({ pending }))).toEqual([]);
    // Scrolled out of the viewport (or the transcript left for a note: the card unmounts and forgets itself).
    setCardVisible("q1", false);
    const n = waitingNotices(source({ pending }));
    expect(n).toEqual([{ chat: "a", id: "q1", kind: "question", name: "PoC thread", count: 1, where: "screen" }]);
    expect(noticeText(n[0]!).go).toBe("Go to it");
  });

  it("a parked turn's prompt is off screen whatever was last seen", () => {
    setCardVisible("q1", true);
    const n = waitingNotices(source({ active: "c", parked: { session: "a" }, pending: [req("q1", "AskUserQuestion", "a")] }));
    expect(n.map((x) => [x.chat, x.where])).toEqual([["a", "parked"]]);
  });

  it("several chats waiting: one notice per chat, stacked; past the cap the rest are counted", () => {
    const background = Object.fromEntries(["b", "c", "d", "e", "f"].map((c) => [c, { session: c, approvals: [req(`q-${c}`, "AskUserQuestion", c)] }]));
    const all = waitingNotices(source({ background }));
    expect(all.map((n) => n.chat)).toEqual(["b", "c", "d", "e", "f"]);
    expect(all.slice(-MAX_SHOWN).length).toBe(4);
    expect(all.length - MAX_SHOWN).toBe(1);
  });
});

describe("523: it stays until he closes it or answers", () => {
  it("× closes it for that prompt only; the chat's next prompt gets a new notice", () => {
    const bg = (id: string) => ({ b: { session: "b", approvals: [req(id, "AskUserQuestion", "b")] } });
    expect(waitingNotices(source({ background: bg("q1") })).length).toBe(1);
    closeWaiting("q1");
    expect(waitingNotices(source({ background: bg("q1") }))).toEqual([]);
    // Nothing else hides it: no timer exists in the module or the component.
    expect(noticesSource).not.toMatch(/setTimeout|setInterval/);
    // Answered, then the same chat asks again.
    pruneClosed(waitingIds(source({ background: bg("q2") })));
    expect(waitingView.closed).toEqual({});
    expect(waitingNotices(source({ background: bg("q2") })).map((n) => n.id)).toEqual(["q2"]);
  });

  it("answered: the prompt leaves the chat's record and the notice with it", () => {
    const background = { b: { session: "b", approvals: [req("q1", "AskUserQuestion", "b")] } };
    expect(waitingNotices(source({ background })).length).toBe(1);
    background.b.approvals = [];
    expect(waitingNotices(source({ background }))).toEqual([]);
  });

  it("a card with no IntersectionObserver (a test's DOM) counts as seen while mounted, and forgets itself on leaving", () => {
    const node = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    const a = trackCard(node, "q9");
    expect(node.dataset.askId).toBe("q9");
    expect(waitingView.visible.q9).toBe(true);
    a.destroy();
    expect(waitingView.visible.q9).toBeUndefined();
  });
});

describe("523: a click jumps straight to the card", () => {
  it("from a note or page in the same chat: back to the transcript, the card scrolled into view and focused", async () => {
    const card = { scrollIntoView: vi.fn(), focus: vi.fn() };
    const asked: string[] = [];
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    vi.stubGlobal("document", {
      querySelector: (sel: string) => {
        asked.push(sel);
        return card;
      },
    });
    app.activeSessionId = "a";
    // A prompt waits only while its turn runs.
    app.busy = true;
    app.parked = null;
    app.view = "note";
    await openWaiting("a", "toolu_q");
    expect(app.view).toBe("chat");
    expect(asked).toEqual(['[data-ask-id="toolu_q"]']);
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(card.focus).toHaveBeenCalledTimes(1);
    app.busy = false;
    vi.unstubAllGlobals();
  });
});

describe("523: where it is drawn", () => {
  it("in the toasts' own corner, under them; every prompt card reports whether it is in view", () => {
    expect(appSource).toMatch(/<div class="toasts">[\s\S]*<WaitingNotices \/>\s*<\/div>/);
    expect((promptSource.match(/use:trackCard=\{req\.id\}/g) ?? []).length).toBe(4);
    expect(playwrightSource).toContain("use:trackCard={req.id}");
    expect(noticesSource).toContain("prefers-reduced-motion: reduce");
    expect(noticesSource).toContain("openWaiting(n.chat, n.id)");
    expect(noticesSource).toContain("closeWaiting(n.id)");
  });
});
