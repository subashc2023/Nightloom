// @vitest-environment happy-dom
/*
 * Item 752 (blocker 2345): the REAL silent-helper notice mounted in a DOM —
 * the confirm, a finish during the confirm, a turn already gone, a talking
 * helper. Never pressed on its own: nothing is invoked without his clicks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

const calls = vi.hoisted(() => [] as { cmd: string; args: Record<string, unknown> }[]);
vi.hoisted(() => {
  (globalThis as { __NIGHTLOOM_PLATFORM__?: string }).__NIGHTLOOM_PLATFORM__ = "macos";
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "restart_subagent") return true;
    throw new Error("no backend");
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

await import("./asides.svelte");
const { app, bgTurns } = await import("./state.svelte");
const SilentHelper = (await import("./SilentHelper.svelte")).default;

const MIN = 60_000;
const swallow = (e: PromiseRejectionEvent) => e.preventDefault?.();
let mounted: Record<string, unknown>[] = [];

function addRow(over: Record<string, unknown> = {}) {
  app.subagents.push({
    tool_use_id: "toolu_1",
    task_id: "a8bb",
    subagent_type: "general-purpose",
    description: "scan the logs",
    prompt: "Read the lo",
    status: "running",
    background: true,
    tokens: 0,
    tool_uses: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    rounds: 0,
    session: "chat-A",
    turn: 0,
    startedAt: Date.now() - 20 * MIN,
    updatedAt: Date.now() - 16 * MIN,
    heardAt: Date.now() - 16 * MIN,
    segments: [],
    ...over,
  } as never);
  return app.subagents[app.subagents.length - 1]!;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}
function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")] as HTMLButtonElement[];
}
function press(label: string): void {
  const b = buttons().find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no ${label} button`);
  b.click();
}

beforeEach(() => {
  calls.length = 0;
  app.subagents = [];
  app.events = [
    {
      event: "assistant_message",
      at: new Date().toISOString(),
      blocks: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { prompt: "Read the logs and report what failed." } }],
    } as never,
  ];
  app.toasts = [];
  bgTurns.clear();
  document.body.innerHTML = "";
  window.addEventListener("unhandledrejection", swallow as never);
});
afterEach(() => {
  for (const c of mounted) unmount(c);
  mounted = [];
  bgTurns.clear();
  window.removeEventListener("unhandledrejection", swallow as never);
});

describe("the silent helper's Restart (item 752)", () => {
  it("says the silence, asks first, then stops that one helper and asks for its relaunch", async () => {
    bgTurns.set("chat-A", { chat: "chat-A", key: "turn-k1", detached: true } as never);
    const row = addRow();
    mounted.push(mount(SilentHelper, { target: document.body, props: { row } }));
    await settle();
    expect(document.body.textContent).toContain("No output for 16 min");
    press("Restart");
    await settle();
    expect(document.body.textContent).toContain("Stop it and launch it again?");
    expect(calls.filter((c) => c.cmd === "restart_subagent")).toHaveLength(0);
    press("Restart");
    await settle();
    const sent = calls.filter((c) => c.cmd === "restart_subagent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args).toMatchObject({ turn: "turn-k1", taskId: "a8bb", session: "chat-A" });
    // The prompt whole, from the call — not the status row's cut copy.
    expect(String(sent[0]!.args.note)).toContain("Read the logs and report what failed.");
    expect(document.body.textContent).toContain("Restarting…");
  });

  it("Cancel leaves it running and sends nothing", async () => {
    bgTurns.set("chat-A", { chat: "chat-A", key: "turn-k1", detached: true } as never);
    const row = addRow();
    mounted.push(mount(SilentHelper, { target: document.body, props: { row } }));
    await settle();
    press("Restart");
    await settle();
    press("Cancel");
    await settle();
    expect(document.body.textContent).not.toContain("Stop it and launch it again?");
    expect(calls.filter((c) => c.cmd === "restart_subagent")).toHaveLength(0);
  });

  it("a helper that finishes during the confirm takes the question with it; nothing is stopped", async () => {
    bgTurns.set("chat-A", { chat: "chat-A", key: "turn-k1", detached: true } as never);
    const row = addRow();
    mounted.push(mount(SilentHelper, { target: document.body, props: { row } }));
    await settle();
    press("Restart");
    await settle();
    row.status = "completed";
    await settle();
    expect(document.body.textContent).not.toContain("Stop it and launch it again?");
    expect(document.body.textContent).not.toContain("No output");
    expect(calls.filter((c) => c.cmd === "restart_subagent")).toHaveLength(0);
  });

  it("a helper that speaks during the confirm takes the question with it", async () => {
    bgTurns.set("chat-A", { chat: "chat-A", key: "turn-k1", detached: true } as never);
    const row = addRow();
    mounted.push(mount(SilentHelper, { target: document.body, props: { row } }));
    await settle();
    press("Restart");
    await settle();
    row.heardAt = Date.now();
    await settle();
    expect(document.body.textContent).not.toContain("Stop it and launch it again?");
    expect(calls.filter((c) => c.cmd === "restart_subagent")).toHaveLength(0);
  });

  it("with its turn gone it says so and sends nothing", async () => {
    const row = addRow();
    mounted.push(mount(SilentHelper, { target: document.body, props: { row } }));
    await settle();
    press("Restart");
    await settle();
    press("Restart");
    await settle();
    expect(calls.filter((c) => c.cmd === "restart_subagent")).toHaveLength(0);
    expect(JSON.stringify(app.toasts)).toContain("its turn has ended");
  });

  it("draws nothing while the helper talks", async () => {
    const row = addRow({ heardAt: Date.now() - 2 * MIN });
    mounted.push(mount(SilentHelper, { target: document.body, props: { row } }));
    await settle();
    expect(document.querySelector('[data-testid="silent-helper"]')).toBeNull();
  });
});
