import { beforeEach, describe, expect, it, vi } from "vitest";

// The phone's handlers in the Mac's window (item 246, wave 1, 1B) against a
// stand-in for the app's state, the backend and Tauri's event bus.
const calls: string[] = [];
const fake = vi.hoisted(() => {
  const app = {
    busy: false,
    connecting: false,
    activeSessionId: "c1" as string | null,
    project: { id: "p1" } as { id: string } | null,
    projects: [{ id: "p1" }, { id: "p2" }] as { id: string }[],
    events: [{ event: "user_message", text: "hi" }] as unknown[],
    error: null as string | null,
    toasts: [] as { id: number; text: string }[],
    connection: { engine: "claude-code" } as { engine: string } | null,
    connectError: null as string | null,
    checkpoint: null as unknown,
    agentTurn: null as unknown,
    turnBudget: null as unknown,
    draft: {
      engine: "claude-code",
      provider: "anthropic",
      model: "m",
      agentModel: "opus",
      agentEffort: "",
      agentFallback: "",
      thinkingMode: "default",
      agentLimits: { per_turn: 6, concurrent: 3, depth: 1, per_day: 50, slow_at: 70, slow_to: 2, stop_at: 90, budget_pct: 35, model: "auto", off: { per_turn: false } },
      approval: true,
      agentAsk: false,
      agentPlan: false,
      agentSubagentsAuto: true,
      agentForkMode: true,
    } as Record<string, unknown>,
  };
  let toastSeq = 0;
  const toast = (text: string) => app.toasts.push({ id: ++toastSeq, text });
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  return { app, toast, listeners };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    calls.push(`invoke ${cmd} ${JSON.stringify(args)}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    fake.listeners.set(name, cb);
    return () => {};
  },
}));
vi.mock("./api", () => ({
  forkSession: async (upto: number) => ({ events: [{ event: "fork", upto }], session: "fork-1", forked: true }),
  editMessage: async (index: number, text: string, mode: string) => {
    calls.push(`editMessage ${index} ${text} ${mode}`);
    return { events: [{ event: "fork" }], session: "fork-2", forked: true };
  },
  unrewind: async () => [{ event: "unrewind" }],
  restoreSession: async (id: string) => `${id}-full`,
  budgetOverride: async (s: string, d: string) => calls.push(`budget ${s} ${d}`),
  remoteSent: async (id: number, queued: boolean, error: string | null) => calls.push(`remoteSent ${id} ${queued} ${error}`),
  contextView: async () => ({ items: [] }),
  promptLayers: async () => ({ off: [] }),
  promptPending: async () => null,
  newProject: async (name: string) => ({ id: "p9", name }),
}));
vi.mock("./state.svelte", () => {
  const a = fake.app;
  return {
    app: a,
    applyDraft: async () => calls.push("applyDraft"),
    cancelTurn: async () => {},
    chatKind: () => "build",
    chooseLayerVersion: async () => {},
    compactSession: async () => {},
    continueChat: async () => {},
    councilFor: () => ({ seats: [], mode: "answer" }),
    setCouncilFor: (_: unknown, p: unknown) => calls.push(`council ${JSON.stringify(p)}`),
    deleteSession: async (id: string) => {
      if (id === "running") fake.toast("That chat is running a turn — delete it when the turn ends");
      else calls.push(`delete ${id}`);
    },
    editContextItems: async () => null,
    forgetProject: async () => {},
    liveChats: () => [],
    openChatSubagents: () => [],
    openSession: async (id: string) => {
      calls.push(`open ${id}`);
      if (id !== "missing") a.activeSessionId = id;
    },
    promptLayersOff: () => [],
    refreshNotes: async () => {},
    refreshProjects: async () => calls.push("refreshProjects"),
    refreshSessions: async () => {},
    remoteNewChat: async () => "sent",
    remoteSend: async (chat: string | null, text: string, images: unknown[] = []) => {
      calls.push(images.length ? `remoteSend ${chat} ${text} ${images.length}` : `remoteSend ${chat} ${text}`);
      return "sent";
    },
    removeBlock: async () => true,
    removeTurn: async (i: number) => {
      if (i === 99) {
        fake.toast("that turn is not in this chat");
        return;
      }
      a.events = [{ event: "elide", index: i }];
    },
    renameProject: async () => {},
    resolveApproval: async () => {},
    restoreBlock: async () => {},
    restoreTurn: async () => {},
    resumeAfterLimit: () => calls.push("resume"),
    rewindTo: async () => {},
    saveEdit: async (i: number, t: string) => {
      a.events = [{ event: "edit", index: i, text: t }];
      return true;
    },
    saveReplyEdit: async () => false,
    send: async (text: string, images: unknown[]) => calls.push(`send ${text} ${images.length}`),
    setCheckpoint: async () => {},
    setPromptLayer: async () => {},
    setPromptLayerText: async () => true,
    switchAside: (id: string) => calls.push(`aside ${id}`),
    switchChatKind: async () => {},
    useEngine: async (e: string) => {
      a.draft.engine = e;
    },
    useProject: async (id: string) => {
      calls.push(`project ${id}`);
      a.project = { id };
    },
  };
});

import {
  checkRail,
  ensureChat,
  installRemoteHandlers,
  railOf,
  runAct,
  runProject,
  runSend,
  runSetRail,
} from "./remoteHandlers";

beforeEach(() => {
  calls.length = 0;
  Object.assign(fake.app, {
    busy: false,
    connecting: false,
    activeSessionId: "c1",
    project: { id: "p1" },
    events: [{ event: "user_message", text: "hi" }],
    error: null,
    toasts: [],
    connection: { engine: "claude-code" },
  });
  Object.assign(fake.app.draft, { engine: "claude-code", agentModel: "opus", agentEffort: "", agentAsk: false, agentPlan: false });
});

describe("a chat action from the phone", () => {
  it("a fork's reply switches to the fork's id, with its log", async () => {
    const r = await runAct("c1", null, { op: "fork", upto: 2 });
    expect(r.chat).toBe("fork-1");
    expect(fake.app.activeSessionId).toBe("fork-1");
    expect(r.events).toEqual([{ event: "fork", upto: 2 }]);
    expect(calls).toContain("aside fork-1");
  });

  it("a refused action keeps the chat as it was and says why", async () => {
    const before = fake.app.events;
    await expect(runAct("c1", null, { op: "remove", index: 99 })).rejects.toThrow("that turn is not in this chat");
    expect(fake.app.events).toBe(before);
    expect(fake.app.activeSessionId).toBe("c1");
  });

  it("an action that lands answers with the chat's new log", async () => {
    const r = await runAct("c1", null, { op: "remove", index: 0 });
    expect(r).toEqual({ chat: "c1", events: [{ event: "elide", index: 0 }] });
  });

  it("a false from the state function is a refusal even with no toast", async () => {
    await expect(runAct("c1", null, { op: "edit", index: 1, text: "x", mode: "save", block: 0 })).rejects.toThrow(
      "the Mac did not save the edit",
    );
  });

  it("opens a chat that is not the open one — in its own project first", async () => {
    const r = await runAct("c7", "p2", { op: "edit", index: 0, text: "new words", mode: "save" });
    expect(calls.slice(0, 2)).toEqual(["project p2", "open c7"]);
    expect(r.chat).toBe("c7");
  });

  it("is refused while a turn runs in the chat on screen (blocker 665)", async () => {
    fake.app.busy = true;
    await expect(ensureChat("c7", null)).rejects.toThrow(/running a turn in the chat on its screen/);
    expect(calls).not.toContain("open c7");
    // In that same chat, the words are the running-turn refusal.
    await expect(runAct("c1", null, { op: "rewind", to: 0 })).rejects.toThrow(/running a turn/);
  });

  it("a chat that would not open is a sentence, not a success", async () => {
    await expect(runAct("missing", null, { op: "remove", index: 0 })).rejects.toThrow("the Mac could not open that chat");
  });

  it("edit and send forks, opens the fork, and sends through the phone's path", async () => {
    const r = await runAct("c1", null, { op: "edit", index: 0, text: "again", mode: "send" });
    expect(calls).toContain("editMessage 0 again send");
    expect(calls).toContain("remoteSend null again");
    expect(r.chat).toBe("fork-2");
  });

  it("delete goes by id without opening; a refused delete says why", async () => {
    expect(await runAct("c5", null, { op: "delete" })).toEqual({ chat: "c5", events: [] });
    expect(calls).toEqual(["delete c5"]);
    await expect(runAct("running", null, { op: "delete" })).rejects.toThrow(/running a turn/);
  });

  it("restore after delete answers with the chat's full id", async () => {
    expect((await runAct("c5", null, { op: "undelete" })).chat).toBe("c5-full");
  });

  it("a budget answer goes to the running chat by id, mid-turn", async () => {
    fake.app.busy = true;
    await runAct("c1", null, { op: "budget", decision: "wrap" });
    expect(calls).toContain("budget c1 wrap");
    await expect(runAct("c1", null, { op: "budget", decision: "nope" })).rejects.toThrow("no budget answer nope");
  });
});

describe("the rail from the phone", () => {
  it("a bad field changes nothing", async () => {
    expect(() => checkRail({ effort: "turbo" })).toThrow("no effort level turbo");
    await expect(runSetRail({ model: "sonnet", effort: "turbo" })).rejects.toThrow();
    expect(fake.app.draft.agentModel).toBe("opus");
    expect(calls).not.toContain("applyDraft");
  });

  it("merges the change and connects once; Plan implies Ask", async () => {
    const r = await runSetRail({ model: "sonnet", effort: "high", plan: true });
    expect(fake.app.draft.agentModel).toBe("sonnet");
    expect(fake.app.draft.agentEffort).toBe("high");
    expect(fake.app.draft.agentAsk).toBe(true);
    expect(calls.filter((c) => c === "applyDraft")).toHaveLength(1);
    expect(r.model).toBe("sonnet");
  });

  it("no change is no reconnect", async () => {
    await runSetRail({ model: "opus" });
    expect(calls).not.toContain("applyDraft");
  });

  it("names no key or folder", () => {
    const keys = Object.keys(railOf());
    expect(keys).not.toContain("workspace");
    expect(keys.some((k) => /key/i.test(k))).toBe(false);
  });
});

describe("a message from the phone", () => {
  it("text alone goes the way it always went", async () => {
    expect(await runSend({ id: 1, chat: "c1", text: "hello" })).toBe("sent");
    expect(calls).toEqual(["remoteSend c1 hello"]);
  });

  it("a photo goes with the message through the phone's own send path", async () => {
    // Through `remoteSend` (1B's patch note 1), so the turn is not his typed
    // input; its refusal while the chat runs is tested in state.tabs.test.ts.
    await runSend({ id: 1, chat: "c1", text: "look", images: [{ media_type: "image/jpeg", data: "AA" }] });
    expect(calls).toContain("remoteSend c1 look 1");
    expect(calls).not.toContain("send look 1");
  });

  it("into another project's chat opens that project first", async () => {
    await runSend({ id: 1, chat: "c8", text: "hi", project: "p2" });
    expect(calls.slice(0, 3)).toEqual(["project p2", "open c8", "remoteSend c8 hi"]);
  });
});

describe("projects from the phone", () => {
  it("opens by the project's id, not the call's", async () => {
    await runProject({ op: "open", pid: "p2" });
    expect(fake.app.project?.id).toBe("p2");
  });

  it("a new project leaves the Mac's form alone and re-reads the list", async () => {
    expect(await runProject({ op: "new", name: " Garden " })).toEqual({ id: "p9", name: "Garden" });
    expect(calls).toContain("refreshProjects");
  });
});

describe("the listeners answer through remote_done", () => {
  it("a done act replies ok with the reply; a refused one with the sentence", async () => {
    await installRemoteHandlers();
    fake.listeners.get("remote-act")!({ payload: { id: 7, chat: "c1", project: null, action: { op: "remove", index: 0 } } });
    fake.listeners.get("remote-act")!({ payload: { id: 8, chat: "c1", project: null, action: { op: "remove", index: 99 } } });
    await vi.waitFor(() => expect(calls.filter((c) => c.startsWith("invoke remote_done"))).toHaveLength(2));
    const done = calls.filter((c) => c.startsWith("invoke remote_done"));
    expect(done).toContainEqual(expect.stringContaining('"id":7,"ok":true'));
    expect(done).toContainEqual('invoke remote_done {"id":8,"ok":false,"json":"that turn is not in this chat"}');
  });

  it("a project call keeps its own id apart from the project's", async () => {
    await installRemoteHandlers();
    fake.listeners.get("remote-project")!({ payload: { id: 11, op: "open", pid: "p2" } });
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith("invoke remote_done"))).toBe(true));
    expect(calls.find((c) => c.startsWith("invoke remote_done"))).toContain('"id":11,"ok":true');
  });
});
