import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Part 2's harness over a mocked pty (item 503): the real terminal store, the
 * real queue and the real router, with `api` and the Tauri event bus stood in
 * for. Four runs: passing, failing, never-ending, mid-turn; then the routing.
 * Numbers are in the 503 report.
 */
const h = vi.hoisted(() => ({
  listeners: {} as Record<string, (e: { payload: unknown }) => void>,
  nextId: 100,
  run: [] as { cwd: string; command: string }[],
  written: [] as [number, string][],
  closed: [] as number[],
  transcripts: {} as Record<string, unknown[] | "running">,
  sendAgent: [] as { text: string; chat: unknown }[],
  /** Printed before `terminal_run` answers, as a `true` can. */
  before: null as null | ((id: number) => void),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    h.listeners[name] = fn;
    return () => {};
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "terminal_run": {
        const id = h.nextId++;
        h.run.push({ cwd: args.cwd as string, command: args.command as string });
        h.before?.(id);
        return { id, pid: 1, shell: "zsh", cwd: args.cwd };
      }
      case "terminal_write":
        h.written.push([args.id as number, args.data as string]);
        return null;
      case "terminal_close":
        h.closed.push(args.id as number);
        return null;
      case "transcript": {
        const t = h.transcripts[args.chat as string];
        if (t === "running") throw "the chat is running a turn";
        return t ?? [];
      }
      case "send_agent":
        h.sendAgent.push({ text: args.text as string, chat: args.chat });
        return { delivered: [] };
      default:
        return null;
    }
  },
  convertFileSrc: (s: string) => s,
}));

const { app } = await import("./state.svelte");
const store = await import("./state.svelte");
const { initTerminalEvents, term } = await import("./terminal.svelte");
const { runBlock, sendSoFar, stopRun, STOP_GRACE_MS } = await import("./shellRun.svelte");
const { enqueueMessage, readDraft, drafts, requeueFront, shiftQueue } = await import("./drafts.svelte");
const { parseRan } = await import("./shellRun");

await initTerminalEvents();
// No DOM here: the store's first-grid estimate reads the window's width.
(globalThis as { window?: unknown }).window ??= { innerWidth: 1440 };
const data = (id: number, text: string) =>
  h.listeners["terminal-data"]({ payload: { id, data: btoa(unescape(encodeURIComponent(text))) } });
const exit = (id: number, code: number | null, signal: string | null = null) =>
  h.listeners["terminal-exit"]({ payload: { id, code, signal } });

/** Everything the chat's queue holds, read back as cards. */
const queued = (chat: string) => readDraft(chat).queue.map((q) => parseRan(q.text));
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.run.length = 0;
  h.written.length = 0;
  h.closed.length = 0;
  h.sendAgent.length = 0;
  h.before = null;
  h.transcripts = { a: [{ event: "session_created" }], b: [{ event: "session_created" }] };
  for (const k of Object.keys(drafts)) delete drafts[k];
  term.shells.length = 0;
  for (const k of Object.keys(term.docks)) delete term.docks[k];
  term.pane = null;
  app.activeSessionId = "a";
  app.busy = false;
  app.parked = null;
  app.background = {};
  app.sessions = [{ id: "a", title: "Chat A" }, { id: "b", title: "Chat B" }] as never;
  app.connection = { engine: "claude-code" } as never;
  app.project = { id: "p1", name: "P", root: "/work", exists: true } as never;
  app.tabs.panes[0].tabs[0].content = { kind: "chat", session: "a" } as never;
});

describe("503 harness: a passing command", () => {
  it("opens a tab in the chat's folder, and the chat gets command, code and clean output", async () => {
    const drained: string[] = [];
    const off = store.registerRunDrain(async () => void drained.push(shiftQueue("a")?.text ?? ""));
    const row = await runBlock("echo hi", { chat: "a" });
    expect(h.run).toEqual([{ cwd: "/work", command: "echo hi" }]);
    expect(row?.run?.title).toBe("echo hi");
    expect(term.docks[row!.pane!].active).toBe(row!.id);
    data(row!.id, "\x1b[32mhi\x1b[0m\r\n");
    exit(row!.id, 0);
    await settle();
    expect(drained).toHaveLength(1);
    expect(parseRan(drained[0])).toEqual({ command: "echo hi", status: "exit 0", output: "hi" });
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toBe("Sent to this chat.");
    off();
  });
  it("a block that ends before terminal_run answers is still delivered, whole", async () => {
    h.before = (id) => {
      data(id, "fast\r\n");
      exit(id, 0);
    };
    await runBlock("true", { chat: "a" });
    await settle();
    expect(queued("a")).toEqual([{ command: "true", status: "exit 0", output: "fast" }]);
  });
});

