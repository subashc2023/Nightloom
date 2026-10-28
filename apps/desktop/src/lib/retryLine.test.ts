import { beforeEach, describe, expect, it } from "vitest";
import { app, applyTurnEvent } from "./state.svelte";
import {
  applyRetry,
  clearRetry,
  markRetryStopping,
  retryText,
  turnNotices,
  type RetryEvent,
  type RetrySegment,
} from "./retryLine";
import messageSrc from "./AssistantMessage.svelte?raw";
import stateSrc from "./state.svelte.ts?raw";

/**
 * Items 440 + 441 (2026-10-27, his screenshot): offline, a send stalled
 * with only the ticking clock, and Stop pressed at once ended in five
 * "retrying after unknown (n/10)" toasts and "interrupted — Claude Code
 * ended the turn". The CLI calls a failed connection `unknown`, with no
 * HTTP status (CLI 2.1.312's `api_retry`).
 */
const offline = (attempt: number): RetryEvent => ({
  type: "retry",
  attempt,
  max_retries: 10,
  error: "unknown",
  status: null,
  delay_ms: 500 * 2 ** (attempt - 1),
  waited_ms: null,
});
const seg = (over: Partial<RetrySegment> = {}): RetrySegment => ({
  kind: "retry",
  attempt: 2,
  max: 10,
  error: "unknown",
  status: null,
  delayMs: 1000,
  waitedMs: null,
  ...over,
});

describe("440: the line says why, in words", () => {
  it("a failed connection is said as one, never 'unknown'", () => {
    expect(retryText(seg())).toBe("Can't reach Claude — no connection · retrying (2/10)…");
    expect(retryText(seg({ error: null }))).toContain("Can't reach Claude");
  });
  it("a call with no response at all says how long it waited", () => {
    expect(retryText(seg({ waitedMs: 60000 }))).toBe("Claude didn't answer in 60 s · retrying (2/10)…");
  });
  it("the real reason when the CLI gave one", () => {
    expect(retryText(seg({ error: "overloaded", status: 529 }))).toBe("Claude is overloaded (HTTP 529) · retrying (2/10)…");
    expect(retryText(seg({ error: "rate_limit", status: 429 }))).toContain("Rate limited by Anthropic (HTTP 429)");
    expect(retryText(seg({ error: "server_error", status: 500 }))).toContain("Anthropic's server returned an error (HTTP 500)");
    expect(retryText(seg({ error: "unknown", status: 418 }))).toContain("The call to Claude failed (HTTP 418)");
  });
  it("stopping", () => {
    expect(retryText(seg({ stopping: true }))).toBe("Can't reach Claude — no connection — stopping");
  });
});

describe("441: one line, updated in place", () => {
  it("five tries leave one segment reading the last", () => {
    const segs: { kind: string }[] = [];
    for (let n = 1; n <= 5; n++) applyRetry(segs, offline(n));
    expect(segs).toHaveLength(1);
    expect(retryText(segs[0] as RetrySegment)).toContain("(5/10)");
  });
  it("Stop freezes it: later tries leave it saying stopping", () => {
    const segs: { kind: string }[] = [];
    applyRetry(segs, offline(1));
    expect(markRetryStopping(segs)).toBe(true);
    expect(applyRetry(segs, offline(2))).toBe(false);
    expect(retryText(segs[0] as RetrySegment)).toBe("Can't reach Claude — no connection — stopping");
    expect(markRetryStopping([])).toBe(false);
    expect(markRetryStopping(null)).toBe(false);
  });
  it("goes when the reply arrives", () => {
    const segs: { kind: string }[] = [{ kind: "notice" }];
    applyRetry(segs, offline(1));
    expect(clearRetry(segs)).toBe(true);
    expect(segs).toEqual([{ kind: "notice" }]);
    expect(clearRetry(segs)).toBe(false);
  });
});

describe("441: what a returned turn toasts", () => {
  const stop = "interrupted — Claude Code ended the turn";
  it("a Stop he pressed toasts nothing — the reply's own stopped mark says it", () => {
    expect(turnNotices([stop], true)).toEqual([]);
    expect(turnNotices(["interrupted"], true)).toEqual([]);
  });
  it("his screenshot's stack, from an older service, toasts nothing on his Stop", () => {
    const stack = [1, 2, 3, 4, 5].map((n) => `retrying after unknown (${n}/10)`);
    expect(turnNotices([...stack, stop], true)).toEqual([]);
  });
  it("a kill after an unanswered interrupt is still news; a stop not his still says so", () => {
    const killed = "interrupted — killed after the interrupt went unanswered";
    expect(turnNotices([killed], true)).toEqual([killed]);
    expect(turnNotices([stop], false)).toEqual([stop]);
    expect(turnNotices(["API Error: Connection error."], true)).toEqual(["API Error: Connection error."]);
  });
});

describe("440 + 441: the retry event in the live reply", () => {
  beforeEach(() => {
    app.toasts = [];
    app.activeSessionId = null;
    app.parked = null;
    app.live = { segments: [] };
  });

  it("each try updates one line, no toast; the first word clears it", () => {
    for (let n = 1; n <= 5; n++) applyTurnEvent(offline(n));
    const segs = app.live!.segments;
    expect(segs.filter((s) => s.kind === "retry")).toHaveLength(1);
    expect(retryText(segs[0] as RetrySegment)).toBe("Can't reach Claude — no connection · retrying (5/10)…");
    expect(app.toasts).toHaveLength(0);
    applyTurnEvent({ type: "text_delta", text: "Hello" });
    expect(app.live!.segments.map((s) => s.kind)).toEqual(["text"]);
  });

  it("the wiring: the reply draws it, Stop marks it, the turn's notices are filtered", () => {
    expect(messageSrc).toContain('{:else if g.seg.kind === "retry"}');
    expect(messageSrc).toContain("<RetryLine seg={g.seg} />");
    expect(stateSrc).toContain("markRetryStopping(liveHost(app).live?.segments)");
    expect(stateSrc).toContain("turnNotices(res.notices, stopped)");
    expect(stateSrc).toContain("turnNotices(res?.notices ?? [], t.stopped === true)");
    expect(stateSrc).not.toContain("for (const notice of res.notices) addToast(notice)");
  });
});
