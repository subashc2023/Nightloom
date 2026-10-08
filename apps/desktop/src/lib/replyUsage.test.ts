import { describe, expect, it } from "vitest";
import { byTarget, fmtEstimate, replyUsageView, type TurnUsageLine } from "./replyUsage";
import assistantSrc from "./AssistantMessage.svelte?raw";
import transcriptSrc from "./Transcript.svelte?raw";

const line = (over: Partial<TurnUsageLine> = {}): TurnUsageLine => ({
  target: 4,
  started_at_ms: 0,
  ended_at_ms: 1,
  five_hour: { start: 41, end: 45 },
  seven_day: { start: 12, end: 13 },
  shared: false,
  cost_usd: 0.4,
  est: null,
  start_at_ms: Date.UTC(2026, 9, 8, 16, 0),
  end_at_ms: Date.UTC(2026, 9, 8, 16, 5),
  ...over,
});

// Item 323: "5h +N% · week +M%" under each finished reply.
describe("replyUsageView", () => {
  it("shows both windows' measured rise", () => {
    expect(replyUsageView(line())?.text).toBe("5h +4% · week +1%");
  });
  it("shows nothing without a line or without readings", () => {
    expect(replyUsageView(null)).toBeNull();
    expect(replyUsageView(line({ five_hour: null, seven_day: null }))).toBeNull();
  });
  it("leaves out a window that has no span (a reset between the readings)", () => {
    expect(replyUsageView(line({ seven_day: null }))?.text).toBe("5h +4%");
  });
  it("says shared when another chat's turn ran in between and there is no estimate", () => {
    const v = replyUsageView(line({ shared: true }))!;
    expect(v.text).toBe("5h +4% · week +1% (shared)");
    expect(v.title).toMatch(/another chat's turn ran in between/);
  });
  it("uses the estimate, marked ≈, when the measured rise is 0 or shared", () => {
    const est = { five_hour: 0.34, seven_day: 0.04, replies: 9 };
    expect(replyUsageView(line({ five_hour: { start: 41, end: 41 }, seven_day: { start: 12, end: 12 }, est }))?.text).toBe(
      "5h ≈+0.3% · week ≈<0.1%",
    );
    expect(replyUsageView(line({ shared: true, est }))?.text).toBe("5h ≈+0.3% · week ≈<0.1%");
    // Measured and alone: the measured figure, the estimate on hover.
    const v = replyUsageView(line({ est }))!;
    expect(v.text).toBe("5h +4% · week +1%");
    expect(v.title).toMatch(/9 replies that ran alone: 5h ≈0\.3%, week ≈<0\.1%/);
  });
  it("names both readings and their times on hover", () => {
    const t = replyUsageView(line())!.title;
    expect(t).toMatch(/5-hour window 41% → 45% \(\+4%\), week 12% → 13% \(\+1%\)/);
    expect(t).toMatch(/whole percents/);
  });
});

describe("fmtEstimate and byTarget", () => {
  it("formats an estimate", () => {
    expect(fmtEstimate(0.01)).toBe("<0.1");
    expect(fmtEstimate(2.345)).toBe("2.3");
    expect(fmtEstimate(12.6)).toBe("13");
  });
  it("keys lines by their reply, the latest winning", () => {
    const m = byTarget([line({ target: 2 }), line({ target: 5 }), line({ target: 2, shared: true })]);
    expect(m.size).toBe(2);
    expect(m.get(2)?.shared).toBe(true);
  });
});

describe("the footer row carries it", () => {
  it("AssistantMessage draws the figure in the footer with its hover text", () => {
    expect(assistantSrc).toMatch(/planUsage\?: ReplyUsageView \| null/);
    expect(assistantSrc).toMatch(/class="meta plan" use:tip=\{planUsage\.title\}>\{planUsage\.text\}/);
  });
  it("the transcript passes each reply its line", () => {
    expect(transcriptSrc).toMatch(/planUsage=\{replyUsageView\(usageLines\.get\(item\.index\)\)\}/);
  });
});
