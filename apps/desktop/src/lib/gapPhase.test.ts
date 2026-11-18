import { describe, expect, it } from "vitest";
import { gapLead, gapPhase, type LiveContext } from "./liveContext";
import { waitingLabel } from "./activity";
import { shortTokens } from "./contextDial";

// Item 829: the 'working · N s' gap says what the model is doing.
const reading = (o: Partial<LiveContext>): LiveContext => ({ exact: 210_000, estimate: 0, rough: false, steps: 1, at: 1000, roundAt: 1000, writing: 0, ...o });

describe("gapPhase (829)", () => {
  it("reads the chat from the send until the first round starts", () => {
    expect(gapPhase(null, { sentAt: 500, resultAt: null, callAt: null })).toEqual({ kind: "reading", tokens: null });
  });
  it("reads the chat again after a result, until the next round starts", () => {
    const r = reading({ at: 3000, roundAt: 1000, estimate: 300 });
    expect(gapPhase(r, { sentAt: 500, resultAt: 2500, callAt: 2000 })).toEqual({ kind: "reading", tokens: 210_300 });
    // The next round's exact figure ends it.
    expect(gapPhase(reading({ at: 4000, roundAt: 4000, steps: 2 }), { sentAt: 500, resultAt: 2500, callAt: 2000 })).toBeNull();
  });
  it("is writing a call while arguments stream and no call has landed since", () => {
    const r = reading({ at: 5000, roundAt: 4000, writing: 3100 });
    expect(gapPhase(r, { sentAt: 500, resultAt: 2500, callAt: 2000 })).toEqual({ kind: "writing", chars: 3100 });
    // The call landed whole: its row shows it now (and the tool runs).
    expect(gapPhase(r, { sentAt: 500, resultAt: 2500, callAt: 5500 })).toBeNull();
  });
  it("leads the working line, the clock kept; agents still win", () => {
    expect(waitingLabel(null, 41_000, gapLead({ kind: "reading", tokens: 210_000 }, shortTokens))).toBe(`reading the chat (${shortTokens(210_000)}) · 41 s`);
    expect(waitingLabel(null, 9_000, gapLead({ kind: "writing", chars: 3100 }, shortTokens))).toBe("writing a call · 3.1k chars · 9 s");
    expect(waitingLabel(null, 9_000, gapLead({ kind: "writing", chars: 640 }, shortTokens))).toBe("writing a call · 640 chars · 9 s");
    expect(waitingLabel(null, 9_000, gapLead(null, shortTokens))).toBe("working · 9 s");
    expect(waitingLabel(2, 9_000, "reading the chat")).toBe("waiting on 2 agents · 9 s");
  });
});
