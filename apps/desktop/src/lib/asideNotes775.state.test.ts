import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 775: what an aside changed waits for its chat and goes at the end
// of the next message there — once; a failed send keeps it waiting.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  transcript: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  planUsage: vi.fn(async () => null),
}));

const api = await import("./api");
const { app, runInChat } = await import("./state.svelte");
const { addAsideNote, noteWaiting, pendingNotes } = await import("./asideNotes.svelte");

const A = "chat-a";
const B = "chat-b";
const DONE = { delivered: [], notices: [], is_error: false, refused: [] };
const q = (text: string) => ({ id: 1, text, attachments: [] }) as never;
const change = { path: "src/x.ts", added: 2, removed: 1, how: "edited" as const };

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(pendingNotes)) delete pendingNotes[k];
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
  app.activeSessionId = "elsewhere";
  app.busy = false;
});

describe("aside changes ride the chat's next message (item 775)", () => {
  it("end the message once, and only in their own chat", async () => {
    vi.mocked(api.sendAgent).mockResolvedValue(DONE as never);
    addAsideNote(A, "n1", "fix the typo", [change]);
    addAsideNote(B, "n2", "other chat", [change]);
    expect(noteWaiting("n1")).toBe(true);
    await runInChat(A, q("next words"), undefined, { contextLimit: null });
    const sent = vi.mocked(api.sendAgent).mock.calls[0]![0] as string;
    expect(sent.startsWith("next words\n\n<nightloom-aside-changes>\n")).toBe(true);
    expect(sent).toContain('- aside "fix the typo": `src/x.ts` (+2 −1)');
    expect(sent).not.toContain("other chat");
    expect(noteWaiting("n1")).toBe(false);
    expect(noteWaiting("n2")).toBe(true);
    // The next message in A carries nothing more.
    await runInChat(A, q("and again"), undefined, { contextLimit: null });
    expect(vi.mocked(api.sendAgent).mock.calls[1]![0]).toBe("and again");
  });

  it("wait again when the send failed", async () => {
    vi.mocked(api.sendAgent).mockRejectedValue("nothing was sent");
    addAsideNote(A, "n1", "fix the typo", [change]);
    await runInChat(A, q("next words"), undefined, { contextLimit: null }, () => {});
    expect(noteWaiting("n1")).toBe(true);
  });

  it("send nothing extra when no aside changed anything", async () => {
    vi.mocked(api.sendAgent).mockResolvedValue(DONE as never);
    addAsideNote(A, "n0", "just a question", []);
    await runInChat(A, q("plain"), undefined, { contextLimit: null });
    expect(vi.mocked(api.sendAgent).mock.calls[0]![0]).toBe("plain");
  });
});

describe("the aside's line reads the waiting list (item 775)", () => {
  it("a note added to a chat with none is seen as waiting", () => {
    addAsideNote("fresh", "w1", "q", [change]);
    expect(noteWaiting("w1")).toBe(true);
    expect(pendingNotes.fresh?.length).toBe(1);
  });
});
