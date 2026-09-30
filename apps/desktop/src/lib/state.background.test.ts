import { beforeEach, describe, expect, it } from "vitest";
import { backgroundAskToast, backgroundEndToast, canDetach, eventHost, firstUserText } from "./browse";
import { app, applyTurnEvent, canDeleteChat, chatRuns, liveChats, turnsRunning } from "./state.svelte";
import type { TurnEvent } from "./types";

/**
 * Two live turns (nightshift backlog 159, pass 2 step A2): every event a
 * Claude Code turn sends names its chat, and a chat running off screen
 * keeps its own stream — the chat on screen is never written by it.
 */
const delta = (text: string, chat?: string): TurnEvent & { chat?: string } => ({
  type: "text_delta",
  text,
  ...(chat ? { chat } : {}),
});

function texts(live: { segments: unknown[] } | null): string {
  return (live?.segments ?? [])
    .map((s) => ((s as { kind: string; text?: string }).kind === "text" ? (s as { text: string }).text : ""))
    .join("");
}

describe("the background's routing (pure)", () => {
  it("routes an event to its chat's background, and a chatless one to the screen", () => {
    const bg = { a: 1 };
    expect(eventHost(bg, "a")).toBe(1);
    expect(eventHost(bg, "b")).toBeNull();
    expect(eventHost(bg, undefined)).toBeNull();
  });

  it("sends only a named Claude Code turn to the background", () => {
    expect(canDetach("claude-code", "a")).toBe(true);
    expect(canDetach("claude-code", null)).toBe(false);
    expect(canDetach("anthropic", "a")).toBe(false);
  });

  it("names the chat in its toasts", () => {
    expect(backgroundEndToast("Stuart 9", null)).toBe("Reply finished in Stuart 9");
    expect(backgroundEndToast("Stuart 9", "boom")).toContain("boom");
    expect(backgroundAskToast("Stuart 9")).toBe("Stuart 9 is waiting on you");
  });
});

describe("two chats streaming at once (state)", () => {
  beforeEach(() => {
    app.parked = null;
    app.live = { segments: [] };
    app.liveUsage = null;
    app.background = {
      a: {
        session: "a",
        pendingMode: "normal",
        pendingKind: "build",
        events: [],
        live: { segments: [] },
        liveUsage: null,
        approvals: [],
      },
    };
  });

  it("lands chat A's stream in A's background and chat B's on screen, interleaved", () => {
    applyTurnEvent(delta("one ", "a"));
    applyTurnEvent(delta("uno ", "b"));
    applyTurnEvent(delta("two", "a"));
    applyTurnEvent(delta("dos", "b"));
    expect(texts(app.background.a.live)).toBe("one two");
    expect(texts(app.live)).toBe("uno dos");
    // The background's detour through the screen's code leaves no trace.
    expect(app.parked).toBeNull();
  });

  it("keeps a background chat's usage off the screen's gauge", () => {
    applyTurnEvent({ type: "usage", usage: { input_tokens: 5, output_tokens: 7 }, chat: "a" } as TurnEvent & {
      chat: string;
    });
    expect(app.background.a.liveUsage).toEqual({ input_tokens: 5, output_tokens: 7 });
    expect(app.liveUsage).toBeNull();
  });

  it("drops a background prompt once its call has an answer", () => {
    app.background.a.approvals = [{ id: "toolu_1", name: "Bash", input: {}, effect: "mutating", chat: "a" }];
    applyTurnEvent({ type: "tool_denied", tool_use_id: "toolu_1", name: "Bash", reason: "no", chat: "a" } as unknown as TurnEvent & {
      chat: string;
    });
    expect(app.background.a.approvals).toHaveLength(0);
  });
});

describe("a chat off screen acts as the screen's does (backlog 159, A4)", () => {
  beforeEach(() => {
    app.busy = false;
    app.parked = null;
    app.live = null;
    app.liveUsage = null;
    app.agentInit = null;
    app.suggestion = null;
    app.pendingApprovals = [];
    app.sessions = [];
    app.background = {
      a: {
        session: "a",
        pendingMode: "ephemeral",
        pendingKind: "build",
        events: [{ event: "user_message", text: "Count to 2500 in Spanish\nplease", at: "2026-09-30T08:00:00Z" }],
        live: { segments: [] },
        liveUsage: { input_tokens: 10, output_tokens: 20 },
        approvals: [],
      },
    };
  });

  it("keeps a background chat's init line in its record, not the screen's", () => {
    const init = { type: "agent_init", model: "claude-haiku-4-5", tools: [], slash_commands: ["/x"], skills: [], chat: "a" };
    applyTurnEvent(init as unknown as TurnEvent & { chat: string });
    expect(app.background.a.agentInit).toMatchObject({ slash_commands: ["/x"] });
    expect(app.agentInit).toBeNull();
  });

  it("leaves the screen's composer suggestion alone", () => {
    applyTurnEvent({ type: "prompt_suggestion", text: "next?", chat: "a" } as unknown as TurnEvent & { chat: string });
    expect(app.suggestion).toBeNull();
  });

  it("answers a background prompt in its own list only", () => {
    app.pendingApprovals = [{ id: "toolu_2", name: "Bash", input: {}, effect: "mutating" }];
    app.background.a.approvals = [{ id: "toolu_1", name: "Bash", input: {}, effect: "mutating", chat: "a" }];
    applyTurnEvent({ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false, chat: "a" } as unknown as TurnEvent & {
      chat: string;
    });
    expect(app.background.a.approvals).toHaveLength(0);
    expect(app.pendingApprovals).toHaveLength(1);
  });

  it("names a chat with no sidebar row by its first message", () => {
    expect(firstUserText(app.background.a.events)).toBe("Count to 2500 in Spanish\nplease");
    expect(firstUserText([])).toBeNull();
    const rows = liveChats();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session: "a", onScreen: false, name: "“Count to 2500 in Spanish”", waiting: 0 });
    expect(rows[0].usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it("counts a turn off screen as a running turn, for that chat only", () => {
    expect(app.busy).toBe(false);
    expect(turnsRunning()).toBe(true);
    expect(chatRuns("a")).toBe(true);
    expect(chatRuns("b")).toBe(false);
    app.background = {};
    expect(turnsRunning()).toBe(false);
  });

  it("lets another chat be deleted while one runs off screen, never the running one (gates audit)", () => {
    expect(canDeleteChat("a")).toBe(false);
    expect(canDeleteChat("b")).toBe(true);
  });

  it("counts a budget stop held for him as waiting on him", () => {
    app.background.a.budget = { pending_since_ms: 1 } as never;
    expect(liveChats()[0].waiting).toBe(1);
  });
});
