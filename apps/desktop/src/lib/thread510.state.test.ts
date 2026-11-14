import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 510 (his report, 2026-11-05): a thread's + works as New chat does.
// Nothing is created until the first send; that send binds the thread, then
// sends; a failed bind sends nothing; the screen's draft is its own; the saved
// hand-off is read at the + and consumed only at the send.

const order: string[] = [];
let rowAtSend: unknown = null;
const MADE = [
  { event: "session_created", id: "made", at: "2026-11-05T15:00:00Z" },
  { event: "thread", thread: "stuart", at: "2026-11-05T15:00:00Z" },
];

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  newSession: vi.fn(async () => ({ mode: "normal" })),
  setChatThread: vi.fn(async () => {
    order.push("bind");
    return MADE;
  }),
  setChatFolders: vi.fn(async () => {
    order.push("folders");
    return MADE;
  }),
  connectAgent: vi.fn(async () => {
    order.push("connect");
    return { provider: "claude-code", model: "m", workspace: "/w" };
  }),
  sendAgent: vi.fn(async () => {
    order.push("send");
    rowAtSend = (await import("./state.svelte")).app.sessions.find((r) => r.id === "made");
    return { delivered: [] };
  }),
  takeThreadHandoff: vi.fn(async () => {
    order.push("take");
    return "taken";
  }),
  peekThreadHandoff: vi.fn(async () => null),
  threadUpkeep: vi.fn(async (slug: string) => ({ slug, flags: [] })),
  listSessions: vi.fn(async () => []),
  listThreads: vi.fn(async () => []),
  transcript: vi.fn(async () => MADE),
  deleteThread: vi.fn(async () => "trash"),
}));

const api = await import("./api");
const { clearDraft, drafts, hasThreadDraft, newDraftKey, readDraft, setDraftText, enqueueMessage, ranKey } = await import("./drafts.svelte");
const s = await import("./state.svelte");
const { app, chatThread, newChatInThread, newChatSelected, newSession, openChatKey, send, setChatFolders, setChatThread, threadPlusSelected } = s;
const { boxForHandoff } = await import("./thread");
const { deleteThread } = await import("./threadPanel.svelte");

const IN_THREAD = newDraftKey("p1", "normal", "stuart");
const PLAIN = newDraftKey("p1", "normal");

beforeEach(async () => {
  order.length = 0;
  vi.clearAllMocks();
  for (const k of Object.keys(drafts)) delete drafts[k];
  app.project = { id: "p1", name: "P" } as unknown as typeof app.project;
  app.activeSessionId = "other";
  app.events = [];
  app.busy = false;
  app.connecting = false;
  app.connectError = null;
  app.parked = null;
  app.pendingThread = null;
  app.error = null;
  app.toasts = [];
  app.sessions = [];
  app.draft.engine = "claude-code";
  app.connection = { engine: "claude-code", provider: "claude-code", model: "m", tools: [] } as unknown as typeof app.connection;
});

describe("the + creates nothing (510)", () => {
  it("writes no log and adds no row", async () => {
    expect(await newChatInThread("stuart")).toBe(true);
    expect(api.setChatThread).not.toHaveBeenCalled();
    expect(api.takeThreadHandoff).not.toHaveBeenCalled();
    expect(app.activeSessionId).toBe(null);
    expect(app.sessions).toEqual([]);
    expect(app.pendingThread).toBe("stuart");
    expect(chatThread(app.events)).toBe("stuart");
  });

  it("lights the thread's +, not New chat, and New chat clears the thread", async () => {
    await newChatInThread("stuart");
    expect(threadPlusSelected("stuart")).toBe(true);
    expect(newChatSelected()).toBe(false);
    await newSession();
    expect(threadPlusSelected("stuart")).toBe(false);
    expect(newChatSelected()).toBe(true);
    expect(app.pendingThread).toBe(null);
    expect(chatThread(app.events)).toBe(null);
    expect(openChatKey()).toBe(PLAIN);
  });

  it("means nothing while a chat is open", () => {
    app.pendingThread = "stuart";
    app.activeSessionId = "other";
    expect(chatThread([])).toBe(null);
    expect(openChatKey()).toBe("other");
  });

  it("opens as New chat does while a turn runs in another chat", async () => {
    app.busy = true;
    app.activeSessionId = "running";
    expect(await newChatInThread("stuart")).toBe(true);
    expect(app.parked?.session).toBe("running");
    expect(app.activeSessionId).toBe(null);
    expect(app.pendingThread).toBe("stuart");
    expect(api.setChatThread).not.toHaveBeenCalled();
  });
});

