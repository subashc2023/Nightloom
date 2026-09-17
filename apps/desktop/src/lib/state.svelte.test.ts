import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  app,
  chatMode,
  clockOf,
  currentTodos,
  liveFlags,
  MODE_GLYPH,
  MODE_LINES,
  newChatLabel,
  newChatSelected,
  newSession,
  chatKind,
  defaultKind,
  kindLabel,
  planUsageFromTurn,
  promptLayerEdits,
  promptLayersOff,
  roundCost,
  sameEdits,
  sameLayers,
} from "./state.svelte";
import type {
  Price,
  PromptLayer,
  PromptLayerEdits,
  SessionEvent,
  TodoItem,
  Usage,
} from "./types";
import * as api from "./api";

// The backend, as far as `newSession` reaches it: the two commands New chat
// used to call (create, then list) and the one it still calls. Everything
// else in `./api` is the real module, since nothing here invokes it.
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  newSession: vi.fn(async (mode?: "normal" | "incognito" | "ephemeral", kind?: "build" | "chat") => ({
    mode: mode ?? "normal",
    kind: kind ?? "build",
  })),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

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

function layers(...off: PromptLayer[]): SessionEvent {
  return { event: "prompt_layers", off, at: AT };
}

// A copy of `Session::prompt_layers_off`, on the same terms as the todos:
// the popover's switches project this, and the backend builds the prompt
// from its own, so a disagreement is a switch that lies.
describe("promptLayersOff", () => {
  it("is every layer on until the chat says otherwise", () => {
    expect(promptLayersOff([user("one"), assistant("first")])).toEqual([]);
  });

  it("takes the latest set rather than the first", () => {
    const events = [layers("project_notes"), user("one"), layers("identity", "knowledge")];
    expect(promptLayersOff(events)).toEqual(["identity", "knowledge"]);
  });

  it("outlives a compaction, unlike the task list", () => {
    // The chat is the same chat after a summary; a blind test does not stop
    // being blind because its history was condensed.
    const events = [layers("project_instructions"), user("one"), assistant("first"), compaction()];
    expect(promptLayersOff(events)).toEqual(["project_instructions"]);
  });

  it("reverts to the earlier set when the newer one is rewound away", () => {
    const events = [
      layers("user_memory"),
      user("one"),
      assistant("first"),
      layers("environment"),
      user("two"),
      assistant("second"),
      // Back to before the first turn: the second set was recorded after
      // it, so it goes with it, and the model knows what it knew then.
      rewind(1),
    ];
    expect(promptLayersOff(events)).toEqual(["user_memory"]);
  });
});

// The mode is the first line's, projected the way `Session::mode()` is:
// what the top bar marks, the Context page says, and the reconnect strips
// the engine's writers on — the three must read one source.
describe("chatMode", () => {
  const created = (mode?: "normal" | "incognito" | "ephemeral"): SessionEvent => ({
    event: "session_created",
    id: "abc",
    at: "2026-09-15T00:00:00Z",
    ...(mode ? { mode } : {}),
  });

  beforeEach(() => {
    app.pendingMode = "normal";
  });

  it("is normal for no chat, and for a log written before the field existed", () => {
    expect(chatMode([])).toBe("normal");
    expect(chatMode([created(), user("one")])).toBe("normal");
  });

  it("is the pending kind while there is no chat (nightshift backlog 061)", () => {
    // New chat is a state: no creation line yet, so the top bar's mark and
    // the Context caveat read what the first message will create.
    app.pendingMode = "incognito";
    expect(chatMode([])).toBe("incognito");
    app.pendingMode = "ephemeral";
    expect(chatMode([])).toBe("ephemeral");
    // And the line, once it exists, wins over whatever is still pending.
    expect(chatMode([created(), user("one")])).toBe("normal");
    expect(chatMode([created("incognito")])).toBe("incognito");
  });

  it("reads the creation line's mode", () => {
    expect(chatMode([created("incognito"), user("one")])).toBe("incognito");
    expect(chatMode([created("ephemeral")])).toBe("ephemeral");
  });

  it("is not something a rewind can reach", () => {
    const events = [created("incognito"), user("one"), assistant("first"), rewind(1)];
    expect(chatMode(events)).toBe("incognito");
  });

  it("marks the two non-normal kinds and not the ordinary one", () => {
    expect(MODE_GLYPH.normal).toBe("");
    expect(MODE_GLYPH.incognito).not.toBe("");
    expect(MODE_GLYPH.ephemeral).not.toBe("");
    expect(MODE_GLYPH.incognito).not.toBe(MODE_GLYPH.ephemeral);
    // One line each, and each says the thing it drops.
    expect(MODE_LINES.incognito).toMatch(/writes nothing/);
    expect(MODE_LINES.incognito).toMatch(/unread by other chats/);
    expect(MODE_LINES.ephemeral).toMatch(/nothing is kept/);
  });
});

