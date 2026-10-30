// Item 474: the phone draws the CLI's retry line, the Mac's rules
// (items 440 + 441): one line updated per try, gone at the first word or
// call, "stopping" after Stop with later tries leaving it.
import { describe, expect, it } from "vitest";
import { emptyTurn, foldTurnEvent, retryStopping } from "./client";
import { retryText } from "../lib/retryLine";
import type { TurnEvent } from "../lib/types";

const retry = (attempt: number): TurnEvent => ({
  type: "retry",
  attempt,
  max_retries: 10,
  error: "unknown",
  status: null,
  delay_ms: 2000,
  waited_ms: null,
});

describe("the phone's retry line (474)", () => {
  it("is one line, updated in place on each try", () => {
    let live = foldTurnEvent(emptyTurn(), retry(1));
    expect(live.retry && retryText(live.retry)).toBe("Can't reach Claude — no connection · retrying (1/10)…");
    live = foldTurnEvent(live, retry(2));
    expect(live.retry?.attempt).toBe(2);
    expect(retryText(live.retry!)).toContain("(2/10)");
  });

  it("goes at the reply's first word", () => {
    let live = foldTurnEvent(emptyTurn(), retry(3));
    live = foldTurnEvent(live, { type: "text_delta", text: "Hi" } as TurnEvent);
    expect(live.retry).toBeNull();
    expect(live.text).toBe("Hi");
  });

  it("goes at the reply's first call", () => {
    let live = foldTurnEvent(emptyTurn(), retry(1));
    live = foldTurnEvent(live, { type: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } } as TurnEvent);
    expect(live.retry).toBeNull();
    expect(live.tools).toHaveLength(1);
  });

  it("says stopping after Stop, and later tries leave it", () => {
    let live = foldTurnEvent(emptyTurn(), retry(4));
    live = retryStopping(live)!;
    expect(retryText(live.retry!)).toBe("Can't reach Claude — no connection — stopping");
    const after = foldTurnEvent(live, retry(5));
    expect(after.retry?.attempt).toBe(4);
    expect(after.retry?.stopping).toBe(true);
  });

  it("leaves a turn with no retry as it is on Stop", () => {
    const live = emptyTurn();
    expect(retryStopping(live)).toBe(live);
    expect(retryStopping(null)).toBeNull();
  });

  it("does not change the object it was given", () => {
    const first = foldTurnEvent(emptyTurn(), retry(1));
    foldTurnEvent(first, retry(2));
    expect(first.retry?.attempt).toBe(1);
  });
});
