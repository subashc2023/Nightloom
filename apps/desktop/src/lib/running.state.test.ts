import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, asideStash, openRun, runningWork, send, switchAside, useProject, type Aside, type SubagentRow } from "./state.svelte";
import { REFRESH_LIMIT_MS } from "./afterWrite";
import { allRunning, cancelQuit, listenForQuit, pushQuitLines, quitAsk } from "./running.svelte";
import { noteEdits } from "./noteEdit.svelte";
import { quitLines } from "./running";
import * as api from "./api";
import type { ProjectInfo, SessionEvent } from "./types";

/**
 * The one list of running work (nightshift backlogs 308, 309), through the
 * store: every kind in every project with its project, chat, kind and
 * start; a run that ends leaves it; a project switch does not empty it; a
 * click opens the chat in its own project; and the quit guard's lines and
 * dialog follow it.
 */
const { row, fake } = vi.hoisted(() => ({
  row: (id: string, name = id.toUpperCase()): ProjectInfo =>
    ({ id, name, root: `/p/${id}`, notes_dir: `/p/${id}/n`, notes: 0, chats: 0, exists: true }) as ProjectInfo,
  fake: { listeners: new Map<string, (e: { payload: unknown }) => void>() },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    fake.listeners.set(name, cb);
    return () => {};
  },
  emit: async () => {},
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listProjects: vi.fn(async () => [row("a"), row("b")]),
  listSessions: vi.fn(async () => []),
  listNotes: vi.fn(async () => []),
  projectsFolderInfo: vi.fn(async () => ({ dir: "/p", default: true })),
  openProject: vi.fn(async (id: string) => row(id)),
  closeProject: vi.fn(async () => null),
  openSession: vi.fn(async () => [] as SessionEvent[]),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  transcript: vi.fn(async () => []),
  readCheckpoint: vi.fn(async () => null),
  checkpoint: vi.fn(async () => null),
  // A provider turn that runs until the test is done with it.
  send: vi.fn(() => new Promise<never>(() => {})),
  cancel: vi.fn(async () => null),
  setRunningWork: vi.fn(async () => {}),
  quitDialogShown: vi.fn(async () => {}),
  quitNow: vi.fn(async () => {}),
}));

const said = (at: string): SessionEvent => ({ event: "user_message", text: "go", at }) as SessionEvent;

const agent = (over: Partial<SubagentRow>): SubagentRow => ({
  tool_use_id: "toolu_1",
  task_id: "",
  subagent_type: "general-purpose",
  description: "Survey the crate",
  prompt: "",
  status: "running",
  background: false,
  tokens: 0,
  tool_uses: 0,
  duration_ms: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  rounds: 0,
  session: "c2",
  turn: 1,
  startedAt: 5_000,
  updatedAt: 5_000,
  segments: [],
  ...over,
});

const asking = (id: number, question: string): Aside => ({
  id,
  quote: null,
  draft: false,
  anchor: null,
  turns: [{ seq: id, question, partial: "", answer: null, error: null, cancelled: false, cacheRead: 0, startedAt: 7_000 }],
});

/** A turn running off screen in project `b`. */
function offScreenInB(): void {
  app.background = {
    c2: {
      session: "c2",
      pendingMode: "normal",
      pendingKind: "build",
      events: [said("2026-10-04T10:00:00Z")],
      live: { segments: [{ kind: "tool", call: { id: "t", name: "Bash", input: {}, result: null } }] },
      liveUsage: null,
      approvals: [],
      project: "b",
      projectName: "Beta",
      name: "Fix the build",
    },
  } as unknown as typeof app.background;
}

beforeEach(() => {
  app.projects = [row("a", "Alpha"), row("b", "Beta")];
  app.project = row("a", "Alpha");
  app.sessions = [{ id: "c1", title: "Plan the week", first_user: "plan" } as unknown as (typeof app.sessions)[number]];
  app.activeSessionId = "c1";
  app.events = [said("2026-10-04T09:00:00Z")];
  app.live = { segments: [{ kind: "thinking", text: "", done: false }] };
  app.busy = false;
  app.parked = null;
  app.background = {};
  app.subagents = [];
  app.asides = [];
  asideStash.clear();
  app.dreaming = false;
  app.capturing = false;
  app.centre.dailyRunning = false;
  app.centre.rows = [];
  app.nightshift.interview = null;
  app.pendingApprovals = [];
  app.showTasks = true;
  app.toasts = [];
  for (const k of Object.keys(noteEdits)) delete noteEdits[k];
});

