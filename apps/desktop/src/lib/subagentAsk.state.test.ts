import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Talking to a subagent (nightshift backlog 157), the stateful half: a note
 * under a running agent is held and sent nowhere; a finished agent's
 * question goes into a new chat carrying its run, the parent's chat is
 * never sent to, and a second question goes into that same chat, plain.
 */
const h = vi.hoisted(() => {
  const app = {
    busy: false,
    activeSessionId: "parent" as string | null,
    background: {} as Record<string, unknown>,
    parked: null as { session: string } | null,
    connection: { engine: "claude-code" } as unknown,
    subagents: [] as Array<Record<string, unknown>>,
    events: [] as Array<{ event: string; text?: string }>,
    sessions: [] as Array<{ id: string; first_user: string | null }>,
  };
  return {
    app,
    sent: [] as Array<{ chat: string | null; text: string }>,
    newSession: vi.fn(async () => {
      app.activeSessionId = null;
      app.events = [];
    }),
    openSession: vi.fn(async (id: string) => {
      app.activeSessionId = id;
    }),
    renameSession: vi.fn(async () => {}),
    refreshSessions: vi.fn(async () => {}),
    addToast: vi.fn(),
  };
});

vi.mock("./state.svelte", () => ({
  app: h.app,
  addToast: h.addToast,
  newSession: h.newSession,
  openSession: h.openSession,
  renameSession: h.renameSession,
  refreshSessions: h.refreshSessions,
  subagentRunning: (r: { status: string }) => r.status === "running",
  send: vi.fn(async (text: string) => {
    h.sent.push({ chat: h.app.activeSessionId, text });
    // The turn made a chat: the view settles on it, as `settleTurnView` does.
    if (h.app.activeSessionId === null) {
      h.app.activeSessionId = "adopted-1";
      h.app.events = [{ event: "session_created" }, { event: "user_message", text }];
    }
  }),
}));

import { agentAsk, askSubagent, deliverDue } from "./subagentAsk.svelte";

function row(status: string) {
  return {
    tool_use_id: "toolu_k",
    task_id: "a1",
    subagent_type: "general-purpose",
    description: "Memory task",
    prompt: "Remember TEAL.",
    status,
    background: false,
    tokens: 0,
    tool_uses: 0,
    duration_ms: 0,
    usage: {},
    rounds: 1,
    session: "parent",
    turn: 1,
    startedAt: 0,
    updatedAt: 0,
    segments: [{ kind: "text", text: "noted" }],
  } as never;
}

beforeEach(() => {
  h.sent.length = 0;
  h.app.busy = false;
  h.app.activeSessionId = "parent";
  h.app.subagents = [];
  h.app.sessions = [];
  agentAsk.notes = {};
  agentAsk.drafts = {};
  agentAsk.adopted = {};
  vi.clearAllMocks();
});

describe("askSubagent", () => {
  it("holds a note under a running agent while its chat's turn runs, and sends nothing", async () => {
    h.app.busy = true;
    const r = row("running");
    h.app.subagents = [r];
    expect(await askSubagent(r, "focus on the tests")).toBe("held");
    expect(h.sent).toEqual([]);
    expect(agentAsk.notes["toolu_k"].map((n) => n.text)).toEqual(["focus on the tests"]);
    // Still running: nothing goes.
    await deliverDue();
    expect(h.sent).toEqual([]);
  });

  it("sends the held note once the agent is done and the turn has ended — into a new chat, never the parent", async () => {
    h.app.busy = true;
    const r = row("running");
    h.app.subagents = [r];
    await askSubagent(r, "focus on the tests");
    (r as { status: string }).status = "completed";
    h.app.busy = false;
    await deliverDue();
    expect(h.newSession).toHaveBeenCalledWith(undefined, "build");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].chat).toBeNull();
    expect(h.sent[0].text.startsWith('<subagent-transcript call="toolu_k"')).toBe(true);
    expect(h.sent[0].text.endsWith("focus on the tests")).toBe(true);
    expect(agentAsk.notes["toolu_k"]).toBeUndefined();
    expect(agentAsk.adopted["toolu_k"]).toBe("adopted-1");
    expect(h.renameSession).toHaveBeenCalledWith("adopted-1", "↳ agent: Memory task");
  });

  it("a Stop counts as the end: a row still marked running goes once its chat's turn is over", async () => {
    const r = row("running");
    h.app.subagents = [r];
    h.app.activeSessionId = "elsewhere";
    expect(await askSubagent(r, "now")).toBe("sent");
    expect(h.sent).toHaveLength(1);
  });

  it("a second question goes into the adopted chat as plain text", async () => {
    const r = row("completed");
    h.app.subagents = [r];
    agentAsk.adopted["toolu_k"] = "adopted-1";
    expect(await askSubagent(r, "and the animal?")).toBe("sent");
    expect(h.openSession).toHaveBeenCalledWith("adopted-1");
    expect(h.newSession).not.toHaveBeenCalled();
    expect(h.sent).toEqual([{ chat: "adopted-1", text: "and the animal?" }]);
  });

  it("keeps the question held when the chat on screen stays busy after the switch", async () => {
    const r = row("completed");
    h.app.subagents = [r];
    h.newSession.mockImplementationOnce(async () => {
      h.app.activeSessionId = null;
      h.app.busy = true;
    });
    expect(await askSubagent(r, "q")).toBe("held");
    expect(h.sent).toEqual([]);
    expect(agentAsk.notes["toolu_k"].map((n) => n.text)).toEqual(["q"]);
  });
});
