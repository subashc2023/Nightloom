import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, sendQueuedInBackground } from "./state.svelte";
import { draftKey, drafts, enqueueMessage, readDraft } from "./drafts.svelte";
import * as api from "./api";

// Nightshift blocker 1467 (his answer, 2026-10-18): when a chat's turn
// ends while he is in another chat, its queued message is sent at once in
// its own chat, in the background — never the chat he is in (375).
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  transcript: vi.fn(async () => []),
}));

const AISCI = "chat-aisci";
const ICS51 = "chat-ics51";
const was = { pendingMode: "normal" as const, pendingKind: app.pendingKind, project: "p-aisci", projectName: "AI Safety Collective", name: "AISCI chat" };

function open(chat: string, project: string) {
  app.activeSessionId = chat;
  app.project = { id: project } as never;
}

const send = vi.mocked(api.sendAgent);
let finish: (r: unknown) => void = () => {};

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(app.background)) delete app.background[k];
  send.mockReset();
  send.mockImplementation(() => new Promise((r) => (finish = r as never)) as never);
});

describe("1467: a queued message goes at once, in its own chat, in the background", () => {
  it("after a switch of chat and project, it is sent to the queued chat's id and project — never the open one", async () => {
    open(AISCI, "p-aisci");
    enqueueMessage(draftKey(AISCI, "p-aisci"), "for AISCI only", []);
    open(ICS51, "p-ics51");
    enqueueMessage(draftKey(ICS51, "p-ics51"), "ICS 51's own", []);
    const going = sendQueuedInBackground({ chat: AISCI, pendingKey: null }, was, true);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    const args = send.mock.calls[0]!;
    expect(args[0]).toBe("for AISCI only");
    expect(args[7]).toEqual({ chat: AISCI, project: "p-aisci" });
    expect(JSON.stringify(args)).not.toContain(ICS51);
    // It runs as a background chat; he stays where he is, and ICS 51's
    // queue is untouched.
    expect(app.background[AISCI]).toBeDefined();
    expect(app.activeSessionId).toBe(ICS51);
    expect(readDraft(AISCI).queue).toEqual([]);
    expect(readDraft(ICS51).queue.map((r) => r.text)).toEqual(["ICS 51's own"]);
    finish({ delivered: [], notices: [], is_error: false, refused: [] });
    await going;
  });

  it("refused by the backend (chat not loaded): the message is back at the head of its own queue", async () => {
    open(AISCI, "p-aisci");
    enqueueMessage(AISCI, "first", []);
    enqueueMessage(AISCI, "second", []);
    open(ICS51, "p-ics51");
    send.mockImplementation(async () => {
      throw new Error("that chat is not loaded now — its message stays queued there");
    });
    expect(await sendQueuedInBackground({ chat: AISCI, pendingKey: null }, was, true)).toBe(false);
    expect(readDraft(AISCI).queue.map((r) => r.text)).toEqual(["first", "second"]);
    expect(app.background[AISCI]).toBeUndefined();
    expect(readDraft(ICS51).queue).toEqual([]);
  });

  it("after a Stop or a failure nothing goes; the row waits in its chat", async () => {
    open(AISCI, "p-aisci");
    enqueueMessage(AISCI, "held", []);
    open(ICS51, "p-ics51");
    expect(await sendQueuedInBackground({ chat: AISCI, pendingKey: null, stopped: true }, was, true)).toBe(false);
    expect(await sendQueuedInBackground({ chat: AISCI, pendingKey: null }, was, false)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(readDraft(AISCI).queue.map((r) => r.text)).toEqual(["held"]);
  });

  it("a chat on screen again is the composer's to drain, not the background's", async () => {
    open(AISCI, "p-aisci");
    enqueueMessage(AISCI, "on screen", []);
    expect(await sendQueuedInBackground({ chat: AISCI, pendingKey: null }, was, true)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
