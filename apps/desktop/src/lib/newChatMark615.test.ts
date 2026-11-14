import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Nightshift item 615, his words: "if i create new chat it doesn't hihglight that chat as if i'm on it the way it
 * does when i click on a chat". A New chat's first turn runs with `activeSessionId` null — the turn learns its
 * chat's id from its first event and the open chat takes it only at the turn's end — so the row, listed during
 * the turn, was not lit and New chat stayed lit. Against a stubbed backend, as midturn536.test.ts.
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(async () => null),
  injectMessage: vi.fn(async () => false),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  openSession: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

const api = await import("./api");
const st = await import("./state.svelte");
const { app, applyTurnEvent, chatSelected, newChatSelected, newSession, reflectTabs, send } = st;
const tabs = await import("./tabs");
const sidebarSrc = (await import("./Sidebar.svelte?raw")).default as string;
const classicSrc = (await import("./SidebarClassic.svelte?raw")).default as string;

const OLD = "chat-old";
const MADE = "chat-615";
const ENDED = { delivered: [], notices: [], is_error: false, refused: [] };
let finish: (r: unknown) => void = () => {};
let going: Promise<void> = Promise.resolve();

beforeEach(async () => {
  finish(ENDED);
  await going;
  vi.clearAllMocks();
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.project = { id: "p1", name: "P" } as never;
  app.sessions = [{ id: OLD, title: "Old" }] as never;
  app.activeSessionId = OLD;
  app.events = [];
  app.busy = false;
  app.parked = null;
  app.error = null;
  app.toasts = [];
  app.pendingApprovals = [];
  app.limitPause = null;
  app.view = "chat";
  app.draft.engine = "claude-code";
  app.connection = { engine: "claude-code", provider: "claude-code", model: "m", tools: [] } as never;
  reflectTabs();
  const pending = () =>
    new Promise((res) => {
      finish = res as never;
    });
  vi.mocked(api.sendAgent).mockImplementation(pending as never);
  vi.mocked(api.send).mockImplementation(pending as never);
  vi.mocked(api.transcript).mockImplementation(async () => []);
});

/** New chat, as the sidebar's button does it, plus App.svelte's reflection effect. */
async function newChat(): Promise<void> {
  await newSession();
  reflectTabs();
}

describe("615: the chat New chat made is the one marked", () => {
  it("before its first send, New chat is marked and the chat left is not", async () => {
    expect(chatSelected(OLD)).toBe(true);
    await newChat();
    expect(newChatSelected()).toBe(true);
    expect(chatSelected(OLD)).toBe(false);
  });

  it("during its first turn, once the turn names it, its row is marked — not New chat, not the old chat", async () => {
    await newChat();
    going = send("hello");
    await vi.waitFor(() => expect(api.sendAgent).toHaveBeenCalledTimes(1));
    // The row appears (the list re-read) and the turn's first event names the chat.
    app.sessions = [{ id: MADE, title: "hello" }, { id: OLD, title: "Old" }] as never;
    applyTurnEvent({ type: "thinking_delta", text: "…", chat: MADE } as never);
    expect(app.activeSessionId).toBeNull();
    expect(chatSelected(MADE)).toBe(true);
    expect(newChatSelected()).toBe(false);
    expect(chatSelected(OLD)).toBe(false);
  });

  it("after the turn ends, it stays marked (now as the open chat), in its own tab", async () => {
    await newChat();
    going = send("hello");
    await vi.waitFor(() => expect(api.sendAgent).toHaveBeenCalledTimes(1));
    applyTurnEvent({ type: "thinking_delta", text: "…", chat: MADE } as never);
    vi.mocked(api.transcript).mockImplementation(async () => [
      { event: "session_created", id: MADE, at: "2026-11-11T00:00:00Z", kind: "build", mode: "normal" },
    ] as never);
    finish(ENDED);
    await going;
    reflectTabs();
    expect(app.activeSessionId).toBe(MADE);
    expect(chatSelected(MADE)).toBe(true);
    expect(newChatSelected()).toBe(false);
    expect(st.firstTurnChat.chat).toBeNull();
    expect(tabs.activeTab(tabs.focusedPane(app.tabs)).content).toEqual({ kind: "chat", session: MADE });
  });

  it("a thread or file tab in front still unmarks it (backlog 297 kept)", async () => {
    await newChat();
    going = send("hello");
    await vi.waitFor(() => expect(api.sendAgent).toHaveBeenCalledTimes(1));
    applyTurnEvent({ type: "thinking_delta", text: "…", chat: MADE } as never);
    tabs.openBeside(app.tabs, { kind: "thread", slug: "x", title: "X" } as never, "new");
    expect(chatSelected(MADE)).toBe(false);
  });

  it("a second New chat's turn does not inherit the first one's mark before its own first event", async () => {
    await newChat();
    going = send("hello");
    await vi.waitFor(() => expect(api.sendAgent).toHaveBeenCalledTimes(1));
    applyTurnEvent({ type: "thinking_delta", text: "…", chat: MADE } as never);
    finish(ENDED);
    await going;
    await newChat();
    going = send("again");
    await vi.waitFor(() => expect(api.sendAgent).toHaveBeenCalledTimes(2));
    expect(chatSelected(MADE)).toBe(false);
    expect(newChatSelected()).toBe(true);
  });

  it("both sidebars light rows and New chat through these checks", () => {
    for (const src of [sidebarSrc, classicSrc]) {
      expect(src).toContain("if (chatSelected(id)) return true;");
      expect(src).toContain("class:active={rowLit(s.id)}");
      expect(src).toContain("class:active={newChatSelected()}");
    }
  });
});
