import { describe, expect, it, vi } from "vitest";
import { app, flushTabs, openChatSubagents, openSession, restoreTabs, type SubagentRow } from "./state.svelte";
import * as tabs from "./tabs";
import { TABS_KEY } from "./tabsStore";

/**
 * Through the app's own openers (nightshift backlog 160, 161): opening a
 * chat keeps the other chats' rows and brings this chat's recorded agents
 * back from its log; a file tab comes back at launch (guess pass
 * 2026-09-25, question 20).
 */
const LOG = [
  { event: "user_message", text: "hi", at: "2026-09-25T00:00:00Z" },
  {
    event: "assistant_message",
    model: "m",
    stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    at: "2026-09-25T00:00:01Z",
    blocks: [{ type: "tool_use", id: "toolu_log", name: "Agent", input: { description: "From the log" } }],
  },
  { event: "tool_result", tool_use_id: "toolu_log", name: "Agent", content: "done", at: "2026-09-25T00:00:02Z" },
];

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openSession: vi.fn(async () => LOG),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
  readCheckpoint: vi.fn(async () => null),
  checkpoint: vi.fn(async () => null),
}));

describe("opening a chat (backlog 160)", () => {
  it("keeps every chat's rows and adds this chat's recorded agents", async () => {
    const other: SubagentRow = {
      tool_use_id: "toolu_other",
      task_id: "",
      subagent_type: "",
      description: "Elsewhere",
      prompt: "",
      status: "completed",
      background: false,
      tokens: 5,
      tool_uses: 0,
      duration_ms: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      rounds: 0,
      session: "c0",
      turn: 2,
      startedAt: 0,
      updatedAt: 0,
      segments: [],
    };
    app.subagents = [other];
    app.busy = false;
    await openSession("c1");
    expect(app.activeSessionId).toBe("c1");
    expect(app.subagents.map((r) => r.tool_use_id)).toEqual(["toolu_other", "toolu_log"]);
    expect(openChatSubagents().map((r) => r.description)).toEqual(["From the log"]);
    // Opening it again changes nothing: one row per call.
    await openSession("c1");
    expect(app.subagents).toHaveLength(2);
  });
});

describe("a file tab across a relaunch (backlog 161)", () => {
  it("comes back like the other tabs", async () => {
    app.sessions = [{ id: "c1" }] as typeof app.sessions;
    await restoreTabs({ show: false });
    const pane = tabs.makePane([
      tabs.makeTab({ kind: "chat", session: "c1" }),
      tabs.makeTab({ kind: "file", path: "/tmp/acepaper.txt", session: "c1" }),
    ]);
    app.tabs = { panes: [pane], focused: pane.id };
    flushTabs();
    expect(localStorage.getItem(TABS_KEY)).toContain("acepaper.txt");
    app.tabs = tabs.emptyWorkspace();
    await restoreTabs({ show: false });
    expect(app.tabs.panes[0].tabs.map((t) => t.content)).toEqual([
      { kind: "chat", session: "c1" },
      { kind: "file", path: "/tmp/acepaper.txt", session: "c1" },
    ]);
  });
});
