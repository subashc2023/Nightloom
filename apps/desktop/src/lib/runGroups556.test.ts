import { describe, expect, it } from "vitest";
import { chatRun, groupRuns, projectSummary } from "./runGroups";
import type { RunEntry } from "./running";
import topBar from "./TopBar.svelte?raw";
import topBarClassic from "./TopBarClassic.svelte?raw";
import sidebarClassic from "./SidebarClassic.svelte?raw";
import tasks from "./RunningTasks.svelte?raw";

/** Items 556 + 558 (2026-11-10): which chat runs, and the running list by project. */
const row = (o: Partial<RunEntry> & Pick<RunEntry, "id" | "kind">): RunEntry => ({
  project: "p1",
  where: "Value Generalization",
  session: null,
  chat: "",
  doing: "",
  startedAt: null,
  onScreen: false,
  waiting: false,
  survivesQuit: false,
  ...o,
});

const runs: RunEntry[] = [
  row({ id: "turn:a", kind: "turn", project: "p2", where: "AI Safety Collective", session: "a", chat: "Review the site", startedAt: 100 }),
  row({ id: "agent:a1", kind: "subagent", project: "p2", where: "AI Safety Collective", session: "a", chat: "Review the site", startedAt: 150 }),
  row({ id: "turn:s1", kind: "turn", session: "s1", chat: "Phone page", startedAt: 300, onScreen: true }),
  row({ id: "agent:x2", kind: "subagent", session: "s1", chat: "Phone page", startedAt: 320, onScreen: true }),
  row({ id: "agent:x1", kind: "subagent", session: "s1", chat: "Phone page", startedAt: 310, onScreen: true }),
  row({ id: "turn:s2", kind: "turn", session: "s2", chat: "Signup flow", startedAt: 200, waiting: true }),
  row({ id: "dream:", kind: "dream", project: null, where: "memory", startedAt: 50 }),
  row({ id: "aside:q", kind: "aside", project: null, where: "unfiled chats", session: "u1", chat: "Loose chat", startedAt: 400 }),
];

describe("groupRuns: project → chat → runs (558)", () => {
  const g = groupRuns(runs, "p1");
  it("puts the open project first, then the rest by their earliest start", () => {
    expect(g.map((p) => p.where)).toEqual(["Value Generalization", "memory", "AI Safety Collective", "unfiled chats"]);
    expect(g[0].here).toBe(true);
    expect(g.slice(1).every((p) => !p.here)).toBe(true);
  });
  it("counts every row, so the groups add up to the badge", () => {
    expect(g.reduce((n, p) => n + p.count, 0)).toBe(runs.length);
    expect(g[0].count).toBe(4);
  });
  it("puts the chat on screen first in its project, its turn as the head and its agents by start", () => {
    const p1 = g[0];
    expect(p1.chats.map((c) => c.session)).toEqual(["s1", "s2"]);
    expect(p1.chats[0].turn?.id).toBe("turn:s1");
    expect(p1.chats[0].parts.map((r) => r.id)).toEqual(["agent:x1", "agent:x2"]);
    expect(p1.chats[1].waiting).toBe(true);
    expect(p1.waiting).toBe(true);
  });
  it("says a folded project's size", () => {
    expect(projectSummary(g[2])).toBe("1 chat · 2 running");
    expect(projectSummary(g[1])).toBe("1 running");
  });
  it("makes unfiled chats the open project when none is open", () => {
    const u = groupRuns(runs, null);
    expect(u[0].where).toBe("unfiled chats");
    expect(u.find((p) => p.where === "memory")?.here).toBe(false);
  });
  it("keeps app-wide work apart: each row its own entry", () => {
    const two = groupRuns([row({ id: "dream:", kind: "dream", project: null, where: "memory", startedAt: 1 }), row({ id: "capture:", kind: "capture", project: null, where: "memory", startedAt: 2 })], "p1");
    expect(two).toHaveLength(1);
    expect(two[0].chats.map((c) => c.chat)).toEqual(["dream", "capture"]);
  });
});

describe("chatRun: the open chat running vs idle (556)", () => {
  it("is running while its turn runs, with its agents counted", () => {
    expect(chatRun(runs, "s1")).toEqual({ state: "running", startedAt: 300, agents: 2, doing: "" });
  });
  it("is waiting when its prompt waits on him", () => {
    expect(chatRun(runs, "s2").state).toBe("waiting");
  });
  it("is idle with no turn, though another chat runs", () => {
    expect(chatRun(runs, "s9")).toEqual({ state: "idle", startedAt: null, agents: 0, doing: "" });
  });
  it("is idle with only an aside running in it", () => {
    expect(chatRun(runs, "u1").state).toBe("idle");
  });
  it("reads the new chat (no id yet) from the on-screen turn", () => {
    const fresh = [row({ id: "turn:new", kind: "turn", session: null, onScreen: true, startedAt: 9 })];
    expect(chatRun(fresh, null).state).toBe("running");
    expect(chatRun([row({ id: "turn:new", kind: "turn", session: null, onScreen: false })], null).state).toBe("idle");
  });
});

describe("the sign is wired in both layouts (Classic-twin rule)", () => {
  it("both top bars mount the open chat's sign", () => {
    expect(topBar).toContain("<ChatRunSign");
    expect(topBarClassic).toContain("<ChatRunSign");
  });
  it("the Classic chat list marks a running row", () => {
    expect(sidebarClassic).toContain("class:live={!!live}");
    expect(sidebarClassic).toContain("liveChats");
  });
  it("the panel groups by project under Filament IV and keeps Classic's list", () => {
    expect(tasks).toContain("groupRuns(");
    expect(tasks).toContain("classic()");
  });
});
