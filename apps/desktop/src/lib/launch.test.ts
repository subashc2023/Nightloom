import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionWord, launch, launchMessage, runLaunch, type LaunchSteps } from "./launch.svelte";

/**
 * Item 220 (2026-09-26): the app opened to an empty window saying "not
 * connected" for 7–86 s while `init` reopened the last project, read the
 * lists one after another and only then connected.
 */

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function steps(over: Partial<LaunchSteps> = {}): LaunchSteps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    listProjects: async () => void log.push("list"),
    lastProject: () => ({ id: "p1", name: "Value Generalization" }),
    openProject: async () => void log.push("open"),
    forgetLastProject: () => void log.push("forget"),
    newSession: async () => void log.push("newSession"),
    connect: async () => void log.push("connect"),
    reads: [],
    after: async () => void log.push("after"),
    mark: () => {},
    now: () => Date.now(),
    ...over,
  };
}

describe("the launch screen (item 220)", () => {
  afterEach(() => vi.useRealTimers());

  it("stays up until the list is read and the last project has reopened", async () => {
    const list = deferred();
    const open = deferred();
    const s = steps({ listProjects: () => list.promise, openProject: () => open.promise });
    const done = runLaunch(s);
    expect(launch.opening).toBe(true);
    list.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(launch.opening).toBe(true);
    expect(launchMessage(launch.project)).toBe("Opening Value Generalization…");
    open.resolve();
    await done;
    expect(launch.opening).toBe(false);
  });

  it("comes down at the deadline when the reopen hangs, and the connect still waits for it", async () => {
    vi.useFakeTimers();
    const open = deferred();
    const s = steps({ openProject: () => open.promise });
    const done = runLaunch(s, 15_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(launch.opening).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(launch.opening).toBe(false);
    // The project decides the workspace: no connect before it is open.
    expect(s.log).not.toContain("connect");
    open.resolve();
    await done;
    expect(s.log).toContain("connect");
  });

  it("forgets a last project that cannot be opened and launches anyway", async () => {
    const s = steps({ openProject: () => Promise.reject("folder gone") });
    await runLaunch(s);
    expect(s.log).toContain("forget");
    expect(s.log).toContain("connect");
    expect(launch.opening).toBe(false);
  });

  it("with no last project, says Opening Nightloom and waits only for the list", async () => {
    const s = steps({ lastProject: () => null });
    const done = runLaunch(s);
    expect(launchMessage(launch.project)).toBe("Opening Nightloom…");
    await done;
    expect(s.log).not.toContain("open");
    expect(launch.opening).toBe(false);
  });
});

describe("the connect runs beside the reads (item 220)", () => {
  it("starts the connect before a slow read has finished", async () => {
    const knowledge = deferred();
    const s = steps({ reads: [["knowledge", () => knowledge.promise]] });
    const done = runLaunch(s);
    await vi.waitFor(() => expect(s.log).toContain("connect"));
    expect(s.log).not.toContain("after");
    knowledge.resolve();
    await done;
    expect(s.log.at(-1)).toBe("after");
  });
});

describe('"not connected" only once it is true (item 220)', () => {
  it("reads connecting… until the launch connect has settled", async () => {
    const connect = deferred();
    const s = steps({ connect: () => connect.promise });
    const done = runLaunch(s);
    const word = () =>
      connectionWord({ connected: false, connecting: false, launchConnectSettled: launch.connectSettled });
    expect(word()).toBe("connecting…");
    await vi.waitFor(() => expect(s.log).toContain("newSession"));
    expect(word()).toBe("connecting…");
    connect.reject("claude not found");
    await done;
    expect(word()).toBe("not connected");
  });

  it("reads connected over everything, and connecting… while a connect runs", () => {
    expect(connectionWord({ connected: true, connecting: true, launchConnectSettled: false })).toBe("connected");
    expect(connectionWord({ connected: false, connecting: true, launchConnectSettled: true })).toBe("connecting…");
    expect(connectionWord({ connected: false, connecting: false, launchConnectSettled: true })).toBe("not connected");
  });
});
