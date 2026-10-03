import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  app,
  applyDraft,
  chatChoice,
  saveNote,
  showMadeChat,
  switchModel,
  syncPromptLayers,
  windowFromInit,
} from "./state.svelte";
import { CHAT_CHOICE_KEY } from "./chatChoice";
import * as api from "./api";

/**
 * Three bugs he hit on 2026-09-25 (nightshift backlog 211, 214, 216), driven
 * through the functions the UI calls with the backend mocked.
 */
const never = () => new Promise<never>(() => {});

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  saveNote: vi.fn(async (_scope: string, name: string) => ({
    name,
    bytes: 5,
    modified: "2026-09-25T20:05:00Z",
    summary: null,
  })),
  // The listings hang, as an iCloud folder's did after sleep.
  listNotes: vi.fn(() => never()),
  listProjects: vi.fn(() => never()),
  listProposals: vi.fn(async () => []),
  contextLimits: vi.fn(async (_p: string, models: string[]) =>
    models.map((m) => (m.startsWith("claude-opus-5") ? 1_000_000 : null)),
  ),
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
  connectAgent: vi.fn(async (args: { model?: string }) => ({
    provider: "claude-code",
    model: args.model ?? "",
    workspace: "/tmp",
  })),
  planUsage: vi.fn(async () => {
    throw new Error("not in the test");
  }),
}));

function lastAgentModel(): string | undefined {
  const calls = vi.mocked(api.connectAgent).mock.calls;
  return calls[calls.length - 1]?.[0].model;
}

describe("Save acknowledges when the write returns (backlog 211)", () => {
  beforeEach(() => {
    app.busy = false;
    app.connecting = false;
    app.connection = null;
    app.project = { id: "p" } as typeof app.project;
    app.notes = [];
    app.vault = [];
  });

  it("returns true with the listings hung, and the note is on the list already", async () => {
    const done = await Promise.race([
      saveNote("project", "plan.md", "hello"),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 200)),
    ]);
    expect(done).toBe(true);
    expect(app.notes.map((n) => n.name)).toEqual(["plan.md"]);
  });

  it("a save to the vault lands on the vault's list", async () => {
    expect(await saveNote("knowledge", "idea.md", "x")).toBe(true);
    expect(app.vault.map((n) => n.name)).toEqual(["idea.md"]);
  });

  it("a model's file saved with a connection does not wait for the reconnect", async () => {
    vi.mocked(api.connectAgent).mockImplementationOnce(() => never());
    app.connection = { engine: "claude-code" } as typeof app.connection;
    app.draft.engine = "claude-code";
    const done = await Promise.race([
      saveNote("models", "opus.md", "be brief"),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 200)),
    ]);
    expect(done).toBe(true);
    app.connecting = false;
  });
});

describe("a New chat's row appears as its turn starts (backlog 211)", () => {
  beforeEach(() => {
    app.sessions = [];
    app.activeSessionId = null;
    app.pendingMode = "normal";
    app.pendingKind = "build";
    app.events = [{ event: "user_message", text: "What is value generalization?", at: "2026-09-25T20:20:00Z" }];
  });

  it("shows the row from what was sent", () => {
    app.busy = true;
    showMadeChat("162d1dc8");
    expect(app.sessions[0]).toMatchObject({ id: "162d1dc8", first_user: "What is value generalization?" });
    showMadeChat("162d1dc8"); // a second event adds no second row
    expect(app.sessions.length).toBe(1);
    app.busy = false;
  });

  it("adds nothing for a chat already open, or with no turn running", () => {
    app.busy = false;
    showMadeChat("a");
    app.busy = true;
    app.activeSessionId = "open";
    showMadeChat("b");
    expect(app.sessions).toEqual([]);
    app.busy = false;
  });
});

describe("the pickers take a pick during a turn (backlog 214)", () => {
  beforeEach(async () => {
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
    app.draft.agentModel = "sonnet";
    app.connection = null;
    app.activeSessionId = "a";
    await syncPromptLayers();
    await applyDraft();
  });

  it("a pick while a turn runs connects nothing then, and the next turn's connect carries it", async () => {
    app.busy = true;
    const before = vi.mocked(api.connectAgent).mock.calls.length;
    await switchModel("opus");
    expect(app.draft.agentModel).toBe("opus");
    expect(vi.mocked(api.connectAgent).mock.calls.length).toBe(before); // the running turn is left alone
    app.busy = false;
    await syncPromptLayers(); // the effect's re-run at the turn's end
    expect(lastAgentModel()).toBe("opus");
  });

  it("a pick during a chat switch's connect is not lost", async () => {
    app.connecting = true;
    await switchModel("haiku");
    app.connecting = false;
    await syncPromptLayers();
    expect(lastAgentModel()).toBe("haiku");
  });

  it("the pick stays the chat's when he switches away and back before the turn ends", async () => {
    app.busy = true;
    await switchModel("opus");
    app.activeSessionId = "b";
    await syncPromptLayers();
    app.activeSessionId = "a";
    await syncPromptLayers();
    expect(app.draft.agentModel).toBe("opus");
    app.busy = false;
    await syncPromptLayers();
    expect(lastAgentModel()).toBe("opus");
  });
});

describe("the window from the id the CLI names (backlog 216)", () => {
  it("an init line's model fills an unknown window", async () => {
    app.connection = { engine: "claude-code", contextLimit: null } as typeof app.connection;
    await windowFromInit("claude-opus-5-5");
    expect(app.connection?.contextLimit).toBe(1_000_000);
  });

  it("a known window is left alone, and an unknown id stays unknown", async () => {
    app.connection = { engine: "claude-code", contextLimit: 200_000 } as typeof app.connection;
    await windowFromInit("claude-opus-5-5");
    expect(app.connection?.contextLimit).toBe(200_000);
    app.connection = { engine: "claude-code", contextLimit: null } as typeof app.connection;
    await windowFromInit("claude-nonesuch");
    expect(app.connection?.contextLimit).toBeNull();
  });
});
