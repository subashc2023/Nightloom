import { beforeEach, describe, expect, it } from "vitest";
import { deliveredNotice, injectChip, queueHeadLabel } from "./midTurn";
import { drafts, enqueueMessage, markDelivered, markInjected, readDraft } from "./drafts.svelte";

// Nightshift backlog 366 + 374 (2026-10-18): one clear state per moment
// for a message he queues while a turn runs — queued (not yet given to
// Claude Code), handed to the turn (goes at Claude's next step),
// delivered (gone from the box, a plain line in the transcript).
beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
});

describe("the queue's head while a turn runs (366, 374)", () => {
  it("a row the turn could not take says it waits for the turn's end", () => {
    expect(queueHeadLabel({ busy: true, hold: null, rows: [{}], subagents: 0 })).toBe("queued · sent when this turn ends");
  });

  it("…and names the subagents that hold the turn open, when any run", () => {
    expect(queueHeadLabel({ busy: true, hold: null, rows: [{}], subagents: 4 })).toBe(
      "queued · sent when this turn ends — after its 4 subagents finish",
    );
    expect(queueHeadLabel({ busy: true, hold: null, rows: [{}], subagents: 1 })).toContain("its subagent finishes");
  });

  it("rows handed to the turn do not say they wait for its end", () => {
    const l = queueHeadLabel({ busy: true, hold: null, rows: [{ inject: {} }], subagents: 4 });
    expect(l).toBe("waiting for Claude's next step");
    expect(l).not.toContain("turn ends");
  });

  it("idle: the holds read as before", () => {
    expect(queueHeadLabel({ busy: false, hold: "stopped", rows: [{}], subagents: 0 })).toBe("waiting — the turn was stopped");
    expect(queueHeadLabel({ busy: false, hold: null, rows: [{}], subagents: 0 })).toBe("waiting");
  });
});

describe("handed to the turn, then delivered (366)", () => {
  it("the row's chip is future tense until the turn takes it", () => {
    expect(injectChip({}).label).not.toMatch(/^sent|delivered/);
    expect(injectChip({ now: true }).label).toMatch(/^going now/);
  });

  it("taken: the row leaves the box at once", () => {
    const a = enqueueMessage("c1", "check the second paper too", []);
    markInjected("c1", a.id, { id: "u-a", turn: "turn:1" });
    expect(readDraft("c1").queue).toHaveLength(1);
    markDelivered("u-a");
    expect(readDraft("c1").queue).toEqual([]);
  });

  it("the transcript line says it was delivered and Claude is reading it now", () => {
    expect(deliveredNotice("after Bash", "check the second paper too\nmore")).toBe(
      "Delivered mid-reply, after Bash — Claude is reading it now: “check the second paper too”",
    );
    expect(deliveredNotice("after the reply", "hi")).toBe("Delivered after the reply — Claude is reading it now: “hi”");
  });
});
