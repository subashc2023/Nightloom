import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, applyDraft, chatChoice, send, switchModel, syncPromptLayers, useEngine } from "./state.svelte";
import { CHAT_CHOICE_KEY, loadChoices } from "./chatChoice";
import * as api from "./api";

/**
 * Each chat keeps its own model and engine (nightshift backlog 205): the
 * app walk of 2026-09-25 saw ⌘⇧H in a test chat put his Stuart 9 on Haiku,
 * and Provider chosen in chat B turn chat A to it. Driven through the
 * functions the pickers and the chat-switch effect call, with the backend
 * mocked: what matters is which model each connect asks for.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  promptLayers: vi.fn(async () => ({
    off: [],
    built: [],
    edits: {},
    built_edits: {},
    mode: "normal",
    built_mode: "normal",
    kind: "build",
    built_kind: "build",
  })),
  promptPending: vi.fn(async () => null),
  connect: vi.fn(async (args: { provider: string; model?: string }) => ({
    provider: args.provider,
    model: args.model ?? "claude-sonnet-5",
    workspace: "/tmp",
  })),
  connectAgent: vi.fn(async (args: { model?: string }) => ({
    provider: "claude-code",
    model: args.model ?? "",
    workspace: "/tmp",
  })),
  planUsage: vi.fn(async () => {
    throw new Error("not in the test");
  }),
  send: vi.fn(async () => undefined),
  transcript: vi.fn(async () => [{ event: "session_created", id: "made-1", at: "2026-09-25T00:00:00Z" }]),
  openSession: vi.fn(async () => []),
  newSession: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => []),
}));

/** The chat on screen changes, and the effect in `App.svelte` runs. */
async function open(id: string | null): Promise<void> {
  app.activeSessionId = id;
  await syncPromptLayers();
}

function lastAgentModel(): string | undefined {
  const calls = vi.mocked(api.connectAgent).mock.calls;
  return calls[calls.length - 1]?.[0].model;
}

describe("model and engine per chat (backlog 205)", () => {
  beforeEach(async () => {
    vi.mocked(api.connect).mockClear();
    vi.mocked(api.connectAgent).mockClear();
    localStorage.removeItem(CHAT_CHOICE_KEY);
    chatChoice.choices = { default: null, chats: {} };
    chatChoice.ready = true;
    chatChoice.shownFor = undefined;
    chatChoice.reconnect = false;
    app.busy = false;
    app.connecting = false;
    app.connectError = null;
    app.draft.engine = "claude-code";
    app.draft.provider = "anthropic";
    app.draft.model = "claude-haiku-4-5";
    app.draft.agentModel = "sonnet";
    app.connection = null;
    // His Stuart 9 on sonnet, connected, on screen.
    await open("stuart-9");
    await applyDraft();
  });

  it("a pick in one chat leaves the other's model, and switching back restores each", async () => {
    await open("test");
    await switchModel("haiku");
    expect(lastAgentModel()).toBe("haiku");
    await open("stuart-9");
    expect(app.draft.agentModel).toBe("sonnet");
    expect(lastAgentModel()).toBe("sonnet");
    await open("test");
    expect(app.draft.agentModel).toBe("haiku");
    expect(lastAgentModel()).toBe("haiku");
  });

  it("the engine is per chat: Provider in B leaves A on Claude Code", async () => {
    await open("b");
    await useEngine("provider");
    expect(app.connection?.engine).toBe("provider");
    await open("stuart-9");
    expect(app.draft.engine).toBe("claude-code");
    expect(app.connection?.engine).toBe("claude-code");
    await open("b");
    expect(app.draft.engine).toBe("provider");
    expect(app.connection?.engine).toBe("provider");
  });

  it("a New chat takes the default — the latest pick — and never moves a chat", async () => {
    await open("test");
    await switchModel("opus");
    await open(null);
    expect(app.draft.agentModel).toBe("opus");
    await switchModel("haiku");
    await open("stuart-9");
    expect(app.draft.agentModel).toBe("sonnet");
    await open("test");
    expect(app.draft.agentModel).toBe("opus");
  });

  it("a running turn keeps its model: the reconnect waits for the turn's end", async () => {
    await open("test");
    await switchModel("haiku");
    const before = vi.mocked(api.connectAgent).mock.calls.length;
    // A turn runs on screen (the provider engine's parked turn, or an
    // attached Claude Code one); he opens Stuart 9.
    app.busy = true;
    await open("stuart-9");
    expect(app.draft.agentModel).toBe("sonnet"); // the rail shows its model
    expect(vi.mocked(api.connectAgent).mock.calls.length).toBe(before); // no connect under the turn
    app.busy = false;
    await syncPromptLayers(); // the effect's re-run at the turn's end
    expect(lastAgentModel()).toBe("sonnet");
  });

  it("an engine change waits for a running turn entirely", async () => {
    await open("b");
    await useEngine("provider");
    app.busy = true;
    await open("stuart-9");
    expect(app.draft.engine).toBe("provider");
    expect(app.connection?.engine).toBe("provider");
    app.busy = false;
    await syncPromptLayers();
    expect(app.draft.engine).toBe("claude-code");
    expect(app.connection?.engine).toBe("claude-code");
  });

  it("a chat first opened since this item keeps what it shows, whatever is picked after", async () => {
    await open("old"); // no record: shown on the default (sonnet), recorded
    await open("test");
    await switchModel("haiku");
    await open("old");
    expect(app.draft.agentModel).toBe("sonnet");
  });

  it("the choices are written to storage, so a relaunch reads them back", async () => {
    await open("test");
    await switchModel("haiku");
    const stored = loadChoices(localStorage);
    expect(stored.chats["test"]?.agentModel).toBe("haiku");
    expect(stored.chats["stuart-9"]?.agentModel).toBe("sonnet");
  });

  it("a New chat's first turn records the choice for the chat it made (provider engine)", async () => {
    await open(null);
    await useEngine("provider");
    await send("hello");
    expect(chatChoice.choices.chats["made-1"]).toMatchObject({ engine: "provider" });
  });
});
