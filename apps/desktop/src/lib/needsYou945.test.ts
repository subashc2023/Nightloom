// Item 945: Home's Needs you lists what waits on him in his chats — Nightshift's blockers and shipped items are
// counted for one quiet line, never listed — and a kept turn is "seen" once its chat is on screen with the window
// in front (a question stays until it is answered).
import { describe, expect, it } from "vitest";
import { homeNeeds, needRows, nightshiftWords, seenNow, waitingCount, type EndedTurn, type NeedSources } from "./needsYou";

const ask = { question: "Ship it?", options: ["Yes", "No"] };
const ended = (chat: string, o: Partial<EndedTurn> = {}): EndedTurn => ({ chat, name: `Chat ${chat}`, project: "p", projectName: "ICS 51", at: 1, failed: false, ask: null, ...o });
const sources = (o: Partial<NeedSources> = {}): NeedSources => ({ runs: [], ended: [], here: null, blockers: [], shipped: [], running: () => false, ...o });
const blocker = (id: string, held = false) => ({ project: "ns", projectName: "Nightshift", id, question: `Q ${id}`, guess: "", held, raised: "" });
const shipped = (id: string) => ({ project: "ns", projectName: "Nightshift", id, title: `Item ${id}`, shipped: "2026-11-24" });

describe("Home's own Needs you (item 945)", () => {
  it("lists questions and unseen finishes, and only counts Nightshift's blockers and shipped items", () => {
    const rows = needRows(sources({ ended: [ended("a", { ask }), ended("b"), ended("c", { failed: true })], blockers: [blocker("1"), blocker("2", true)], shipped: [shipped("935"), shipped("936"), shipped("937")] }));
    expect(rows).toHaveLength(8);
    const h = homeNeeds(rows);
    expect(h.rows.map((r) => r.kind)).toEqual(["ask", "done", "failed"]);
    expect(h.blockers).toBe(2);
    expect(h.shipped).toBe(3);
    // The sidebar's Home count: what waits on him on Home — the question, not the held blocker.
    expect(waitingCount(h.rows)).toBe(1);
    expect(waitingCount(rows)).toBe(3);
  });
  it("never lists what is running", () => {
    const rows = needRows(sources({ runs: [{ id: "r", kind: "chat", chat: "x", where: "p", project: "p", session: "x", startedAt: 1, waiting: false, doing: "…" } as never] }));
    expect(homeNeeds(rows).rows).toEqual([]);
  });
  it("says the quiet line in plain counts, and nothing with neither", () => {
    expect(nightshiftWords({ blockers: 15, shipped: 24 })).toBe("15 blockers · 24 shipped items");
    expect(nightshiftWords({ blockers: 1, shipped: 1 })).toBe("1 blocker · 1 shipped item");
    expect(nightshiftWords({ blockers: 0, shipped: 2 })).toBe("2 shipped items");
    expect(nightshiftWords({ blockers: 0, shipped: 0 })).toBe("");
  });
});

describe("the seen marker (item 945)", () => {
  const on = { onScreen: true, focused: true, answered: false };
  it("drops a finished turn once its chat is on screen with the window in front", () => {
    expect(seenNow(ended("a"), on)).toBe(true);
    expect(seenNow(ended("a", { failed: true }), on)).toBe(true);
  });
  it("keeps it while the window is behind another app, or another chat is on screen", () => {
    expect(seenNow(ended("a"), { ...on, focused: false })).toBe(false);
    expect(seenNow(ended("a"), { ...on, onScreen: false })).toBe(false);
    expect(seenNow(undefined, on)).toBe(false);
  });
  it("keeps a question until the log shows it answered", () => {
    expect(seenNow(ended("a", { ask }), on)).toBe(false);
    expect(seenNow(ended("a", { ask }), { ...on, answered: true })).toBe(true);
  });
});