describe("503 harness: a failing command", () => {
  it("carries its code", async () => {
    const row = await runBlock("false", { chat: "a" });
    data(row!.id, "nope\r\n");
    exit(row!.id, 3);
    await settle();
    expect(queued("a")[0]).toMatchObject({ status: "exit 3", output: "nope" });
    expect(term.shells.find((s) => s.id === row!.id)?.exit?.code).toBe(3);
  });
});

describe("503 harness: a never-ending command", () => {
  it("Send output so far goes and the block runs on; its end sends only what came after", async () => {
    const row = await runBlock("npm run dev", { chat: "a" });
    data(row!.id, "listening\r\n");
    await sendSoFar(row!.id);
    expect(queued("a")[0]).toMatchObject({ status: "still running, output so far", output: "listening" });
    expect(term.shells.find((s) => s.id === row!.id)?.exit).toBeNull();
    data(row!.id, "request 1\r\n");
    exit(row!.id, 0);
    await settle();
    expect(queued("a")[1]).toMatchObject({ status: "exit 0", output: "request 1" });
  });
  it("Stop sends ⌃C, then what ran with stopped by you, and the tab stays", async () => {
    const row = await runBlock("npm run dev", { chat: "a" });
    data(row!.id, "up\r\n");
    await stopRun(row!.id);
    expect(h.written).toEqual([[row!.id, "\u0003"]]);
    exit(row!.id, 130);
    await settle();
    expect(queued("a")[0]).toMatchObject({ status: "stopped by you", output: "up" });
    expect(term.shells.some((s) => s.id === row!.id)).toBe(true);
    expect(h.closed).toEqual([]);
  });
  it("a program that ignores ⌃C is killed past the grace, once, and still sent", async () => {
    vi.useFakeTimers();
    try {
      const row = await runBlock("vim", { chat: "a" });
      data(row!.id, "stuck\r\n");
      await stopRun(row!.id);
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS + 10);
      expect(h.closed).toEqual([row!.id]);
      expect(queued("a")).toHaveLength(1);
      expect(queued("a")[0]).toMatchObject({ status: "stopped by you", output: "stuck" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("503 harness: mid-turn", () => {
  it("a running turn: it joins that chat's queue, and no second turn starts", async () => {
    const row = await runBlock("ls", { chat: "a" });
    app.busy = true;
    data(row!.id, "x\r\n");
    exit(row!.id, 0);
    await settle();
    expect(queued("a")).toHaveLength(1);
    expect(h.sendAgent).toEqual([]);
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toBe("Queued for the running turn.");
  });
});

describe("503 harness: the source chat, never the open one", () => {
  it("switched to another chat: sent there by id, in the background", async () => {
    const row = await runBlock("ls", { chat: "a" });
    app.activeSessionId = "b";
    data(row!.id, "x\r\n");
    exit(row!.id, 0);
    await settle();
    await settle();
    expect(readDraft("b").queue).toHaveLength(0);
    expect(h.sendAgent).toHaveLength(1);
    expect(h.sendAgent[0].chat).toBe("a");
    expect(parseRan(h.sendAgent[0].text)?.command).toBe("ls");
    // The background turn it started is not this suite's to finish.
    delete app.background.a;
  });
  it("the source chat is running off screen: held in its queue, not the open chat's", async () => {
    const row = await runBlock("ls", { chat: "a" });
    app.activeSessionId = "b";
    app.background.a = {} as never;
    exit(row!.id, 0);
    await settle();
    expect(readDraft("b").queue).toHaveLength(0);
    expect(queued("a")).toHaveLength(1);
    expect(h.sendAgent).toEqual([]);
  });
  it("deleted meanwhile: sent nowhere, and the tab says so", async () => {
    const row = await runBlock("ls", { chat: "a" });
    app.sessions = app.sessions.filter((c) => c.id !== "a");
    app.activeSessionId = "b";
    data(row!.id, "x\r\n");
    exit(row!.id, 0);
    await settle();
    expect(queued("a")).toHaveLength(0);
    expect(queued("b")).toHaveLength(0);
    expect(h.sendAgent).toEqual([]);
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toContain("gone");
  });
  it("the same deleted chat, held open by nothing, even with a log read as empty: no read at all", async () => {
    const row = await runBlock("ls", { chat: "a" });
    const reads = vi.spyOn(await import("./api"), "transcript");
    exit(row!.id, 0);
    await settle();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
  });
  it("a chat mid-turn refuses the read, and counts as there", async () => {
    const row = await runBlock("ls", { chat: "a" });
    h.transcripts.a = "running";
    app.busy = true;
    exit(row!.id, 0);
    await settle();
    expect(queued("a")).toHaveLength(1);
  });
  it("an API-engine chat off screen waits in its own queue", async () => {
    app.connection = { engine: "api" } as never;
    const row = await runBlock("ls", { chat: "a" });
    app.activeSessionId = "b";
    exit(row!.id, 0);
    await settle();
    expect(queued("a")).toHaveLength(1);
    expect(h.sendAgent).toEqual([]);
  });
});

describe("503 harness: the tab", () => {
  it("is not reopened as a shell after a relaunch; a click on its end does not restart it", async () => {
    const { restartsOnClick } = await import("./terminal");
    const row = await runBlock("ls", { chat: "a" });
    exit(row!.id, 1);
    await settle();
    expect(restartsOnClick(term.shells.find((s) => s.id === row!.id)!)).toBe(false);
  });
  it("closing it while it runs sends nothing", async () => {
    const { closeShell } = await import("./terminal.svelte");
    const row = await runBlock("sleep 9", { chat: "a" });
    closeShell(row!.id);
    await settle();
    expect(queued("a")).toHaveLength(0);
    expect(h.closed).toEqual([row!.id]);
  });
});

describe("503: Agent commands tabs", () => {
  it("one per chat, no pty, and closing one closes nothing", async () => {
    const { closeShell, openAgentTab } = await import("./terminal.svelte");
    const a = openAgentTab("a");
    const again = openAgentTab("a");
    expect(again.id).toBe(a.id);
    expect(a.id).toBeLessThan(0);
    expect(openAgentTab("b").id).not.toBe(a.id);
    closeShell(a.id);
    expect(h.closed).toEqual([]);
  });
});

describe("503 review 3: an aside of a chat that is not open", () => {
  it("the owning chat comes from the caller, not the open chat", async () => {
    const src = (await import("./AsideThread.svelte?raw")).default;
    expect(src).not.toContain("chat: app.activeSessionId");
    expect((await import("./AsideView.svelte?raw")).default).toContain("<AsideThread {aside} {open} owner={session} />");
    expect((await import("./AsideCard.svelte?raw")).default).toContain("<AsideThread {aside} open={!readOnly} {owner} />");
  });
  it("an aside no longer found keeps the output in the tab, and the chat's line gets nothing", async () => {
    const row = await runBlock("ls", { chat: "b", aside: 999 });
    data(row!.id, "x\r\n");
    exit(row!.id, 0);
    await settle();
    expect(queued("a")).toHaveLength(0);
    expect(queued("b")).toHaveLength(0);
    expect(h.sendAgent).toEqual([]);
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toContain("aside");
  });
});

describe("503 review 4: a project switch while it runs", () => {
  it("the chat is in the other project, and is sent there by id, not called gone", async () => {
    const row = await runBlock("ls", { chat: "a" });
    app.project = { id: "p2", name: "Q", root: "/q", exists: true } as never;
    app.sessions = [{ id: "q1", title: "Other" }] as never;
    app.activeSessionId = "q1";
    h.transcripts.a = [];
    data(row!.id, "x\r\n");
    exit(row!.id, 0);
    await settle();
    await settle();
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).not.toContain("gone");
    expect(h.sendAgent.map((s) => s.chat)).toEqual(["a"]);
    delete app.background.a;
  });
});

describe("503 review 5: what he held stays held", () => {
  it("the chat on screen: no drain, his row first, the output behind it", async () => {
    let drains = 0;
    const off = store.registerRunDrain(async () => void drains++);
    const row = await runBlock("ls", { chat: "a" });
    enqueueMessage("a", "held after a Stop", []);
    exit(row!.id, 0);
    await settle();
    expect(drains).toBe(0);
    expect(readDraft("a").queue.map((q) => q.text)[0]).toBe("held after a Stop");
    expect(queued("a")[1]).toMatchObject({ command: "ls" });
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toContain("Waiting");
    off();
  });
  it("a chat off screen: nothing leaves for it", async () => {
    const row = await runBlock("ls", { chat: "a" });
    enqueueMessage("a", "held", []);
    app.activeSessionId = "b";
    exit(row!.id, 0);
    await settle();
    await settle();
    expect(h.sendAgent).toEqual([]);
    expect(readDraft("a").queue.map((q) => q.text)[0]).toBe("held");
    expect(readDraft("a").queue).toHaveLength(2);
  });
});

describe("503 review 7: Send output so far with nothing new", () => {
  it("a double click sends once; the tab says why the second did nothing", async () => {
    const row = await runBlock("npm run dev", { chat: "a" });
    data(row!.id, "up\r\n");
    await Promise.all([sendSoFar(row!.id), sendSoFar(row!.id)]);
    expect(queued("a")).toHaveLength(1);
    await sendSoFar(row!.id);
    expect(queued("a")).toHaveLength(1);
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toContain("Nothing new");
  });
});

describe("503 review 9: the tab says what truly happened", () => {
  it("a drain that took nothing (a busy engine, no composer): waiting, never Sent", async () => {
    const off = store.registerRunDrain(async () => {});
    const row = await runBlock("ls", { chat: "a" });
    exit(row!.id, 0);
    await settle();
    expect(queued("a")).toHaveLength(1);
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toContain("Waiting");
    off();
  });
  it("no composer at all: the same", async () => {
    const row = await runBlock("ls", { chat: "a" });
    exit(row!.id, 0);
    await settle();
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toContain("Waiting");
  });
  it("a drain that takes the row: Sent, while the turn it started still runs", async () => {
    let end = () => {};
    const off = store.registerRunDrain(() => {
      shiftQueue("a");
      return new Promise<void>((r) => (end = r));
    });
    const row = await runBlock("ls", { chat: "a" });
    exit(row!.id, 0);
    await settle();
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toBe("Sent to this chat.");
    end();
    off();
  });
  it("a send that fails and gives the row back: waiting again", async () => {
    let fail = () => {};
    const off = store.registerRunDrain(async () => {
      const q = shiftQueue("a")!;
      await new Promise<void>((r) => (fail = r));
      requeueFront("a", q);
    });
    const row = await runBlock("ls", { chat: "a" });
    exit(row!.id, 0);
    await settle();
    fail();
    await settle();
    await settle();
    expect(term.shells.find((s) => s.id === row!.id)?.run?.note).toContain("Waiting");
    off();
  });
});

describe("503 review 11: Agent commands tabs across a relaunch", () => {
  it("the restore writes nothing, so a second dock's entry survives the first's", async () => {
    const { openAgentTab } = await import("./terminal.svelte");
    const store_: Record<string, string> = {};
    const was = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store_[k] ?? null,
      setItem: (k: string, v: string) => void (store_[k] = v),
    };
    openAgentTab("a", null, false, false);
    expect(Object.keys(store_)).toEqual([]);
    openAgentTab("b", null, false);
    expect(Object.keys(store_)).toHaveLength(1);
    (globalThis as { localStorage?: unknown }).localStorage = was;
  });
});

describe("503 review 6 and 12: the Agent commands tab's source", () => {
  it("draws nothing while it has no record to draw (6), and takes the focus it is asked for (12)", async () => {
    const src = (await import("./AgentTerminal.svelte?raw")).default;
    expect(src).toContain("if (!held && !disk) return;");
    expect(src).toContain("xterm?.focus()");
  });
});
