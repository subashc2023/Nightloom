import { describe, expect, it } from "vitest";
import { keptPaneLogs, liveHost, paneChatOf, paneLine, queuedElsewhereToast, settlePlan, type Parked } from "./browse";
import type { SessionEvent } from "./types";

// Browsing while a turn runs (nightshift backlog 159, pass 1): the live
// stream lands with the running chat whether it is on screen or parked;
// the turn's end adopts the log when the chat on screen ran, and
// re-aligns the backend to the chat on screen when he browsed away.
describe("the session-keyed live stream (backlog 159)", () => {
  const parked: Parked = {
    session: "running",
    pendingMode: "normal",
    pendingKind: "build",
    events: [],
    live: { segments: [] },
    liveUsage: null,
  };

  it("lands a stream event on the parked chat while another is on screen", () => {
    const app = { parked, live: null as { segments: unknown[] } | null, liveUsage: null };
    expect(liveHost(app)).toBe(parked);
    const open = { parked: null, live: { segments: [] }, liveUsage: null };
    expect(liveHost(open)).toBe(open);
  });
});

describe("the turn's end (backlog 159)", () => {
  const parkedRunning: Parked = { session: "running", pendingMode: "normal", pendingKind: "build", events: [], live: null, liveUsage: null };
  const parkedPending: Parked = { ...parkedRunning, session: null };

  it("adopts the log when the chat on screen ran, and follows the pending chat to the id it made", () => {
    expect(settlePlan({ parked: null, viewed: "a", made: "a", pendingKey: null })).toEqual({
      adopt: true,
      activeSessionId: "a",
      moveDraft: null,
      realign: null,
    });
    expect(settlePlan({ parked: null, viewed: null, made: "b", pendingKey: "new:p:normal" })).toEqual({
      adopt: true,
      activeSessionId: "b",
      moveDraft: ["new:p:normal", "b"],
      realign: null,
    });
    expect(settlePlan({ parked: null, viewed: null, made: null, pendingKey: "new:p:normal" }).moveDraft).toBeNull();
  });

  it("leaves the running chat's record on disk and re-opens the chat on screen when he browsed away", () => {
    expect(settlePlan({ parked: parkedRunning, viewed: "other", made: "running", pendingKey: null })).toEqual({
      adopt: false,
      activeSessionId: undefined,
      moveDraft: null,
      realign: { kind: "open", id: "other" },
    });
    // New chat on screen: the backend is told New chat.
    expect(settlePlan({ parked: parkedRunning, viewed: null, made: "running", pendingKey: null }).realign).toEqual({ kind: "new" });
  });

  it("moves the pending chat's queue to the chat its first turn made even while he is elsewhere", () => {
    const plan = settlePlan({ parked: parkedPending, viewed: "other", made: "made", pendingKey: "new:p:normal" });
    expect(plan.moveDraft).toEqual(["new:p:normal", "made"]);
    expect(plan.adopt).toBe(false);
    expect(plan.realign).toEqual({ kind: "open", id: "other" });
  });

  it("says where the turn is when a message queues elsewhere", () => {
    expect(queuedElsewhereToast("the paper scan")).toBe("A turn is running in the paper scan — this sends when that ends");
  });
});

// The state's own appender (nightshift backlog 159): with the running
// chat parked, a text delta lands in the parked stream and the chat on
// screen shows nothing live.
import { app, applyTurnEvent } from "./state.svelte";

describe("applyTurnEvent with a chat parked (backlog 159)", () => {
  it("appends to the parked live state, not the screen's", () => {
    app.live = null;
    app.liveUsage = null;
    app.parked = {
      session: "running",
      pendingMode: "normal",
      pendingKind: "build",
      events: [],
      live: { segments: [] },
      liveUsage: null,
    };
    applyTurnEvent({ type: "text_delta", text: "hello" });
    applyTurnEvent({ type: "usage", usage: { input_tokens: 5, output_tokens: 1 } });
    expect(app.live).toBeNull();
    expect(app.parked.live?.segments).toHaveLength(1);
    expect(app.parked.liveUsage).toEqual({ input_tokens: 5, output_tokens: 1 });
    app.parked = null;
  });
});

// Both panes live (backlog 159, piece 5): a pane draws its chat's live
// state from wherever it is kept.
describe("what a pane draws of its chat (backlog 159, piece 5)", () => {
  const msg = (text: string): SessionEvent => ({ event: "user_message", at: "2026-09-30T00:00:00Z", text }) as SessionEvent;
  type A = { id: string; chat?: string | null };
  const base = () => ({
    activeSessionId: "open" as string | null,
    events: [msg("open's")],
    live: { segments: ["open live"] } as { segments: string[] } | null,
    liveUsage: null,
    busy: true,
    parked: null as Parked<string> | null,
    background: {
      off: {
        session: "off",
        pendingMode: "normal" as const,
        pendingKind: "build" as const,
        events: [msg("off's")],
        live: { segments: ["off live"] },
        liveUsage: { input_tokens: 1, output_tokens: 2 },
        approvals: [{ id: "p1", chat: "off" }] as A[],
      },
    },
    pendingApprovals: [{ id: "p0" }] as A[],
    budgetSession: null,
    turnBudget: null,
    paneLogs: { idle: [msg("idle's")] } as Record<string, SessionEvent[]>,
  });

  it("finds each chat's state: off screen, on screen, idle, or not read yet", () => {
    const app = base();
    expect(paneChatOf(app, "off")).toMatchObject({ where: "background", running: true, live: { segments: ["off live"] } });
    expect(paneChatOf(app, "off")?.approvals).toEqual([{ id: "p1", chat: "off" }]);
    expect(paneChatOf(app, "open")).toMatchObject({ where: "screen", running: true, live: { segments: ["open live"] } });
    expect(paneChatOf(app, "idle")).toMatchObject({ where: "idle", running: false, live: null, approvals: [] });
    expect(paneChatOf(app, "unread")).toBeNull();
  });

  it("draws a parked turn from the parked record, the chat on screen as idle", () => {
    const app = base();
    app.parked = {
      session: "ran",
      pendingMode: "normal",
      pendingKind: "build",
      events: [msg("ran's")],
      live: { segments: ["parked live"] },
      liveUsage: null,
    };
    app.live = null;
    expect(paneChatOf(app, "ran")).toMatchObject({ where: "parked", running: true, live: { segments: ["parked live"] } });
    expect(paneChatOf(app, "open")).toMatchObject({ where: "screen", running: false });
  });

  it("keeps only the logs of the chats a pane shows", () => {
    const logs = { a: [msg("a")], b: [msg("b")] };
    expect(Object.keys(keptPaneLogs(logs, ["b", "c"]))).toEqual(["b"]);
  });

  it("says what the pane's chat is doing, and that a click types there", () => {
    expect(paneLine({ running: true, approvals: [], tokens: 1234 })).toBe("Running · 1,234 tokens · click to type here");
    expect(paneLine({ running: true, approvals: [], tokens: 10, budget: "40% of $2" })).toBe(
      "Running · 10 tokens · 40% of $2 · click to type here",
    );
    expect(paneLine({ running: true, approvals: [{}], tokens: null })).toContain("Waiting on you — a prompt");
    expect(paneLine({ running: false, approvals: [], tokens: null })).toBe("Not the open chat · click to type here");
  });
});
