import { beforeEach, describe, expect, it } from "vitest";
import { backgroundAskToast, backgroundEndToast, canDetach, eventHost } from "./browse";
import { app, applyTurnEvent } from "./state.svelte";
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
