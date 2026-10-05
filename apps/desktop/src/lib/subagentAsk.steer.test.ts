import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Steering a running subagent (nightshift backlog 295): a note under a live
 * agent is queued for the hook by the agent's id (its `task_id`), marked
 * delivered — when, and on which call — once the chat's record says so, and
 * a note the agent never reached is taken back and held for when it
 * finishes (backlog 157's path). A note that cannot be queued is held.
 */
const h = vi.hoisted(() => {
  const app = {
    busy: true,
    activeSessionId: "parent" as string | null,
    budgetSession: null as string | null,
    background: {} as Record<string, unknown>,
    parked: null as { session: string } | null,
    connection: { engine: "claude-code" } as unknown,
    subagents: [] as Array<Record<string, unknown>>,
    events: [] as Array<{ event: string; text?: string }>,
    sessions: [] as Array<{ id: string; first_user: string | null }>,
  };
  const record = {
    queued: {} as Record<string, Array<{ id: string; text: string; at_ms: number }>>,
    delivered: [] as Array<Record<string, unknown>>,
  };
  return {
    app,
    record,
    sent: [] as string[],
    steerSubagent: vi.fn(
      async (_s: string, agentId: string, id: string, text: string, _about: string | null, _main: boolean) => {
        (record.queued[agentId] ??= []).push({ id, text, at_ms: 1 });
      },
    ),
    steerState: vi.fn(async () => structuredClone(record)),
    unsteerSubagent: vi.fn(async (_s: string, agentId: string, id: string) => {
      const q = record.queued[agentId] ?? [];
      const i = q.findIndex((n) => n.id === id);
      if (i < 0) return false;
      q.splice(i, 1);
      return true;
    }),
    addToast: vi.fn(),
  };
});

vi.mock("./state.svelte", () => ({
  app: h.app,
  addToast: h.addToast,
  newSession: vi.fn(async () => {
    h.app.activeSessionId = null;
  }),
  openSession: vi.fn(async (id: string) => {
    h.app.activeSessionId = id;
  }),
  renameSession: vi.fn(async () => {}),
  refreshSessions: vi.fn(async () => {}),
  subagentRunning: (r: { status: string }) => r.status === "running",
  send: vi.fn(async (text: string) => {
    h.sent.push(text);
  }),
}));

vi.mock("./api", () => ({
  steerSubagent: h.steerSubagent,
  steerState: h.steerState,
  unsteerSubagent: h.unsteerSubagent,
}));

import { agentAsk, askSubagent, deliverDue, syncSteers, takeBackSteered } from "./subagentAsk.svelte";

function row(status: string, session: string | null = "parent", task_id = "a1") {
  return {
    tool_use_id: "toolu_k",
    task_id,
    subagent_type: "general-purpose",
    description: "Survey",
    prompt: "Look around.",
    status,
    background: false,
    tokens: 0,
    tool_uses: 0,
    duration_ms: 0,
    usage: {},
    rounds: 1,
    session,
    turn: 1,
    startedAt: 0,
    updatedAt: 0,
    segments: [],
  } as never;
}

beforeEach(() => {
  h.sent.length = 0;
  h.app.busy = true;
  h.app.activeSessionId = "parent";
  h.app.budgetSession = null;
  h.app.subagents = [];
  h.record.queued = {};
  h.record.delivered = [];
  agentAsk.notes = {};
  agentAsk.drafts = {};
  agentAsk.adopted = {};
  agentAsk.steered = {};
  agentAsk.tellMain = false;
  vi.clearAllMocks();
});

describe("steering a running agent", () => {
  it("queues the note for the agent's id in its chat, holds nothing, sends no turn", async () => {
    const r = row("running");
    h.app.subagents = [r];
    agentAsk.tellMain = true;
    expect(await askSubagent(r, "also check the docs")).toBe("steered");
    expect(h.steerSubagent).toHaveBeenCalledTimes(1);
    const [session, agentId, , text, about, main] = h.steerSubagent.mock.calls[0];
    expect([session, agentId, text, about, main]).toEqual(["parent", "a1", "also check the docs", "Survey", true]);
    expect(agentAsk.notes["toolu_k"]).toBeUndefined();
    expect(agentAsk.steered["toolu_k"].map((n) => n.text)).toEqual(["also check the docs"]);
    expect(h.sent).toEqual([]);
  });

  it("marks the note delivered, with the time and the call, once the record says so", async () => {
    const r = row("running");
    h.app.subagents = [r];
    await askSubagent(r, "also check the docs");
    const id = agentAsk.steered["toolu_k"][0].id;
    h.record.queued = {};
    h.record.delivered = [
      { id, agent_id: "a1", text: "also check the docs", at_ms: 1, delivered_at_ms: 1_700_000_000_000, tool: "Read", tool_use_id: "toolu_r" },
    ];
    await syncSteers();
    const n = agentAsk.steered["toolu_k"][0];
    expect(n.deliveredAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect([n.tool, n.toolUseId]).toEqual(["Read", "toolu_r"]);
  });

  it("a note the agent never reached is taken back when it finishes and goes as the first question", async () => {
    const r = row("running");
    h.app.subagents = [r];
    await askSubagent(r, "also check the docs");
    (r as { status: string }).status = "completed";
    h.app.busy = false;
    await deliverDue();
    expect(h.unsteerSubagent).toHaveBeenCalledTimes(1);
    expect(h.record.queued["a1"]).toEqual([]);
    expect(agentAsk.steered["toolu_k"]).toBeUndefined();
    // The held path ran: one turn, carrying the agent's run and the note.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].endsWith("also check the docs")).toBe(true);
  });

  it("is held the old way when it cannot be queued (no chat named yet)", async () => {
    // A New chat's first turn: running, no chat id on the row or the view.
    h.app.activeSessionId = null;
    const r = row("running", null);
    h.app.subagents = [r];
    expect(await askSubagent(r, "focus")).toBe("held");
    expect(h.steerSubagent).not.toHaveBeenCalled();
    expect(agentAsk.notes["toolu_k"].map((n) => n.text)).toEqual(["focus"]);
  });

  it("is held the old way when the queue refuses it, and his words are kept", async () => {
    const r = row("running");
    h.app.subagents = [r];
    h.steerSubagent.mockRejectedValueOnce(new Error("no dir"));
    expect(await askSubagent(r, "focus")).toBe("held");
    expect(agentAsk.steered["toolu_k"]).toBeUndefined();
    expect(agentAsk.notes["toolu_k"].map((n) => n.text)).toEqual(["focus"]);
  });

  it("uses the chat the first turn named when the row has none yet", async () => {
    // A New chat's first turn: running, no chat id on the row or the view.
    h.app.activeSessionId = null;
    const r = row("running", null);
    h.app.subagents = [r];
    h.app.budgetSession = "new-chat";
    expect(await askSubagent(r, "focus")).toBe("steered");
    expect(h.steerSubagent.mock.calls[0][0]).toBe("new-chat");
  });

  it("take back returns an undelivered note to the box, and refuses one already delivered", async () => {
    const r = row("running");
    h.app.subagents = [r];
    await askSubagent(r, "first");
    const id = agentAsk.steered["toolu_k"][0].id;
    expect(await takeBackSteered("toolu_k", id)).toBe(true);
    expect(agentAsk.drafts["toolu_k"]).toBe("first");
    expect(agentAsk.steered["toolu_k"]).toBeUndefined();
    await askSubagent(r, "second");
    const id2 = agentAsk.steered["toolu_k"][0].id;
    h.record.queued = {};
    expect(await takeBackSteered("toolu_k", id2)).toBe(false);
    expect(h.addToast).toHaveBeenCalledWith("That note already reached the agent");
  });
});
