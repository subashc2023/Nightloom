import { beforeEach, describe, expect, it } from "vitest";
import {
  clearInjected,
  drafts,
  enqueueMessage,
  markDelivered,
  markInjected,
  readDraft,
  serializeDrafts,
  settleInjected,
} from "./drafts.svelte";

// Nightshift backlog 328: a row sent into the running turn stays queued,
// marked, until the turn takes it; at the turn's end the taken rows leave
// and every other one is an ordinary held message again — nothing lost.
beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
});

describe("messages sent into the running turn (328)", () => {
  it("a taken row leaves at the turn's end; an untaken one is held again", () => {
    const a = enqueueMessage("c1", "first", []);
    const b = enqueueMessage("c1", "second", []);
    markInjected("c1", a.id, { id: "u-a", turn: "turn:1" });
    markInjected("c1", b.id, { id: "u-b", turn: "turn:1" });
    expect(markDelivered("u-a", "after Bash")).toBe(true);
    expect(readDraft("c1").queue[0]!.inject?.after).toBe("after Bash");
    settleInjected("turn:1", ["u-a"]);
    const q = readDraft("c1").queue;
    expect(q.map((r) => r.text)).toEqual(["second"]);
    expect(q[0]!.inject).toBeUndefined();
  });

  it("the backend's delivered list settles a row whose event never came", () => {
    const a = enqueueMessage("c1", "x", []);
    markInjected("c1", a.id, { id: "u-a", turn: "turn:2" });
    settleInjected("turn:2", ["u-a"]);
    expect(readDraft("c1").queue).toEqual([]);
  });

  it("another turn's rows and plain rows are left alone", () => {
    const a = enqueueMessage("c1", "mine", []);
    const b = enqueueMessage("c2", "other turn", []);
    enqueueMessage("c1", "plain", []);
    markInjected("c1", a.id, { id: "u-a", turn: "turn:3" });
    markInjected("c2", b.id, { id: "u-b", turn: "turn:9" });
    settleInjected("turn:3", []);
    expect(readDraft("c1").queue.map((r) => r.text)).toEqual(["mine", "plain"]);
    expect(readDraft("c2").queue[0]!.inject?.turn).toBe("turn:9");
  });

  it("taken back: an ordinary row, and the mark is never persisted", () => {
    const a = enqueueMessage("c1", "x", []);
    markInjected("c1", a.id, { id: "u-a", turn: "turn:4" });
    expect(serializeDrafts(drafts)).not.toContain("u-a");
    clearInjected("c1", a.id);
    expect(readDraft("c1").queue[0]!.inject).toBeUndefined();
  });
});