describe("sameLayers", () => {
  it("compares as sets, in the order the backend normalizes to", () => {
    expect(sameLayers(["knowledge", "identity"], ["identity", "knowledge"])).toBe(true);
    expect(sameLayers(["identity", "identity"], ["identity"])).toBe(true);
    expect(sameLayers([], [])).toBe(true);
    expect(sameLayers(["identity"], [])).toBe(false);
    expect(sameLayers(["identity"], ["environment"])).toBe(false);
  });
});

function edited(off: PromptLayer[], edits: PromptLayerEdits): SessionEvent {
  return { event: "prompt_layers", off, edits, at: AT };
}

// A copy of `Session::prompt_layer_edits`, under the same event as the off
// set and on the same terms: the cards say "edited for this chat" off this,
// and the backend assembles the prompt off its own.
describe("promptLayerEdits", () => {
  it("is no override until the chat says otherwise, including on a line without the field", () => {
    expect(promptLayerEdits([user("one"), assistant("first")])).toEqual({});
    // A `prompt_layers` line written before `edits` existed.
    expect(promptLayerEdits([layers("identity")])).toEqual({});
  });

  it("takes the latest event's map, whole", () => {
    const events = [
      edited([], { user_memory: "first" }),
      user("one"),
      edited(["knowledge"], { model_instructions: "second" }),
    ];
    // The map is replaced, not merged: the earlier memory text is gone.
    expect(promptLayerEdits(events)).toEqual({ model_instructions: "second" });
    expect(promptLayersOff(events)).toEqual(["knowledge"]);
  });

  it("outlives a compaction and is undone by a rewind, like the off set", () => {
    const kept = [edited([], { user_memory: "own" }), user("one"), assistant("first"), compaction()];
    expect(promptLayerEdits(kept)).toEqual({ user_memory: "own" });
    const wound = [
      edited([], { user_memory: "first" }),
      user("one"),
      assistant("first"),
      edited([], { user_memory: "second" }),
      user("two"),
      assistant("second"),
      rewind(1),
    ];
    expect(promptLayerEdits(wound)).toEqual({ user_memory: "first" });
  });
});

