import { beforeEach, describe, expect, it } from "vitest";
import sidebarSrc from "./Sidebar.svelte?raw";

// Item 559, the review's 534-2: the Sidebar recorded the opened chat's size
// against `app.connection.contextLimit`, which follows the opened chat only
// after its reconnect. Chat A on a 1M-window model open; he opens B (200k
// model, reading 150k) and moves on before B's reconnect: B was stored as
// {150k, 1M} — its bar 15% instead of 75%, and "past hand-off" missed.

const { app, chatChoice, connectionWindowFor } = await import("./state.svelte");
const { chatContext, contextOf, noteChatContext } = await import("./chatContext.svelte");

const A = "chat-a";
const B = "chat-b";
const OPUS_1M = { engine: "claude-code", provider: null, model: "", agentModel: "opus[1m]" } as never;
const SONNET = { engine: "claude-code", provider: null, model: "", agentModel: "sonnet" } as never;

beforeEach(() => {
  for (const k of Object.keys(chatContext)) delete chatContext[k];
  chatChoice.choices = { default: null, chats: { [A]: OPUS_1M, [B]: SONNET } } as never;
  app.connecting = false;
  app.connection = { engine: "claude-code", contextLimit: 1_000_000 } as never;
  app.connectedFor = { chat: A, choice: OPUS_1M };
});

describe("559 — a chat's reading takes only a window known to be its own", () => {
  it("B opened before its reconnect: B keeps its own stored window, not A's", () => {
    noteChatContext(B, 150_000, 200_000); // read earlier, on its own connection
    // The Sidebar's effect at the switch, before B's reconnect.
    noteChatContext(B, 150_000, connectionWindowFor(B));
    expect(contextOf(B)).toEqual({ used: 150_000, limit: 200_000 });
    // A reconnect running: still not trusted.
    app.connecting = true;
    expect(connectionWindowFor(A)).toBeNull();
    // B's reconnect lands: its own window now.
    app.connecting = false;
    app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
    app.connectedFor = { chat: B, choice: SONNET };
    expect(connectionWindowFor(B)).toBe(200_000);
  });

  it("a chat whose own choice is the connection's: its window is right without a reconnect", () => {
    chatChoice.choices = { default: null, chats: { [A]: OPUS_1M, [B]: OPUS_1M } } as never;
    expect(connectionWindowFor(B)).toBe(1_000_000);
    expect(connectionWindowFor(A)).toBe(1_000_000);
  });

  it("the Sidebar records through it", () => {
    expect(sidebarSrc).toMatch(/const limit = connectionWindowFor\(id\);\s*\n\s*untrack\(\(\) => noteChatContext\(id, used, limit\)\)/);
  });
});
