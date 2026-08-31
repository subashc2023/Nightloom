import { beforeEach, describe, expect, it } from "vitest";
import { app, currentTodos, liveFlags, roundCost } from "./state.svelte";
import type { Price, SessionEvent, TodoItem, Usage } from "./types";

// These three functions are hand-written copies of backend logic —
// `Session::live_flags`, `Session::todos` and `Price::cost`. Nothing links the
// copies to their originals, so the only thing standing between a change on
// the Rust side and a transcript that quietly disagrees with the model's own
// view of the conversation is this file.

const AT = "2026-01-01T00:00:00Z";

function user(text: string): SessionEvent {
  return { event: "user_message", text, at: AT };
}

function assistant(text: string, cost?: number): SessionEvent {
  return {
    event: "assistant_message",
    model: "test-model",
    blocks: [{ type: "text", text }],
    stop_reason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(cost === undefined ? {} : { cost }),
    at: AT,
  };
}

function rewind(to: number): SessionEvent {
  return { event: "rewind", to, at: AT };
}

function todos(...contents: string[]): SessionEvent {
  const items: TodoItem[] = contents.map((content) => ({
    content,
    status: "pending",
  }));
  return { event: "todo_state", todos: items, at: AT };
}

function compaction(): SessionEvent {
  return { event: "compaction", summary: "…", at: AT };
}

