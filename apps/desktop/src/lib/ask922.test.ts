// Item 922: an answer given while the chat runs is queued (once), the card keeps the pick as "queued".
import { beforeEach, describe, expect, it, vi } from "vitest";
import turnAskSrc from "./TurnAsk.svelte?raw";
import hostSrc from "./TurnAskHost.svelte?raw";

const h = vi.hoisted(() => ({ runs: true, sent: [] as string[], injected: [] as number[], toasts: [] as string[] }));
vi.mock("./state.svelte", () => ({
  app: { activeSessionId: "c1", busy: true, parked: null, events: [], project: null, sessions: [], view: "chat" },
  sendInChat: (_c: string, _p: unknown, text: string) => void h.sent.push(text),
  chatRuns: () => h.runs,
  injectIntoTurn: async (_k: string, row: { id: number }) => void h.injected.push(row.id),
}));
vi.mock("./state/toasts.svelte", () => ({ addToast: (t: string) => void h.toasts.push(t) }));
vi.mock("./running.svelte", () => ({ allRunning: () => [] }));
vi.mock("./api", () => ({ askFileAnswer: async () => null }));
vi.mock("./notify", () => ({ chatName: () => "x", turnEndListeners: new Set(), windowFocused: () => true }));

const { answerAsk, queuedAnswerOf } = await import("./needsBoard.svelte");
const { readDraft, dropQueued } = await import("./drafts.svelte");

const ask = { question: "Which?", options: ["A", "B"] };
const target = { chat: "c1", name: "c", project: null, projectName: null };

beforeEach(() => {
  h.runs = true;
  h.sent.length = 0;
  h.injected.length = 0;
  h.toasts.length = 0;
  for (const r of [...readDraft("c1").queue]) dropQueued("c1", r.id);
});

describe("922: answering while the chat runs", () => {
  it("queues the answer once, hands it to the turn, sends nothing now, and refuses nothing", async () => {
    expect(await answerAsk(target, ask, "B")).toBe(true);
    expect(h.sent).toEqual([]);
    expect(readDraft("c1").queue.map((q) => q.text)).toEqual(["B"]);
    expect(h.injected).toHaveLength(1);
    expect(h.toasts.join(" ")).not.toMatch(/open it/);
    expect(queuedAnswerOf("c1")?.answer).toBe("B");
  });
  it("the card reverts to unanswered only when the row leaves the queue (removed from its strip)", async () => {
    await answerAsk(target, ask, "A");
    const id = readDraft("c1").queue[0].id;
    expect(queuedAnswerOf("c1")).not.toBeNull();
    dropQueued("c1", id);
    expect(queuedAnswerOf("c1")).toBeNull();
  });
  it("an idle chat sends at once, as before", async () => {
    h.runs = false;
    expect(await answerAsk(target, ask, "A")).toBe(true);
    expect(h.sent).toEqual(["A"]);
    expect(readDraft("c1").queue).toHaveLength(0);
    expect(queuedAnswerOf("c1")).toBeNull();
  });
});

describe("922: the card", () => {
  it("shows the pick as chosen and queued, and takes no second answer", () => {
    expect(turnAskSrc).toMatch(/queued\?: string \| null/);
    expect(turnAskSrc).toMatch(/pickedOption\(ask\.options, queued\)/);
    expect(turnAskSrc).toMatch(/class:sending=\{sending \|\| queued !== null\}/);
    expect(turnAskSrc).toMatch(/Queued — it goes when/);
  });
  it("the host keeps the card drawn from the queued answer while the chat runs", () => {
    expect(hostSrc).toMatch(/queuedAnswerOf\(app\.activeSessionId\)/);
    expect(hostSrc).toMatch(/queued=\{queued\?\.answer \?\? null\}/);
  });
});
