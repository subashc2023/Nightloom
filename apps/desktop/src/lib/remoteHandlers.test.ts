import { beforeEach, describe, expect, it, vi } from "vitest";

// The phone's handlers in the Mac's window (item 246, wave 1, 1B) against a
// stand-in for the app's state, the backend and Tauri's event bus.
const calls: string[] = [];
/** `remote_claim`'s ids (132 (d)), apart from `calls` so the older
 *  tests' exact call lists stand as they were. */
const claims: number[] = [];
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
    asides: [] as FakeAside[],
    sessions: [{ id: "c1" }, { id: "c2" }] as { id: string }[],
    dreaming: false,
    capturing: false,
    dreamActivity: "",
    palette: "A" as string,
    limitPause: null as null | { session: string | null; resetsAtMs: number | null; window: string | null; text: string; subagents: string[]; hitAtMs: number },
    limitResumeAt: null as number | null,
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
  type FakeTurn = { seq: number; question: string; partial: string; answer: string | null; error: string | null; cancelled: boolean; cacheRead: number };
  type FakeAside = { id: number; quote: { text: string } | null; draft: boolean; turns: FakeTurn[]; anchor: null; name?: string };
  const stash = new Map<string, FakeAside[]>();
  const aside = { seq: 0, finish: [] as (() => void)[], cancelled: [] as number[] };
  let toastSeq = 0;
  const toast = (text: string) => app.toasts.push({ id: ++toastSeq, text });
  const listeners = new Map<string, (e: { payload: unknown }) => void>();
  /** What `remote_claim` answers (132 (d)); how `resumeAfterLimit` acts;
   *  what a dream's run toasts. */
  const knobs = { claim: true as boolean, resume: "now" as "now" | "schedule" | "refuse", passToast: "dream: consolidated 2 observations", sendOut: "sent" as "sent" | "queued" };
  return { app, toast, listeners, stash, aside, knobs };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    if (cmd === "remote_claim") {
      claims.push((args as { id: number }).id);
      return fake.knobs.claim;
    }
    calls.push(`invoke ${cmd} ${JSON.stringify(args)}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    fake.listeners.set(name, cb);
    return () => {};
  },
  emit: async (name: string, payload: unknown) => {
    calls.push(`emit ${name} ${JSON.stringify(payload)}`);
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
  promptLayerFile: async (kind: string) => (kind === "user_memory" ? "# memory file" : null),
  newProject: async (name: string) => ({ id: "p9", name }),
}));
vi.mock("./asideHistory.svelte", () => ({
  pastOf: (chat: string) =>
    chat === "c1"
      ? [{ key: "k1", closedAt: 5, thread: { quote: null, name: "Old", turns: [{ question: "q0", answer: "a0", error: null, cancelled: false }] } }]
      : [],
}));
vi.mock("./state.svelte", () => {
  const a = fake.app;
  type T = (typeof a.asides)[number]["turns"][number];
  const asking = (x: (typeof a.asides)[number]): T | null => {
    const t = x.turns[x.turns.length - 1] ?? null;
    return t && t.answer === null && t.error === null && !t.cancelled ? t : null;
  };
  // Like the real ones: the exchange is numbered and on its card before
  // the first wait; it ends when a test calls `fake.aside.finish`.
  const run = (t: T) =>
    new Promise<void>((res) =>
      fake.aside.finish.push(() => {
        t.answer = `answer to ${t.question}`;
        t.partial = t.answer;
        res();
      }),
    );
  const turn = (q: string): T => ({ seq: ++fake.aside.seq, question: q, partial: "", answer: null, error: null, cancelled: false, cacheRead: 0 });
  return {
    app: a,
    askAside: (q: string, quote: unknown = null, draft: (typeof a.asides)[number] | null = null) => {
      const t = turn(q);
      if (draft) {
        draft.draft = false;
        draft.turns.push(t);
      } else a.asides.push({ id: 100 + t.seq, quote: quote as null, draft: false, turns: [t], anchor: null });
      return run(t);
    },
    followUpAside: (q: string, thread: (typeof a.asides)[number]) => {
      const t = turn(q);
      thread.turns.push(t);
      return run(t);
    },
    asideAsking: asking,
    asidesOf: (chat: string) => (chat === a.activeSessionId ? a.asides : (fake.stash.get(chat) ?? [])),
    dismissAside: (x: (typeof a.asides)[number]) => {
      const t = asking(x);
      if (t) {
        t.cancelled = true;
        fake.aside.cancelled.push(t.seq);
      }
    },
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
    remoteSend: async (
      chat: string | null,
      text: string,
      images: unknown[] = [],
      _documents: unknown[] = [],
      _council: unknown = null,
      spoken = false,
    ) => {
      calls.push(
        (images.length ? `remoteSend ${chat} ${text} ${images.length}` : `remoteSend ${chat} ${text}`) +
          (spoken ? " spoken" : ""),
      );
      return fake.knobs.sendOut;
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
    resumeAfterLimit: () => {
      calls.push("resume");
      if (fake.knobs.resume === "schedule") a.limitResumeAt = (a.limitPause?.resetsAtMs ?? 0) + 30_000;
      else if (fake.knobs.resume === "refuse") fake.toast("The paused chat is not open or is busy — open it and press Resume again.");
      else a.limitPause = null;
    },
    runDream: async () => {
      calls.push("runDream");
      fake.toast(fake.knobs.passToast);
    },
    runCapture: async () => {
      calls.push("runCapture");
    },
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
  GAVE_UP,
  checkRail,
  clock,
  ensureChat,
  installRemoteHandlers,
  runPass,
  sendWindowState,
  stopWindowStateFeed,
  windowState,
  railOf,
  asideRows,
  runAct,
  runAsideOp,
  runContext,
  runningNow,
  runProject,
  runSend,
  runSetRail,
} from "./remoteHandlers";

beforeEach(() => {
  calls.length = 0;
  claims.length = 0;
  Object.assign(fake.app, {
    busy: false,
    connecting: false,
    activeSessionId: "c1",
    project: { id: "p1" },
    events: [{ event: "user_message", text: "hi" }],
    error: null,
    toasts: [],
    connection: { engine: "claude-code" },
    asides: [],
    dreaming: false,
    capturing: false,
  });
  fake.stash.clear();
  Object.assign(fake.app, { limitPause: null, limitResumeAt: null, palette: "A", dreamActivity: "" });
  Object.assign(fake.knobs, { claim: true, resume: "now", passToast: "dream: consolidated 2 observations", sendOut: "sent" });
  stopWindowStateFeed();
  fake.aside.finish.length = 0;
  fake.aside.cancelled.length = 0;
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

describe("the Context page from the phone", () => {
  it("carries each editable layer's file text beside the layers (2B's patch note)", async () => {
    const r = (await runContext("c1", null)) as { layers: { off: unknown[]; sources: Record<string, string | null> } };
    expect(r.layers.off).toEqual([]);
    expect(r.layers.sources.user_memory).toBe("# memory file");
    expect(Object.keys(r.layers.sources).length).toBeGreaterThan(1);
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

  it("a message said aloud in voice mode goes marked spoken (wave 3)", async () => {
    expect(await runSend({ id: 1, chat: "c1", text: "what's the weather", spoken: true })).toBe("sent");
    expect(calls).toEqual(["remoteSend c1 what's the weather spoken"]);
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

describe("an aside from the phone (wave 2, 2A)", () => {
  it("asks as the composer does, answers at once, and tells the end", async () => {
    const told: unknown[] = [];
    const r = await runAsideOp("c7", null, { text: " why? " }, (e) => told.push(e));
    expect(calls).toContain("open c7");
    expect(r.chat).toBe("c7");
    expect(r.seq).toBe(fake.aside.seq);
    expect(fake.app.asides.map((x) => x.id)).toEqual([r.thread]);
    expect(told).toEqual([]);
    fake.aside.finish.shift()!();
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(told[0]).toEqual({ kind: "done", chat: "c7", thread: r.thread, seq: r.seq, answer: "answer to why?", is_error: false, cost_usd: null });
  });

  it("a named thread is its card's reply box; one still answering is refused", async () => {
    const first = await runAsideOp("c1", null, { text: "one" }, () => {});
    await expect(runAsideOp("c1", null, { text: "two", thread: first.thread }, () => {})).rejects.toThrow(/still answering/);
    fake.aside.finish.shift()!();
    await vi.waitFor(() => expect(fake.app.asides[0]!.turns[0]!.answer).not.toBeNull());
    const second = await runAsideOp("c1", null, { text: "two", thread: first.thread }, () => {});
    expect(second.thread).toBe(first.thread);
    expect(fake.app.asides[0]!.turns.map((t) => t.question)).toEqual(["one", "two"]);
    await expect(runAsideOp("c1", null, { text: "x", thread: 999 }, () => {})).rejects.toThrow(/not open/);
  });

  it("cancels a running exchange as the card's × does, tells it as an error, and nothing else", async () => {
    const told: { kind: string }[] = [];
    const r = await runAsideOp("c1", null, { text: "long" }, (e) => told.push(e));
    expect(await runAsideOp("c1", null, { cancel: r.seq! })).toEqual({ chat: "c1", thread: r.thread, seq: null });
    expect(fake.aside.cancelled).toEqual([r.seq]);
    await expect(runAsideOp("c1", null, { cancel: r.seq! })).rejects.toThrow(/not answering/);
    fake.aside.finish.shift()!();
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(told[0]).toMatchObject({ kind: "error", seq: r.seq, cancelled: true, error: "the aside was cancelled" });
  });

  it("is refused in words off Claude Code, and with no question", async () => {
    await expect(runAsideOp("c1", null, { text: "  " })).rejects.toThrow(/needs a question/);
    fake.app.connection = { engine: "api" };
    await expect(runAsideOp("c1", null, { text: "q" })).rejects.toThrow(/Claude Code engine/);
    expect(fake.app.asides).toEqual([]);
  });

  it("lists the exchanges newest last — Past first, then the open cards; no drafts; opens nothing", async () => {
    fake.app.asides.push({ id: 1, quote: { text: "passage" }, draft: false, anchor: null, turns: [{ seq: 4, question: "q", partial: "so f", answer: null, error: null, cancelled: false, cacheRead: 0 }] });
    fake.app.asides.push({ id: 2, quote: { text: "p2" }, draft: true, anchor: null, turns: [] });
    expect(asideRows("c1")).toEqual([
      { thread: null, key: "k1", open: false, name: "Old", quote: null, seq: null, question: "q0", answer: "a0", error: null, cancelled: false, asking: false, at: new Date(5).toISOString() },
      { thread: 1, key: null, open: true, name: null, quote: "passage", seq: 4, question: "q", answer: "so f", error: null, cancelled: false, asking: true, at: null },
    ]);
    expect(calls.some((c) => c.startsWith("open"))).toBe(false);
  });

  it("Running tasks names every exchange still asking, in any chat", async () => {
    await runAsideOp("c1", null, { text: "here" }, () => {});
    fake.stash.set("c2", [{ id: 9, quote: null, draft: false, anchor: null, turns: [{ seq: 50, question: "there", partial: "", answer: null, error: null, cancelled: false, cacheRead: 0 }] }]);
    fake.app.dreaming = true;
    const r = runningNow() as { asides: { chat: string; question: string }[]; dream: unknown; capture: unknown };
    expect(r.asides.map((x) => `${x.chat} ${x.question}`)).toEqual(["c1 here", "c2 there"]);
    expect(r.dream).toEqual({ running: true });
    expect(r.capture).toBeNull();
  });

  it("the listener answers through remote_done, and the end goes out as aside-event", async () => {
    await installRemoteHandlers();
    fake.listeners.get("remote-aside")!({ payload: { id: 21, chat: "c1", project: null, aside: { text: "hm" } } });
    fake.listeners.get("remote-asides")!({ payload: { id: 22, chat: "c1" } });
    await vi.waitFor(() => expect(calls.filter((c) => c.startsWith("invoke remote_done"))).toHaveLength(2));
    const done = calls.filter((c) => c.startsWith("invoke remote_done"));
    expect(done).toContainEqual(expect.stringContaining('"id":21,"ok":true,"json":{"chat":"c1","thread"'));
    expect(done).toContainEqual(expect.stringContaining('"id":22,"ok":true'));
    fake.aside.finish.shift()!();
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith('emit aside-event {"kind":"done"'))).toBe(true));
  });
});

// ---- wave 5 (wave 3 B1): 132 (a–d), the pause, Dream/Capture, the window state ----

describe("a call the phone stopped waiting for (132 (d))", () => {
  it("a window answering after the deadline starts no turn", async () => {
    fake.knobs.claim = false;
    await expect(runSend({ id: 41, chat: "c1", text: "late" })).rejects.toThrow(GAVE_UP);
    expect(claims).toContain(41);
    expect(calls.some((c) => c.startsWith("remoteSend"))).toBe(false);
    await expect(runSend({ id: 42, chat: null, text: "late", new: true })).rejects.toThrow(GAVE_UP);
    await expect(runAct("c1", null, { op: "fork", upto: 0 }, 43)).rejects.toThrow(GAVE_UP);
    await expect(runAct("c5", null, { op: "delete" }, 44)).rejects.toThrow(GAVE_UP);
    await expect(runAct("c1", null, { op: "edit", index: 0, text: "x", mode: "send" }, 45)).rejects.toThrow(GAVE_UP);
    expect(calls.filter((c) => /^(remoteSend|delete|editMessage)/.test(c))).toEqual([]);
    expect(fake.app.activeSessionId).toBe("c1");
  });

  it("a claimed call goes ahead as before", async () => {
    expect(await runSend({ id: 46, chat: "c1", text: "on time" })).toBe("sent");
    expect(calls).toContain("remoteSend c1 on time");
  });

  it("the listener passes the call's id to the claim", async () => {
    await installRemoteHandlers();
    fake.knobs.claim = false;
    fake.listeners.get("remote-act")!({ payload: { id: 47, chat: "c1", project: null, action: { op: "fork", upto: 0 } } });
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith("invoke remote_done"))).toBe(true));
    expect(claims).toContain(47);
    expect(calls.find((c) => c.startsWith("invoke remote_done"))).toContain('"ok":false');
  });
});

describe("open on the Mac is answered (132 (a))", () => {
  it("opens, or says why not", async () => {
    await installRemoteHandlers();
    fake.listeners.get("remote-open")!({ payload: { id: 50, chat: "c2", project: null } });
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith("invoke remote_done"))).toBe(true));
    expect(calls).toContain('invoke remote_done {"id":50,"ok":true,"json":{"chat":"c2"}}');
    calls.length = 0;
    fake.app.busy = true;
    fake.listeners.get("remote-open")!({ payload: { id: 51, chat: "c3", project: null } });
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith("invoke remote_done"))).toBe(true));
    expect(calls.find((c) => c.startsWith("invoke remote_done"))).toContain('"id":51,"ok":false');
    expect(calls).not.toContain("open c3");
  });
});

describe("resume after the usage limit from the phone (132 (b))", () => {
  const pause = (session: string) => ({ session, resetsAtMs: Date.UTC(2026, 8, 30, 22, 42), window: "five_hour", text: "You've hit your session limit", subagents: [], hitAtMs: 0 });

  it("is refused when nothing in this chat is paused", async () => {
    await expect(runAct("c1", null, { op: "resume_limit" })).rejects.toThrow(/nothing in this chat is paused/);
    fake.app.limitPause = pause("c2");
    await expect(runAct("c1", null, { op: "resume_limit" })).rejects.toThrow(/nothing in this chat is paused/);
    expect(calls).not.toContain("resume");
  });

  it("resumes at once after the reset", async () => {
    fake.app.limitPause = pause("c1");
    const r = await runAct("c1", null, { op: "resume_limit" });
    expect(r.note).toBe("resumed");
    expect(calls).toContain("resume");
  });

  it("before the reset it is scheduled, and a second press says so without cancelling it", async () => {
    fake.app.limitPause = pause("c1");
    fake.knobs.resume = "schedule";
    const r = await runAct("c1", null, { op: "resume_limit" });
    expect(r.note).toMatch(/^scheduled for \d{1,2}:\d\d [AP]M, 30 s after the window resets$/);
    calls.length = 0;
    const again = await runAct("c1", null, { op: "resume_limit" });
    expect(again.note).toBe(`already scheduled for ${clock(fake.app.limitResumeAt!)}`);
    expect(calls).not.toContain("resume");
    expect(fake.app.limitResumeAt).not.toBeNull();
  });

  it("a resume the Mac refuses is the Mac's sentence", async () => {
    fake.app.limitPause = pause("c1");
    fake.knobs.resume = "refuse";
    await expect(runAct("c1", null, { op: "resume_limit" })).rejects.toThrow(/not open or is busy/);
  });
});

describe("edit and send says when its send was queued (132 (c))", () => {
  it("a sent edit has no note; a queued one says so", async () => {
    const sent = await runAct("c1", null, { op: "edit", index: 0, text: "again", mode: "send" });
    expect(sent.note).toBeUndefined();
    fake.knobs.sendOut = "queued";
    const queued = await runAct("fork-2", null, { op: "edit", index: 0, text: "again", mode: "send" });
    expect(queued.note).toMatch(/^queued/);
  });
});

describe("Dream and Capture from the phone (wave 5)", () => {
  it("starts, answers at once, and tells the end with the Mac's toast", async () => {
    expect(await runPass("dream")).toEqual({ status: "started" });
    expect(calls).toContain("runDream");
    await vi.waitFor(() => expect(calls.some((c) => c.includes('"state":"done"'))).toBe(true));
    expect(calls).toContain('emit pass-event {"kind":"dream","state":"started","text":null}');
    expect(calls).toContain('emit pass-event {"kind":"dream","state":"done","text":"dream: consolidated 2 observations"}');
  });

  it("a failed pass goes out as failed", async () => {
    fake.knobs.passToast = "dream failed: no provider";
    await runPass("dream");
    await vi.waitFor(() => expect(calls.some((c) => c.includes('"state":"failed"'))).toBe(true));
  });

  it("is refused while either runs (one lock)", async () => {
    fake.app.dreaming = true;
    await expect(runPass("capture")).rejects.toThrow("a dream is already running");
    fake.app.dreaming = false;
    fake.app.capturing = true;
    await expect(runPass("dream")).rejects.toThrow("a capture is already running");
    expect(calls.filter((c) => c.startsWith("run"))).toEqual([]);
  });

  it("the listener answers through remote_done", async () => {
    await installRemoteHandlers();
    fake.listeners.get("remote-pass")!({ payload: { id: 60, kind: "capture" } });
    await vi.waitFor(() => expect(calls.some((c) => c.startsWith("invoke remote_done"))).toBe(true));
    expect(calls).toContain('invoke remote_done {"id":60,"ok":true,"json":{"status":"started"}}');
  });
});

describe("what the window tells remote.rs (palette 577, the pause 164)", () => {
  it("maps the pause to Unix seconds and the scheduled resume beside it", () => {
    expect(windowState()).toEqual({ palette: "A", limit_pause: null });
    fake.app.palette = "C";
    fake.app.limitPause = { session: "c1", resetsAtMs: 1_789_714_200_000, window: "five_hour", text: "t", subagents: ["toolu_a"], hitAtMs: 0 };
    fake.app.limitResumeAt = 1_789_714_230_000;
    expect(windowState()).toEqual({
      palette: "C",
      limit_pause: { chat: "c1", resets_at: 1_789_714_200, window: "five_hour", text: "t", subagents: ["toolu_a"], resume_at: 1_789_714_230 },
    });
  });

  it("sends only when something changed", () => {
    sendWindowState();
    sendWindowState();
    expect(calls.filter((c) => c.startsWith("emit remote-window-state"))).toHaveLength(1);
    fake.app.palette = "B";
    sendWindowState();
    expect(calls.filter((c) => c.startsWith("emit remote-window-state"))).toHaveLength(2);
    expect(calls.at(-1)).toBe('emit remote-window-state {"palette":"B","limit_pause":null}');
  });
});