describe("sameEdits", () => {
  it("compares kind by kind, ignoring key order and absent-vs-undefined", () => {
    expect(sameEdits({}, {})).toBe(true);
    expect(sameEdits({ user_memory: "a" }, { user_memory: "a" })).toBe(true);
    expect(
      sameEdits(
        { user_memory: "a", project_instructions: "b" },
        { project_instructions: "b", user_memory: "a" },
      ),
    ).toBe(true);
    expect(sameEdits({ user_memory: undefined }, {})).toBe(true);
    expect(sameEdits({ user_memory: "a" }, { user_memory: "b" })).toBe(false);
    expect(sameEdits({ user_memory: "a" }, {})).toBe(false);
    expect(sameEdits({ user_memory: "a" }, { model_instructions: "a" })).toBe(false);
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

describe("clockOf — the Start field's and the chip's time", () => {
  it("is the local clock time, with 'tomorrow' when the day differs", () => {
    const now = new Date(2026, 8, 12, 0, 40); // 2026-09-12 00:40 local
    const later = new Date(2026, 8, 12, 5, 12).getTime();
    expect(clockOf(later, now)).toBe("at 05:12");
    const next = new Date(2026, 8, 13, 0, 5).getTime();
    expect(clockOf(next, now)).toBe("at 00:05 tomorrow");
  });
});

// New chat is a state, not a file (nightshift backlog 061, 2026-09-15): the
// click sets the pending kind and clears the chat, creates nothing, refreshes
// nothing, and the sidebar's button is the selected item until the first
// message lands a row. The button's two projections are pinned here rather
// than the component, which this suite has no DOM to mount.
describe("newSession — a state, not a file", () => {
  beforeEach(() => {
    vi.mocked(api.newSession).mockClear();
    vi.mocked(api.listSessions).mockClear();
    vi.mocked(api.transcript).mockClear();
    app.busy = false;
    app.activeSessionId = "abc";
    app.events = [
      { event: "session_created", id: "abc", at: AT },
      user("one"),
    ];
    app.pendingMode = "normal";
  });

  it("leaves no chat open and records the kind, and the button is selected", async () => {
    await newSession("incognito");
    expect(app.activeSessionId).toBeNull();
    expect(app.events).toEqual([]);
    expect(app.pendingMode).toBe("incognito");
    expect(newChatSelected()).toBe(true);
    expect(newChatLabel()).toBe(`New chat ${MODE_GLYPH.incognito}`);
    // The backend was told, so its own pending kind matches — the mode
    // and, unfiled, the default kind: a Chat (nightshift backlog 102).
    expect(api.newSession).toHaveBeenCalledWith("incognito", "chat");
  });

  // The second axis (nightshift backlog 102): Claude Code · Chat, chosen at
  // New chat like the mode, pending until the creation line answers.
  it("records the kind, defaults it from the project's folder, and the log's line wins", async () => {
    app.project = null;
    expect(defaultKind()).toBe("chat");
    await newSession(undefined, "build");
    expect(app.pendingKind).toBe("build");
    expect(chatKind(app.events)).toBe("build");
    expect(api.newSession).toHaveBeenLastCalledWith(undefined, "build");

    app.project = { id: "p", name: "P", root: "/tmp/p" } as never;
    expect(defaultKind()).toBe("build");
    await newSession("incognito");
    expect(app.pendingKind).toBe("build");
    expect(api.newSession).toHaveBeenLastCalledWith("incognito", "build");
    app.project = { id: "q", name: "Q", root: null } as never;
    expect(defaultKind()).toBe("chat");
    await newSession();
    expect(app.pendingKind).toBe("chat");
    app.project = null;

    // Once a chat is open its creation line is the answer, whatever is
    // pending; a line with no kind is a build chat, as every old log is.
    expect(chatKind([{ event: "session_created", id: "x", at: AT, kind: "chat" }])).toBe("chat");
    expect(chatKind([{ event: "session_created", id: "x", at: AT }])).toBe("build");

    // His naming: the build kind is Claude Code on the subscription
    // engine and Build on the provider engine; Chat is Chat on both.
    expect(kindLabel("build", "claude-code")).toBe("Claude Code");
    expect(kindLabel("build", "provider")).toBe("Build");
    expect(kindLabel("chat", "claude-code")).toBe("Chat");
    expect(kindLabel("chat", null)).toBe("Chat");
  });

  it("is an ordinary chat when no kind is given, and the button is plain", async () => {
    await newSession();
    expect(app.pendingMode).toBe("normal");
    expect(newChatLabel()).toBe("New chat");
    expect(newChatSelected()).toBe(true);
  });

  it("clicking twice creates and lists nothing", async () => {
    await newSession();
    await newSession("ephemeral");
    // No list refresh and no transcript fetch: there is no row and no line.
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(api.transcript).not.toHaveBeenCalled();
    expect(api.newSession).toHaveBeenCalledTimes(2);
    expect(app.activeSessionId).toBeNull();
    expect(app.pendingMode).toBe("ephemeral");
  });

  it("is not selected while a chat is open", () => {
    expect(newChatSelected()).toBe(false);
  });
});

// The plan chip from the turn (nightshift backlog 073): CLI 2.1.263's
// rate_limit_event carries both windows' share used; an older build's
// carries none, and none is no reading rather than zero.
describe("planUsageFromTurn", () => {
  it("reads both windows off unifiedWindows as whole percentages with ISO reset times", () => {
    const now = 1_789_544_000_000;
    const u = planUsageFromTurn(
      {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        resetsAt: 1789552800,
        isUsingOverage: false,
        utilization: 0.86,
        unifiedWindows: {
          five_hour: { utilization: 0.85, resetsAt: 1789551600 },
          seven_day: { utilization: 0.86, resetsAt: 1789552800 },
        },
      },
      now,
    );
    expect(u).toEqual({
      five_hour: 85,
      seven_day: 86,
      sampled_at_ms: now,
      age_seconds: 0,
      stale: false,
      five_hour_resets_at: new Date(1789551600 * 1000).toISOString(),
      seven_day_resets_at: new Date(1789552800 * 1000).toISOString(),
      source: "turn",
    });
  });

  it("is null for the 2.1.237 shape, no plan at all, or a window without a figure", () => {
    expect(planUsageFromTurn(null)).toBeNull();
    expect(
      planUsageFromTurn({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1, isUsingOverage: false }),
    ).toBeNull();
    expect(
      planUsageFromTurn({
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 1,
        isUsingOverage: false,
        unifiedWindows: { five_hour: { utilization: null, resetsAt: 1 }, seven_day: null },
      }),
    ).toBeNull();
  });
});