describe("the first send binds, then sends (510)", () => {
  it("in that order, with the connect between, and the row in its thread", async () => {
    await newChatInThread("stuart");
    await send("hello");
    expect(order).toEqual(["bind", "take", "connect", "send"]);
    expect(app.activeSessionId).toBe("made");
    expect(app.pendingThread).toBe(null);
    expect(rowAtSend).toMatchObject({ id: "made", thread: "stuart", first_user: "hello" });
  });

  it("keeps the words on the tab brought back: the New chat tab finds its thread", async () => {
    await newChatInThread("stuart");
    const tab = app.tabs.panes[0].tabs.find((t) => t.content.kind === "chat" && t.content.session === null);
    expect(tab).toBeTruthy();
    app.activeSessionId = "other";
    await s.activateTab(tab!.id);
    expect(app.activeSessionId).toBe(null);
    expect(app.pendingThread).toBe("stuart");
  });

  it("does not bind twice for two sends at once", async () => {
    await newChatInThread("stuart");
    await Promise.all([s.bindPendingThread(), s.bindPendingThread()]);
    expect(api.setChatThread).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when the bind is refused, and says so for the box to take the words back", async () => {
    await newChatInThread("stuart");
    vi.mocked(api.setChatThread).mockRejectedValueOnce("no thread stuart in P");
    await send("hello");
    expect(api.sendAgent).not.toHaveBeenCalled();
    expect(app.error).toBe("no thread stuart in P");
    // Still the screen, still in the thread: `dispatch` restores under this key.
    expect(app.activeSessionId).toBe(null);
    expect(app.pendingThread).toBe("stuart");
    expect(openChatKey()).toBe(IN_THREAD);
  });

  it("sends nothing when the connect fails: no turn without the thread's layer", async () => {
    await newChatInThread("stuart");
    vi.mocked(api.connectAgent).mockRejectedValueOnce("no binary");
    await send("hello");
    expect(api.sendAgent).not.toHaveBeenCalled();
    expect(app.error).toContain("no binary");
    // The chat exists by then: the words go back on it.
    expect(ranKey(IN_THREAD)).toBe("made");
  });

  it("sends nothing while a connect is running", async () => {
    await newChatInThread("stuart");
    app.connecting = true;
    await send("hello");
    expect(api.setChatThread).not.toHaveBeenCalled();
    expect(api.sendAgent).not.toHaveBeenCalled();
    expect(app.error).toBeTruthy();
  });

  it("moves what the screen held, a queued row too, to the chat it made", async () => {
    await newChatInThread("stuart");
    setDraftText(IN_THREAD, "still typing");
    enqueueMessage(IN_THREAD, "held", []);
    await s.bindPendingThread();
    expect(readDraft("made").text).toBe("still typing");
    expect(readDraft("made").queue.map((q) => q.text)).toEqual(["held"]);
    expect(readDraft(IN_THREAD).text).toBe("");
  });

  it("a setting that makes the log writes the binding first, so the thread is not lost", async () => {
    await newChatInThread("stuart");
    await setChatFolders(["/x"]);
    expect(order.indexOf("bind")).toBe(0);
    expect(order).toContain("folders");
    expect(app.pendingThread).toBe(null);
  });

  it("a plain New chat's send binds nothing", async () => {
    await newSession();
    await send("hello");
    expect(api.setChatThread).not.toHaveBeenCalled();
    expect(api.sendAgent).toHaveBeenCalledTimes(1);
  });
});