describe("the running list (309)", () => {
  it("lists a turn on screen and one off screen in another project, each with project, chat, kind and start", () => {
    app.busy = true;
    offScreenInB();
    const runs = runningWork();
    expect(runs.map((r) => [r.where, r.chat, r.kind, r.doing, r.onScreen])).toEqual([
      ["Alpha", "Plan the week", "turn", "thinking", true],
      ["Beta", "Fix the build", "turn", "running Bash", false],
    ]);
    expect(runs[0].startedAt).toBe(Date.parse("2026-10-04T09:00:00Z"));
    expect(runs[1].project).toBe("b");
  });

  it("lists a running subagent under its chat's project, and drops a row its ended turn left 'running'", () => {
    offScreenInB();
    app.subagents = [agent({}), agent({ tool_use_id: "toolu_stale", session: "c9" })];
    const runs = runningWork().filter((r) => r.kind === "subagent");
    expect(runs.map((r) => [r.where, r.chat, r.doing])).toEqual([["Beta", "Fix the build", "Survey the crate — starting"]]);
  });

  it("calls a turn with seats answering a council, and lists each seat", () => {
    app.busy = true;
    app.subagents = [
      agent({ tool_use_id: "s1", session: "c1", subagent_type: "council seat", model: "fable" }),
      agent({ tool_use_id: "s2", session: "c1", subagent_type: "council seat", model: "opus" }),
    ];
    const runs = runningWork();
    expect(runs.find((r) => r.session === "c1" && r.id.startsWith("turn:"))?.kind).toBe("council");
    expect(runs.find((r) => r.id.startsWith("turn:"))?.doing).toBe("2 seats answering");
    expect(runs.filter((r) => r.kind === "council seat")).toHaveLength(2);
  });

  it("keeps an aside asking in a chat left for another project, under the chat's own project", () => {
    switchAside("c3"); // opened in Alpha
    app.activeSessionId = "c3";
    app.asides = [asking(1, "why does the build\nfail?")];
    app.project = row("b", "Beta");
    switchAside(null); // the project switch stashes it
    app.activeSessionId = null;
    const runs = runningWork();
    expect(runs.map((r) => [r.where, r.kind, r.doing, r.session])).toEqual([["Alpha", "aside", "“why does the build fail?”", "c3"]]);
  });

  it("lists the memory passes, a note edit, and a Nightshift run that survives a quit", () => {
    app.dreaming = true;
    app.centre.rows = [{ id: "g", name: "Gamma", nightshift: { live: true } } as unknown as (typeof app.centre.rows)[number]];
    noteEdits["a:project:ideas.md"] = {
      draft: "",
      strike: true,
      touched: "",
      turns: [{ id: 1, request: "tighten it", strike: true, at: "2026-10-04T10:00:00Z", status: "running", before: "" }],
    };
    const runs = allRunning();
    expect(runs.map((r) => [r.kind, r.where, r.survivesQuit])).toEqual(
      expect.arrayContaining([
        ["dream", "memory", false],
        ["nightshift", "Gamma", true],
        ["note edit", "Alpha", false],
      ]),
    );
    expect(quitLines(runs)).not.toContain(expect.stringContaining("nightshift"));
    expect(quitLines(runs).some((l) => l.includes("Gamma"))).toBe(false);
  });

  it("empties as runs end — the daily pass standing for its capture and dream while it runs", () => {
    app.centre.dailyRunning = true;
    app.capturing = true;
    expect(runningWork().map((r) => r.kind)).toEqual(["daily pass"]);
    app.centre.dailyRunning = false;
    app.capturing = false;
    expect(runningWork()).toEqual([]);
  });
});

describe("a click on a row (309)", () => {
  it("opens a stashed aside's chat in the project it was opened in", async () => {
    app.project = row("b", "Beta");
    await openRun({ session: "c3", project: "a", onScreen: false });
    expect(app.project?.id).toBe("a");
    expect(app.activeSessionId).toBe("c3");
  });

  it("for the chat on screen only scrolls to the running turn", async () => {
    const before = app.toLatest;
    vi.mocked(api.openProject).mockClear();
    await openRun({ session: "c1", project: "a", onScreen: true });
    expect(api.openProject).not.toHaveBeenCalledWith("a");
    expect(app.toLatest).toBe(before + 1);
  });
});

describe("the quit guard's window side (308)", () => {
  it("tells Rust what a quit would stop only when that changes, and nothing when nothing runs", () => {
    const set = vi.mocked(api.setRunningWork);
    set.mockClear();
    pushQuitLines(allRunning());
    app.busy = true;
    pushQuitLines(allRunning());
    app.live = { segments: [{ kind: "text", text: "Hi" }] }; // doing changed, the line did not
    pushQuitLines(allRunning());
    expect(set.mock.calls.map((c) => c[0])).toEqual([[], ["Alpha · Plan the week · turn"]]);
  });

  it("puts the dialog up on Rust's ask, acknowledges it, and Cancel leaves the run going", async () => {
    await listenForQuit();
    app.busy = true;
    fake.listeners.get("quit-requested")?.({ payload: ["Alpha · Plan the week · turn"] });
    expect(quitAsk.open).toBe(true);
    expect(api.quitDialogShown).toHaveBeenCalled();
    cancelQuit();
    expect(quitAsk.open).toBe(false);
    expect(app.busy).toBe(true);
    expect(api.quitNow).not.toHaveBeenCalled();
  });
});

// Last: its provider turn is left running (one at a time, A4), and the
// screen's turn context with it — the cases above would read it.
describe("a click on a turn running in another project (309)", () => {
  it("opens a turn left running in another project: that project, that chat, streaming, at its foot", async () => {
    vi.useFakeTimers();
    try {
      app.draft.engine = "provider";
      app.draft.provider = "";
      app.connection = { engine: "anthropic", model: "m" } as unknown as typeof app.connection;
      app.view = "chat";
      app.activeSessionId = "c2";
      app.sessions = [{ id: "c2", title: "Fix the build", first_user: "fix" } as unknown as (typeof app.sessions)[number]];
      app.events = [];
      void send("fix the build");
      const switched = useProject("b");
      await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS + 50);
      await switched;
      expect(app.project?.id).toBe("b");
      const [r] = runningWork();
      expect(r).toMatchObject({ kind: "turn", project: "a", where: "Alpha", session: "c2", chat: "Fix the build", onScreen: false });
      const before = app.toLatest;
      const opened = openRun(r);
      await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS + 50);
      await opened;
      expect(app.project?.id).toBe("a");
      expect(app.activeSessionId).toBe("c2");
      expect(app.busy).toBe(true);
      expect(app.showTasks).toBe(false);
      expect(app.toLatest).toBe(before + 1);
      expect(runningWork()[0]).toMatchObject({ session: "c2", onScreen: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