describe("liveFlags", () => {
  it("leaves a log with no rewind entirely live", () => {
    // The common case, and the one that would make every other assertion here
    // meaningless if it regressed: a transcript with nothing superseded must
    // grey nothing out.
    expect(liveFlags([user("one"), assistant("first")])).toEqual([true, true]);
  });

  it("drops the marker itself along with the range it covers", () => {
    // The marker is not part of the conversation. Rendering it as a live
    // event would put an empty turn in the transcript that the model's own
    // message list does not have.
    const events = [user("one"), assistant("first"), rewind(0)];
    expect(liveFlags(events)).toEqual([false, false, false]);
  });

  it("keeps everything recorded after the marker", () => {
    // A rewind reaches backwards only. Letting it kill later events would
    // blank the transcript from the first rewind onwards, forever.
    const events = [user("one"), assistant("first"), rewind(0), user("two")];
    expect(liveFlags(events)).toEqual([false, false, false, true]);
  });

  it("composes overlapping rewinds as a union", () => {
    // Mirrors `rewinds_chain_and_the_wider_one_wins`. The second rewind
    // reaches back over ground the first already cleared; taking the newest
    // range alone — or the narrowest — would resurrect turns the user removed.
    const events = [
      user("one"),
      assistant("first"),
      user("two"),
      assistant("second"),
      user("three"),
      assistant("third"),
      rewind(4),
      rewind(0),
    ];
    expect(liveFlags(events)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("leaves events before the earliest rewind point alone", () => {
    // The narrow half of the union: a rewind to the middle must not be read
    // as a reset. Everything before `to` is still the conversation.
    const events = [
      user("one"),
      assistant("first"),
      user("two"),
      assistant("second"),
      rewind(2),
    ];
    expect(liveFlags(events)).toEqual([true, true, false, false, false]);
  });

  it("handles two disjoint rewinds without touching the live span between", () => {
    // Two separate undos over a long session. A loop that tracked one "oldest
    // rewound index" rather than per-event flags would swallow the turn that
    // survives in the middle here.
    const events = [
      user("one"), // 0
      assistant("first"), // 1
      rewind(0), // 2
      user("two"), // 3
      assistant("second"), // 4
      user("three"), // 5
      assistant("third"), // 6
      rewind(5), // 7
    ];
    expect(liveFlags(events)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("currentTodos", () => {
  beforeEach(() => {
    app.events = [];
  });

  it("takes the latest snapshot rather than the first", () => {
    // The log is append-only, so every list the model ever wrote is still in
    // it. Scanning forwards would pin the task panel to the opening plan.
    app.events = [todos("first"), todos("second")];
    expect(currentTodos().map((t) => t.content)).toEqual(["second"]);
  });

  it("is cleared by a compaction that follows the list", () => {
    // Mirrors `todos_take_the_latest_state_and_reset_on_compaction`: the
    // summary supersedes the plan that produced it, so a list surviving one
    // describes work the model can no longer see.
    app.events = [todos("first"), compaction()];
    expect(currentTodos()).toEqual([]);
  });

  it("takes a list written after a compaction", () => {
    // The reverse scan stops at whichever comes last. Treating compaction as
    // a permanent off-switch would leave the panel empty for the rest of the
    // session.
    app.events = [todos("old"), compaction(), todos("new")];
    expect(currentTodos().map((t) => t.content)).toEqual(["new"]);
  });

  it("reverts to the earlier list when the newer one is rewound away", () => {
    // Mirrors `a_rewound_task_list_reverts_to_the_earlier_one`. Reading the
    // raw log instead of the live projection would show a plan for a turn
    // that no longer happened.
    app.events = [todos("first"), todos("second"), rewind(1)];
    expect(currentTodos().map((t) => t.content)).toEqual(["first"]);
  });

  it("ignores a compaction that a rewind superseded", () => {
    // The compaction is in the log but not in the conversation, so it must
    // not go on clearing a list that is live again.
    app.events = [todos("first"), compaction(), rewind(1)];
    expect(currentTodos().map((t) => t.content)).toEqual(["first"]);
  });
});

describe("roundCost", () => {
  const price: Price = {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write: 3.75,
  };

  function usage(u: Partial<Usage>): Usage {
    return { input_tokens: 0, output_tokens: 0, ...u };
  }

  it("bills the three input slices disjointly", () => {
    // `input_tokens` is the whole prompt and the cache counters are subsets of
    // it. Charging the full rate on all 1M and the cache rates on top would
    // roughly double every figure the cost readout shows.
    const cost = roundCost(
      usage({
        input_tokens: 1_000_000,
        cache_read_tokens: 600_000,
        cache_write_tokens: 100_000,
        output_tokens: 1_000_000,
      }),
      price,
    );
    // 0.3M fresh @3 + 0.6M read @0.3 + 0.1M write @3.75 + 1M out @15
    expect(cost).toBeCloseTo(0.9 + 0.18 + 0.375 + 15, 10);
  });

  it("falls back to the input rate when a price lists no cache rates", () => {
    // Mirrors `cache_read.unwrap_or(self.input)`. Treating an absent cache
    // rate as free would report a cached-heavy session on an uncached-price
    // model as costing almost nothing.
    const flat: Price = { input: 10, output: 30 };
    const cost = roundCost(
      usage({
        input_tokens: 1_000_000,
        cache_read_tokens: 900_000,
        output_tokens: 0,
      }),
      flat,
    );
    expect(cost).toBeCloseTo(10, 10);
  });

  it("charges the whole prompt at full rate when the host reports no caching", () => {
    // Absent counters are not zeroed subsets of a cached prompt; they mean
    // there was no cache. The fresh slice has to be the entire input.
    const cost = roundCost(
      usage({ input_tokens: 1_000_000, output_tokens: 0 }),
      price,
    );
    expect(cost).toBeCloseTo(3, 10);
  });

  it("floors the fresh slice at zero when the counters exceed the prompt", () => {
    // Mirrors `saturating_sub`. In JS the subtraction goes negative instead of
    // saturating, and a negative slice would subtract real money from the
    // total — an adapter bug showing up as a discount.
    const cost = roundCost(
      usage({
        input_tokens: 100,
        cache_read_tokens: 1_000_000,
        output_tokens: 0,
      }),
      price,
    );
    expect(cost).toBeCloseTo((1_000_000 * 0.3) / 1e6, 10);
  });

  it("treats an explicitly null cache rate as absent", () => {
    // The Rust side is `Option<f64>`; over the wire that arrives as `null`,
    // and `?? p.input` has to catch it. `cache_read ?? input` would silently
    // bill 0/MTok if this were written `cache_read || input` with a real 0.
    const nulled: Price = {
      input: 10,
      output: 30,
      cache_read: null,
      cache_write: null,
    };
    const cost = roundCost(
      usage({
        input_tokens: 1_000_000,
        cache_read_tokens: 1_000_000,
        output_tokens: 0,
      }),
      nulled,
    );
    expect(cost).toBeCloseTo(10, 10);
  });
});
