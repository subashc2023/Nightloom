import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { drafts, enqueueMessage, historyFor, markInjected, readDraft } from "./drafts.svelte";
import { cancelPending, editPending, offersChoice, pendingLabel, pendingRows, pendingState } from "./pendingBubble.svelte";
import assistantSource from "./AssistantMessage.svelte?raw";
import transcriptSource from "./Transcript.svelte?raw";
import bubbleSource from "./MidTurnBubble.svelte?raw";
import stateSource from "./state.svelte.ts?raw";

// Item 465 (2026-10-28): a message sent while a turn runs is his bubble —
// greyed with a pending mark and its choices until the turn takes it, an
// ordinary bubble in place once it has. Fixtures; the backend is a stub.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  takeBackInjected: vi.fn(async () => "cancelled" as const),
}));

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  vi.mocked(api.takeBackInjected).mockClear();
});

describe("where a pending message stands", () => {
  it("handed to the turn: next step, with Send now and Let it arrive", () => {
    const s = pendingState({ inject: { id: "u", turn: "t" } });
    expect(s).toBe("next-step");
    expect(offersChoice(s, false)).toBe(true);
    expect(pendingLabel(s)).toMatch(/^not sent yet/);
  });

  it("after Let it arrive: no choice left, still not sent", () => {
    expect(offersChoice("next-step", true)).toBe(false);
    expect(pendingLabel("next-step", true)).toBe("not sent yet — Claude reads it at its next step");
  });

  it("sending now, and a row the turn cannot take (provider engine, files): no Send now", () => {
    expect(pendingState({ inject: { id: "u", turn: "t", now: true } })).toBe("now");
    expect(offersChoice("now", false)).toBe(false);
    expect(pendingState({})).toBe("turn-end");
    expect(offersChoice("turn-end", false)).toBe(false);
    expect(pendingLabel("turn-end")).toContain("goes when this turn ends");
  });

  it("drawn only while the turn runs, and never once taken", () => {
    const q = [
      { id: 1, text: "a", attachments: [] },
      { id: 2, text: "b", attachments: [], inject: { id: "u2", turn: "t" } },
      { id: 3, text: "c", attachments: [], inject: { id: "u3", turn: "t", after: "after Bash" } },
    ];
    expect(pendingRows(q, true).map((r) => r.id)).toEqual([1, 2]);
    expect(pendingRows(q, false)).toEqual([]);
  });
});

describe("Edit and Cancel never lose the text", () => {
  it("Edit takes it back from the turn and puts it in the box", async () => {
    const q = enqueueMessage("c1", "also check the second paper", []);
    markInjected("c1", q.id, { id: "u-1", turn: "turn:1" });
    expect(await editPending("c1", q.id)).toBe(true);
    expect(api.takeBackInjected).toHaveBeenCalledWith("turn:1", "u-1");
    expect(readDraft("c1").queue).toEqual([]);
    expect(readDraft("c1").text).toBe("also check the second paper");
  });

  it("Cancel leaves it unsent and keeps its words in the box's history", async () => {
    const q = enqueueMessage("c2", "never mind the plots", []);
    markInjected("c2", q.id, { id: "u-2", turn: "turn:2" });
    expect(await cancelPending("c2", q.id)).toBe(true);
    expect(readDraft("c2").queue).toEqual([]);
    expect(historyFor("c2").map((h) => h.text)).toContain("never mind the plots");
  });

  it("a row the turn already took is not taken back: it stays, sent", async () => {
    vi.mocked(api.takeBackInjected).mockResolvedValueOnce("delivered");
    const q = enqueueMessage("c3", "too late", []);
    markInjected("c3", q.id, { id: "u-3", turn: "turn:3" });
    expect(await editPending("c3", q.id)).toBe(false);
    expect(readDraft("c3").text).toBe("");
    expect(readDraft("c3").queue).toHaveLength(1);
  });
});

describe("the wiring", () => {
  it("a delivered message is a bubble in the reply, not the old line", () => {
    expect(stateSource).toContain("delivered: { text: ev.text, after: ev.after }");
    expect(assistantSource).toMatch(/g\.seg\.kind === "notice" && g\.seg\.delivered\}\s*[\s\S]{0,120}<MidTurnBubble delivered=\{g\.seg\.delivered\} \/>/);
  });

  it("pending bubbles sit under the live reply, and Cancel asks first", () => {
    expect(transcriptSource).toContain("<PendingBubbles />");
    expect(bubbleSource).toContain("Cancel this message?");
    expect(bubbleSource).toContain('data-mt="send-now"');
    expect(bubbleSource).toContain('data-mt="arrive"');
  });
});

describe("item 478: the taken mid-turn bubble sits where his messages sit", () => {
  it("the turns' column is a container, and the taken bubble spans it (measured: right edge 930 = his bubbles' 930, was 810)", () => {
    expect(transcriptSource).toMatch(/\.inner \{[^}]*container: turns \/ inline-size;/);
    expect(bubbleSource).toMatch(/@container turns \(min-width: 0px\) \{\s*\.midturn:not\(\.pending\) \{\s*width: 100cqw;/);
  });
});
