import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  app,
  deleteSession,
  editContextItems,
  history,
  liveFlags,
  redo,
  removeBlock,
  removeTurn,
  renameSession,
  restoreBlock,
  restoreTurn,
  rewindTo,
  runToastAction,
  saveEdit,
  saveReplyEdit,
  send,
  setPromptLayer,
  setPromptLayerText,
  undo,
  undoLabel,
} from "./state.svelte";
import type { SessionEvent } from "./types";
import * as api from "./api";
import { draftHistory, drafts, historyFor, readDraft, setDraftText } from "./drafts.svelte";

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
/** Backlog 364: the reply at 2 is aimed by its exchange's send time and its place in it. */
const R2 = { at: AT, nth: 0 };
const withUnrewind: SessionEvent[] = [...withRewind, { event: "unrewind", of: 5, at: AT }];

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  rewind: vi.fn(async () => withRewind),
  unrewind: vi.fn(async () => withUnrewind),
  editMessage: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
  removeMessage: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
  restoreMessage: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
  editBlock: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
  removeBlock: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
  restoreBlock: vi.fn(async () => ({ events: base, session: "chat-1", forked: false })),
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
  app.toasts = [];
});

describe("liveFlags with unrewind", () => {
  it("lifts the rewind it names and leaves a standing one alone", () => {
    expect(liveFlags(withRewind)).toEqual([true, true, true, false, false, false]);
    expect(liveFlags(withUnrewind)).toEqual([true, true, true, true, true, false, false]);
    const wider: SessionEvent[] = [...withUnrewind, { event: "rewind", to: 1, at: AT }];
    expect(liveFlags(wider)).toEqual([true, false, false, false, false, false, false, false]);
  });
});

describe("a rewind from the transcript is aimed (wave 8b review, 2026-10-13)", () => {
  // Backlog 361's stale list: the window's index may name another message
  // in the log, so the transcript's Rewind also sends the message's send
  // time, and its redo does too. The phone's rewind goes bare, as before.
  it("sends the message's send time with its place, and redo does too", async () => {
    const sent = "2026-10-13T07:19:57.123456789Z";
    app.events = [created, user("one"), assistant("first"), { event: "user_message", text: "two", at: sent }];
    await rewindTo(3, true);
    expect(api.rewind).toHaveBeenLastCalledWith(3, sent);
    await undo();
    await redo();
    expect(api.rewind).toHaveBeenLastCalledWith(3, sent);
  });
  it("goes bare when not aimed (the phone's index)", async () => {
    await rewindTo(3);
    expect(api.rewind).toHaveBeenLastCalledWith(3);
  });
});