describe("the screen's draft is its own (510)", () => {
  it("never mixes with the plain New chat's, and the same + finds it", async () => {
    await newSession();
    setDraftText(PLAIN, "plain words");
    await newChatInThread("stuart");
    expect(openChatKey()).toBe(IN_THREAD);
    expect(readDraft(openChatKey()).text).toBe("");
    setDraftText(IN_THREAD, "thread words");
    expect(hasThreadDraft("p1", "stuart")).toBe(true);
    await newSession();
    expect(readDraft(openChatKey()).text).toBe("plain words");
    await newChatInThread("stuart");
    expect(readDraft(openChatKey()).text).toBe("thread words");
  });

  it("keeps a saved plain key valid", () => {
    expect(newDraftKey("p1")).toBe("new:p1:normal");
    expect(newDraftKey("p1", "normal", "stuart")).toBe("new:p1:normal:thread:stuart");
  });

  it("the chip binds the plain screen without a log, and the words follow it there and back", async () => {
    await newSession();
    setDraftText(PLAIN, "words");
    expect(await setChatThread("stuart")).toBe(true);
    expect(api.setChatThread).not.toHaveBeenCalled();
    expect(chatThread(app.events)).toBe("stuart");
    expect(readDraft(IN_THREAD).text).toBe("words");
    expect(await setChatThread(null)).toBe(true);
    expect(app.pendingThread).toBe(null);
    expect(readDraft(PLAIN).text).toBe("words");
  });

  it("a thread picked on the chip takes no hand-off at the send", async () => {
    await newSession();
    await setChatThread("stuart");
    await send("hello");
    expect(order).toEqual(["bind", "connect", "send"]);
  });

  it("a deleted thread's typed words go to the plain New chat", async () => {
    await newChatInThread("stuart");
    setDraftText(IN_THREAD, "typed");
    await deleteThread("stuart");
    expect(app.pendingThread).toBe(null);
    expect(readDraft(PLAIN).text).toBe("typed");
  });
});

describe("the saved hand-off (510)", () => {
  const HANDED = "Run T-04.";

  it("shows at the +, and is consumed only at the first send", async () => {
    vi.mocked(api.peekThreadHandoff).mockResolvedValue(HANDED);
    await newChatInThread("stuart");
    expect(readDraft(IN_THREAD).text).toBe(HANDED);
    expect(api.takeThreadHandoff).not.toHaveBeenCalled();
    await newSession();
    await newChatInThread("stuart");
    expect(readDraft(IN_THREAD).text).toBe(HANDED);
    clearDraft(IN_THREAD);
    await send(HANDED);
    expect(order).toEqual(["bind", "take", "connect", "send"]);
    expect(api.takeThreadHandoff).toHaveBeenCalledWith("stuart", "made");
    vi.mocked(api.peekThreadHandoff).mockResolvedValue(null);
  });

  it("never overwrites what he typed", async () => {
    setDraftText(IN_THREAD, "mine");
    vi.mocked(api.peekThreadHandoff).mockResolvedValueOnce(HANDED);
    await newChatInThread("stuart");
    expect(readDraft(IN_THREAD).text).toBe("mine");
  });

  it("stays with its thread when the chip takes the screen elsewhere", async () => {
    vi.mocked(api.peekThreadHandoff).mockResolvedValueOnce(HANDED);
    await newChatInThread("stuart");
    await setChatThread(null);
    expect(readDraft(PLAIN).text).toBe("");
    expect(readDraft(IN_THREAD).text).toBe(HANDED);
  });

  it("boxForHandoff: fills an empty box, updates its own prefill, leaves his words", () => {
    expect(boxForHandoff("", "A", null)).toBe("A");
    expect(boxForHandoff("A", "B", "A")).toBe("B");
    expect(boxForHandoff("A", null, "A")).toBe("");
    expect(boxForHandoff("mine", "B", "A")).toBe(null);
    expect(boxForHandoff("", null, null)).toBe(null);
    expect(boxForHandoff("A", "A", "A")).toBe(null);
  });
});
