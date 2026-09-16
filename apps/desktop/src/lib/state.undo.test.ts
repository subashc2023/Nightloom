import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  app,
  deleteSession,
  editContextItems,
  history,
  liveFlags,
  redo,
  removeTurn,
  renameSession,
  rewindTo,
  saveEdit,
  send,
  setPromptLayer,
  setPromptLayerText,
  undo,
  undoLabel,
} from "./state.svelte";
import type { SessionEvent } from "./types";
import * as api from "./api";

/*
 * One inverse per operation (nightshift backlog 064): each undo calls the
 * same backend command the operation used, with the arguments that put
 * things back. The backend is mocked at the `api` seam; every command an
 * operation or its inverse reaches is a `vi.fn` that resolves with a
 * transcript, and the assertions are on what was called with what.
 */

const AT = "2026-01-01T00:00:00Z";
const created: SessionEvent = { event: "session_created", id: "chat-1", at: AT };
const user = (text: string): SessionEvent => ({ event: "user_message", text, at: AT });
const assistant = (text: string): SessionEvent => ({
  event: "assistant_message",
  model: "m",
  blocks: [{ type: "text", text }],
  stop_reason: null,
  usage: { input_tokens: 0, output_tokens: 0 },
  at: AT,
});
const base: SessionEvent[] = [created, user("one"), assistant("first"), user("two"), assistant("second")];
const withRewind: SessionEvent[] = [...base, { event: "rewind", to: 3, at: AT }];
const withUnrewind: SessionEvent[] = [...withRewind, { event: "unrewind", of: 5, at: AT }];

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  rewind: vi.fn(async () => withRewind),
  unrewind: vi.fn(async () => withUnrewind),
  editMessage: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
  removeMessage: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
  restoreMessage: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
  editContext: vi.fn(async () => ({ view: { system: [], messages: [], sidecar: [] }, events: base, changed: 1 })),
  renameSession: vi.fn(async () => {}),
  deleteSession: vi.fn(async (id: string) => id),
  restoreSession: vi.fn(async (id: string) => id),
  openSession: vi.fn(async () => base),
  setPromptLayers: vi.fn(async () => base),
  setPromptLayerText: vi.fn(async () => base),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => base),
  send: vi.fn(async () => ({})),
  setUndoMenu: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.clearAllMocks();
  app.events = [...base];
  app.activeSessionId = "chat-1";
  app.busy = false;
  app.connecting = false;
  // No provider: `applyDraft` returns before it would connect, so a layer
  // change is the log call alone.
  app.draft.provider = "";
  app.sessions = [];
  history.clear("chat-1");
  history.clear("*");
  history.clear("new");
});

describe("liveFlags with unrewind", () => {
  it("lifts the rewind it names and leaves a standing one alone", () => {
    expect(liveFlags(withRewind)).toEqual([true, true, true, false, false, false]);
    expect(liveFlags(withUnrewind)).toEqual([true, true, true, true, true, false, false]);
    const wider: SessionEvent[] = [...withUnrewind, { event: "rewind", to: 1, at: AT }];
    expect(liveFlags(wider)).toEqual([true, false, false, false, false, false, false, false]);
  });
});

describe("one inverse per operation", () => {
  it("rewind → unrewind of the marker it landed; redo is a fresh rewind", async () => {
    await rewindTo(3);
    expect(undoLabel()).toBe("rewind");
    await undo();
    expect(api.unrewind).toHaveBeenCalledWith(5);
    expect(app.events).toEqual(withUnrewind);
    expect(undoLabel()).toBeNull();
    await redo();
    expect(api.rewind).toHaveBeenCalledTimes(2);
    expect(api.rewind).toHaveBeenLastCalledWith(3);
  });

  it("edit-and-save → an edit back to the previous text", async () => {
    await saveEdit(1, "one, edited");
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one, edited", "save");
    await undo();
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one", "save");
    await redo();
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one, edited", "save");
  });

  it("remove → restore of the same turn", async () => {
    await removeTurn(2);
    await undo();
    expect(api.restoreMessage).toHaveBeenCalledWith(2);
    await redo();
    expect(api.removeMessage).toHaveBeenCalledTimes(2);
  });

  it("context-panel remove → restore of the same items, and back", async () => {
    await editContextItems([2, 4], true);
    await undo();
    expect(api.editContext).toHaveBeenLastCalledWith([2, 4], false);
    await redo();
    expect(api.editContext).toHaveBeenLastCalledWith([2, 4], true);
  });

  it("rename → rename back, from any chat", async () => {
    app.sessions = [
      { id: "chat-2", path: "", modified: AT, user_turns: 1, first_user: "hello", title: "Old name" },
    ];
    await renameSession("chat-2", "New name");
    // The list's stack: reachable with another chat open.
    app.activeSessionId = "chat-1";
    expect(undoLabel()).toBe("rename");
    await undo();
    expect(api.renameSession).toHaveBeenLastCalledWith("chat-2", "Old name");
  });

  it("delete → restore from the trash, reopened when nothing is open", async () => {
    await deleteSession("chat-1");
    expect(app.activeSessionId).toBeNull();
    expect(undoLabel()).toBe("delete");
    await undo();
    expect(api.restoreSession).toHaveBeenCalledWith("chat-1");
    expect(api.openSession).toHaveBeenCalledWith("chat-1");
  });

  it("layer off → the set as it was", async () => {
    await setPromptLayer("identity", false);
    expect(api.setPromptLayers).toHaveBeenLastCalledWith(["identity"]);
    expect(undoLabel()).toBe("identity off");
    await undo();
    expect(api.setPromptLayers).toHaveBeenLastCalledWith([]);
  });

  it("layer text → the previous text, none included", async () => {
    await setPromptLayerText("user_memory", "be brief");
    expect(api.setPromptLayerText).toHaveBeenLastCalledWith("user_memory", "be brief");
    await undo();
    expect(api.setPromptLayerText).toHaveBeenLastCalledWith("user_memory", null);
  });

  it("a sent turn clears the chat's stack", async () => {
    await rewindTo(3);
    expect(undoLabel()).toBe("rewind");
    app.connection = { engine: "provider" } as never;
    await send("hello");
    expect(undoLabel()).toBeNull();
  });

  it("does nothing while a turn is running", async () => {
    await rewindTo(3);
    app.busy = true;
    await undo();
    expect(api.unrewind).not.toHaveBeenCalled();
  });
});