describe("Remove, Restore and Save are aimed (backlog 364)", () => {
  // 361's stale list, for the rest: the window's index may name another
  // turn in the log, so each sends the send time of the message that opened
  // the turn's exchange, and for a reply its place among that exchange's
  // replies; undo and redo name the same turn. The phone's own aim (or none)
  // goes as it came.
  const one = "2026-10-13T07:19:57.1Z";
  const two = "2026-10-13T07:21:03.2Z";
  const events = (): SessionEvent[] => [
    created,
    { event: "user_message", text: "one", at: one },
    assistant("first"),
    { event: "user_message", text: "two", at: two },
    assistant("second a"),
    assistant("second b"),
  ];
  beforeEach(() => {
    app.events = events();
  });

  it("Remove sends his message's send time, and its undo and redo do too", async () => {
    await removeTurn(3);
    expect(api.removeMessage).toHaveBeenLastCalledWith(3, { at: two });
    await undo();
    expect(api.restoreMessage).toHaveBeenLastCalledWith(3, { at: two });
    await redo();
    expect(api.removeMessage).toHaveBeenLastCalledWith(3, { at: two });
  });
  it("Remove on a reply sends its exchange's send time and its place in it", async () => {
    await removeTurn(5);
    expect(api.removeMessage).toHaveBeenLastCalledWith(5, { at: two, nth: 1 });
  });
  it("Restore sends it, and so does its undo", async () => {
    await restoreTurn(4);
    expect(api.restoreMessage).toHaveBeenLastCalledWith(4, { at: two, nth: 0 });
    await undo();
    expect(api.removeMessage).toHaveBeenLastCalledWith(4, { at: two, nth: 0 });
  });
  it("Save sends it, on his message and on a reply's block", async () => {
    await saveEdit(3, "two, edited");
    expect(api.editMessage).toHaveBeenLastCalledWith(3, "two, edited", "save", null, two, null);
    await undo();
    expect(api.editMessage).toHaveBeenLastCalledWith(3, "two", "save", null, two, null);
    app.events = events(); // the mock answered with another log
    await saveReplyEdit(2, [{ block: 0, text: "first, reworded" }]);
    expect(api.editBlock).toHaveBeenLastCalledWith(2, 0, "first, reworded", { at: one, nth: 0 });
  });
  it("the phone's aim goes as it came, and none goes bare", async () => {
    await removeTurn(3, { at: one });
    expect(api.removeMessage).toHaveBeenLastCalledWith(3, { at: one });
    await restoreTurn(3, null);
    expect(api.restoreMessage).toHaveBeenLastCalledWith(3);
  });

  // 364 review: the phone's index is its own list's. What the Mac reads
  // before the change — an undo's previous words, a rewound message — is
  // read at the turn the aim names in the Mac's list, never at the phone's
  // index there (which would put another turn's words into the turn meant).
  it("a phone Save's undo puts back the aimed turn's words, not those at the phone's index", async () => {
    await saveEdit(1, "two, edited", null, { at: two });
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "two, edited", "save", null, two, null);
    await undo();
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "two", "save", null, two, null);
  });
  it("a phone Save of a turn the Mac's list lacks pushes no undo", async () => {
    await saveEdit(1, "x", null, { at: "2026-10-14T00:00:00Z" });
    expect(api.editMessage).toHaveBeenCalledTimes(1);
    expect(undoLabel()).toBeNull();
  });
  it("a phone reply Save reads the aimed reply's blocks, and its undo puts them back", async () => {
    // The phone's index 2 is its "second b"; in the Mac's list that reply is at 5.
    await saveReplyEdit(2, [{ block: 0, text: "b, reworded" }], { at: two, nth: 1 });
    expect(api.editBlock).toHaveBeenLastCalledWith(2, 0, "b, reworded", { at: two, nth: 1 });
    await undo();
    expect(api.editBlock).toHaveBeenLastCalledWith(2, 0, "second b", { at: two, nth: 1 });
  });
  it("a phone rewind puts the aimed message in the box", async () => {
    delete drafts["chat-1"];
    await rewindTo(1, two);
    expect(api.rewind).toHaveBeenLastCalledWith(1, two);
    expect(readDraft("chat-1").text).toBe("two");
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
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one, edited", "save", null, AT, null);
    await undo();
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one", "save", null, AT, null);
    await redo();
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one, edited", "save", null, AT, null);
  });

  it("an attachment edit (item 336) → an edit back to the set the turn carried", async () => {
    const set = { images: [{ media_type: "image/png", data: "AAAA" }], documents: [] };
    await saveEdit(1, "one, edited", set);
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one, edited", "save", set, AT, null);
    await undo();
    // Turn 1 had none of its own: the undo sets the empty set back.
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one", "save", { images: [], documents: [] }, AT, null);
    await redo();
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one, edited", "save", set, AT, null);
  });

  it("remove → restore of the same turn", async () => {
    await removeTurn(2);
    await undo();
    expect(api.restoreMessage).toHaveBeenCalledWith(2, R2);
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
    expect(api.renameSession).toHaveBeenLastCalledWith("chat-2", "Old name", app.activeSessionId);
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

// ---- Restore, tool calls, the Undo toast (nightshift backlog 066) ----

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the Undo toast", () => {
  it("a removal raises 'Removed from context · Undo', and Undo restores that turn once", async () => {
    await removeTurn(2);
    const toast = app.toasts.find((t) => t.text === "Removed from context");
    expect(toast?.action?.label).toBe("Undo");
    runToastAction(toast!.id);
    await flush();
    expect(api.restoreMessage).toHaveBeenCalledWith(2, R2);
    expect(app.toasts.some((t) => t.id === toast!.id)).toBe(false);
    expect(undoLabel()).toBeNull();
    // The click is spent with the toast.
    runToastAction(toast!.id);
    await flush();
    expect(api.restoreMessage).toHaveBeenCalledTimes(1);
  });

  it("a rewind raises '… back in the box · Undo' (backlog 247), 'Rewound to here' on a reply", async () => {
    await rewindTo(3);
    const toast = app.toasts.find((t) => t.text === "Rewound — your message is back in the box");
    expect(toast?.action?.label).toBe("Undo");
    runToastAction(toast!.id);
    await flush();
    expect(api.unrewind).toHaveBeenCalledWith(5);
    await rewindTo(4);
    expect(app.toasts.find((t) => t.text === "Rewound to here")?.action?.label).toBe("Undo");
  });

  it("refuses once something newer is on the stack, and says so", async () => {
    await removeTurn(2);
    const toast = app.toasts.find((t) => t.text === "Removed from context")!;
    await saveEdit(1, "one, edited");
    runToastAction(toast.id);
    await flush();
    expect(api.restoreMessage).not.toHaveBeenCalled();
    expect(app.toasts.some((t) => t.text.startsWith("Something was done since"))).toBe(true);
    // ⌘Z still undoes in order.
    await undo();
    expect(api.editMessage).toHaveBeenLastCalledWith(1, "one", "save", null, AT, null);
    await undo();
    expect(api.restoreMessage).toHaveBeenCalledWith(2, R2);
  });
});

