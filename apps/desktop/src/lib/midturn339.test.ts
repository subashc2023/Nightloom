import { beforeEach, describe, expect, it } from "vitest";
import { drafts, enqueueMessage, markInjected, markSendNow, readDraft, settleInjected } from "./drafts.svelte";
import { chipsFromInputs, midTurnWire } from "./midTurn";
import { recordRelay, relayArrived, relays } from "./relay.svelte";
import type { Attachment } from "./types";
import type { Segment } from "./state.svelte";

// Nightshift backlog 339: Send now on a mid-turn row, files on a mid-turn
// message, and the main model's relay to a running subagent.
beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(relays)) delete relays[k];
});

const img: Attachment = { id: 1, kind: "image", media_type: "image/png", name: "a.png", data: "iVBO" };
const pdf: Attachment = { id: 2, kind: "document", media_type: "application/pdf", name: "b.pdf", data: "JVBE" };

describe("files on a mid-turn message (339)", () => {
  it("images and documents go as the opening line's blocks", () => {
    expect(midTurnWire([img, pdf])).toEqual({
      images: [{ media_type: "image/png", data: "iVBO" }],
      documents: [{ media_type: "application/pdf", name: "b.pdf", data: "JVBE" }],
    });
    expect(midTurnWire([])).toEqual({ images: [], documents: [] });
  });

  it("a file for Claude Code, a converting chip or one without bytes waits for the turn's end", () => {
    expect(midTurnWire([img, { ...pdf, kind: "file" }])).toBeNull();
    expect(midTurnWire([{ ...pdf, pending: true }])).toBeNull();
    expect(midTurnWire([{ ...img, data: "" }])).toBeNull();
  });

  it("the phone's photos become queue chips that keep their bytes", () => {
    let n = 10;
    const chips = chipsFromInputs([{ media_type: "image/jpeg", data: "abc" }], [{ media_type: "application/pdf", name: "x.pdf", data: "d" }], () => n++);
    expect(chips.map((c) => [c.id, c.kind, c.name, c.data])).toEqual([
      [10, "image", "photo-1.jpeg", "abc"],
      [11, "document", "x.pdf", "d"],
    ]);
    expect(midTurnWire(chips)?.images).toHaveLength(1);
  });
});

describe("Send now (339)", () => {
  it("marks the row, and the turn's end still settles it like any sent row", () => {
    const a = enqueueMessage("c1", "stop that", []);
    markInjected("c1", a.id, { id: "u-a", turn: "turn:1" });
    markSendNow("c1", a.id);
    expect(readDraft("c1").queue[0]!.inject?.now).toBe(true);
    settleInjected("turn:1", ["u-a"]);
    expect(readDraft("c1").queue).toEqual([]);
  });

  it("an untaken Send now row is an ordinary held message again — nothing lost", () => {
    const a = enqueueMessage("c1", "stop that", []);
    markInjected("c1", a.id, { id: "u-a", turn: "turn:2" });
    markSendNow("c1", a.id);
    settleInjected("turn:2", []);
    const q = readDraft("c1").queue;
    expect(q.map((r) => r.text)).toEqual(["stop that"]);
    expect(q[0]!.inject).toBeUndefined();
  });

  it("does nothing to a row never sent into the turn", () => {
    const a = enqueueMessage("c1", "x", []);
    markSendNow("c1", a.id);
    expect(readDraft("c1").queue[0]!.inject).toBeUndefined();
  });
});

describe("relay to a running subagent (339)", () => {
  const tool = (id: string, done: boolean): Segment => ({
    kind: "tool",
    call: { id, name: "Bash", input: {}, result: done ? { content: "ok", is_error: false } : null },
  });

  it("arrives once the agent finishes a call after the relay", () => {
    const segs: Segment[] = [tool("t1", false)];
    recordRelay("a8bb", { text: "skip June", at: 1, ok: true, detail: "queued", segAt: segs.length });
    const r = relays["a8bb"]![0]!;
    expect(relayArrived(r, segs)).toBe(false);
    // The call running at the relay finishing is not yet the sign.
    segs[0] = tool("t1", true);
    expect(relayArrived(r, segs)).toBe(false);
    segs.push(tool("t2", false));
    expect(relayArrived(r, segs)).toBe(false);
    segs[1] = tool("t2", true);
    expect(relayArrived(r, segs)).toBe(true);
  });

  it("words of its own quoting the message also show it arrived; a refused relay never does", () => {
    const segs: Segment[] = [];
    const ok = { text: "skip June", at: 1, ok: true, detail: "", segAt: 0 };
    expect(relayArrived(ok, [...segs, { kind: "text", text: "Noted — I will skip June." }])).toBe(true);
    expect(relayArrived({ ...ok, ok: false }, [tool("t", true)])).toBe(false);
  });
});
