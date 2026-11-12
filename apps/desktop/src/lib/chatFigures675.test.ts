// Item 675 (2026-11-12): the main chat's "API cost" never falls, and the
// top bar reads the figure the right column reads.
import { describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ sessionFigures: vi.fn() }));

import * as api from "./api";
import { agentChatSpend, chatFigures, figuresOf, loadChatFigures } from "./chatFigures.svelte";
import { chatAgentSession, chatAgentSessions } from "./state.svelte";
import type { SessionEvent } from "./types";
import type { SessionFigures } from "./usageFigures";
import topBar from "./TopBar.svelte?raw";
import topBarClassic from "./TopBarClassic.svelte?raw";
import rightRail from "./RightRail.svelte?raw";

const figures = (over: Partial<SessionFigures> = {}): SessionFigures => ({
  found: true,
  cost_usd: 12.14,
  api_ms: null,
  run_ms: null,
  lines_added: null,
  lines_removed: null,
  models: [],
  cache_hit: null,
  using: [],
  unknown_cost: false,
  ...over,
});

const ev = (e: Record<string, unknown>) => e as unknown as SessionEvent;

describe("every CLI session a chat has run on (675)", () => {
  // His ICS 46 chat's shape: a session, then two rewinds, each starting a new one.
  const log = [
    ev({ event: "agent_session", agent: "claude-code", id: "s-1", at: "t0" }),
    ev({ event: "user_message", text: "a", at: "t1" }),
    ev({ event: "rewind", to: 1, at: "t2" }),
    ev({ event: "agent_session", agent: "claude-code", id: "s-2", at: "t2" }),
    ev({ event: "rewind", to: 1, at: "t3" }),
    ev({ event: "agent_session", agent: "claude-code", id: "s-3", at: "t3" }),
    ev({ event: "agent_session", agent: "claude-code", id: "s-3", at: "t4" }),
  ];

  it("lists them oldest first, each once, rewound ones included", () => {
    expect(chatAgentSessions(log)).toEqual(["s-1", "s-2", "s-3"]);
    expect(chatAgentSession(log)).toBe("s-3");
    expect(chatAgentSessions([])).toEqual([]);
  });

  it("asks the backend for the live session with the earlier ones, and holds only the chat asked for last", async () => {
    const calls: { id: string; earlier: string[]; done: (f: SessionFigures) => void }[] = [];
    vi.mocked(api.sessionFigures).mockImplementation(
      (id: string, earlier: string[] = []) => new Promise<SessionFigures>((done) => calls.push({ id, earlier, done })),
    );
    loadChatFigures("s-3", ["s-1", "s-2", "s-3"]);
    // The same chain again while the first is in flight (the bar and the column both ask): one read.
    loadChatFigures("s-3", ["s-1", "s-2", "s-3"]);
    expect(calls.map((c) => [c.id, c.earlier])).toEqual([["s-3", ["s-1", "s-2"]]]);
    // He opens another chat before it lands: the late answer for the first is dropped.
    loadChatFigures("other", ["other"]);
    calls[0]!.done(figures({ cost_usd: 12.14, rewound_usd: 0.22 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(figuresOf("s-3")).toBeNull();
    calls[1]!.done(figures({ cost_usd: 3 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(chatFigures.of).toBe("other");
    expect(figuresOf("other")?.cost_usd).toBe(3);
    expect(figuresOf("s-3")).toBeNull();
    expect(figuresOf(null)).toBeNull();
  });
});

describe("the top bar's Spent on a Claude Code chat (675)", () => {
  it("is the CLI's running cost for the chat, not the log's empty sum", () => {
    // A Claude Code reply carries no logged cost: the log's sum is 0, incomplete.
    expect(agentChatSpend(figures(), { usd: 0, complete: false })).toEqual({ usd: 12.14, complete: true });
    expect(agentChatSpend(figures({ unknown_cost: true }), null)).toEqual({ usd: 12.14, complete: false });
  });
  it("adds what the same chat's API-engine replies logged", () => {
    expect(agentChatSpend(figures({ cost_usd: 2 }), { usd: 0.5, complete: false })).toEqual({ usd: 2.5, complete: true });
  });
  it("says nothing before the first turn has ended, rather than $0.00", () => {
    expect(agentChatSpend(null, { usd: 0, complete: false })).toBeNull();
    expect(agentChatSpend(figures({ cost_usd: null }), null)).toBeNull();
    expect(agentChatSpend(null, { usd: 0.5, complete: true })).toEqual({ usd: 0.5, complete: false });
  });
  it("is what both bars and the column read", () => {
    for (const src of [topBar, topBarClassic]) {
      expect(src).toContain("openChatSpend()");
      expect(src).toContain("trackOpenChatFigures()");
      expect(src).not.toMatch(/const c = sessionCost\(\)/);
    }
    expect(rightRail).toContain("figuresOf(agentSession)");
    expect(rightRail).not.toMatch(/api\s*\.sessionFigures/);
  });
});

describe("an aside's cost in the column (675)", () => {
  it("is written as added over the chat", () => {
    expect(rightRail).toContain("data-aside-added");
    expect(rightRail).toContain("over the chat, at API prices");
  });
});