describe("Restore and tool calls", () => {
  it("Restore on a placeholder pushes its inverse — the removal again", async () => {
    await restoreTurn(2);
    expect(api.restoreMessage).toHaveBeenCalledWith(2, R2);
    expect(undoLabel()).toBe("restore");
    await undo();
    expect(api.removeMessage).toHaveBeenCalledWith(2, R2);
    await redo();
    expect(api.restoreMessage).toHaveBeenCalledTimes(2);
  });

  it("a tool call's removal → the block's restore, with the toast; Restore → the removal", async () => {
    await removeBlock(2, 1);
    expect(api.removeBlock).toHaveBeenCalledWith(2, 1, R2);
    expect(app.toasts.some((t) => t.text === "Removed from context")).toBe(true);
    await undo();
    expect(api.restoreBlock).toHaveBeenCalledWith(2, 1, R2);
    await restoreBlock(2, 1);
    expect(undoLabel()).toBe("restore");
    await undo();
    expect(api.removeBlock).toHaveBeenLastCalledWith(2, 1, R2);
  });

  it("a reply's Save is one entry: edits back for edits, restores for emptied blocks, in reverse", async () => {
    app.events = [
      created,
      user("one"),
      {
        event: "assistant_message",
        model: "m",
        blocks: [
          { type: "text", text: "alpha" },
          { type: "tool_use", id: "c1", name: "read_file", input: {} },
          { type: "text", text: "beta" },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        at: AT,
      },
    ];
    const ok = await saveReplyEdit(2, [
      { block: 0, text: "alpha, reworded" },
      { block: 2, text: "" },
    ]);
    expect(ok).toBe(true);
    expect(api.editBlock).toHaveBeenCalledWith(2, 0, "alpha, reworded", R2);
    expect(api.removeBlock).toHaveBeenCalledWith(2, 2, R2);
    expect(undoLabel()).toBe("edit");
    await undo();
    expect(api.restoreBlock).toHaveBeenCalledWith(2, 2, R2);
    expect(api.editBlock).toHaveBeenLastCalledWith(2, 0, "alpha", R2);
    const order = (api.restoreBlock as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const back = (api.editBlock as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1];
    expect(order).toBeLessThan(back);
    await redo();
    expect(api.editBlock).toHaveBeenLastCalledWith(2, 0, "alpha, reworded", R2);
    expect(api.removeBlock).toHaveBeenCalledTimes(2);
    expect(undoLabel()).toBe("edit");
  });
});

describe("rewind puts his message back in the box (backlog 247)", () => {
  beforeEach(() => {
    delete drafts["chat-1"];
    delete draftHistory["chat-1"];
  });

  it("fills an empty box with the rewound message; undo empties it again", async () => {
    await rewindTo(3);
    expect(readDraft("chat-1").text).toBe("two");
    expect(historyFor("chat-1")).toEqual([]);
    expect(app.toasts.map((t) => t.text)).toEqual(["Rewound — your message is back in the box"]);
    await undo();
    expect(readDraft("chat-1").text).toBe("");
  });

  it("replaces half-typed text, which goes to the top of the drafts, and says so (blocker 581)", async () => {
    setDraftText("chat-1", "half typed");
    await rewindTo(3);
    expect(readDraft("chat-1").text).toBe("two");
    expect(historyFor("chat-1")[0].text).toBe("half typed");
    expect(app.toasts.some((t) => t.text.includes("half-typed message is in drafts"))).toBe(true);
    await undo();
    expect(readDraft("chat-1").text).toBe("half typed");
  });

  it("undo leaves the box alone once he has changed the restored message", async () => {
    await rewindTo(3);
    setDraftText("chat-1", "two, reworded");
    await undo();
    expect(app.events).toEqual(withUnrewind);
    expect(readDraft("chat-1").text).toBe("two, reworded");
  });

  it("a rewind to a reply puts nothing in the box", async () => {
    setDraftText("chat-1", "mine");
    await rewindTo(4);
    expect(readDraft("chat-1").text).toBe("mine");
    expect(historyFor("chat-1")).toEqual([]);
  });
});
