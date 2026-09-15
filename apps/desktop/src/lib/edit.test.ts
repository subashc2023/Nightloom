import { describe, expect, it } from "vitest";
import {
  editButtons,
  editLine,
  editReduce,
  editTexts,
  elideFlags,
  forkLine,
  isEditable,
  type EditState,
} from "./edit";
import { cacheState } from "./cache";
import type { SessionEvent, SessionMeta } from "./types";

const at = "2026-09-15T10:00:00Z";
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const reply = (text: string, tool = false): SessionEvent => ({
  event: "assistant_message",
  model: "m",
  blocks: [
    { type: "text", text },
    ...(tool ? [{ type: "tool_use" as const, id: "c1", name: "read_file", input: {} }] : []),
  ],
  stop_reason: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  at,
});

// 0 created, 1 user, 2 reply, 3 user, 4 reply with a call, 5 tool result.
const log: SessionEvent[] = [
  { event: "session_created", id: "s", at },
  user("first"),
  reply("one"),
  user("second"),
  reply("looking", true),
  { event: "tool_result", tool_use_id: "c1", name: "read_file", content: "x", at },
];

describe("editTexts", () => {
  it("projects the latest live edit and nothing for the rest", () => {
    const events: SessionEvent[] = [
      ...log,
      { event: "edit", target: 1, text: "first, edited", at },
      { event: "edit", target: 1, text: "first, edited twice", at },
      { event: "edit", target: 2, text: "uno", at },
    ];
    const texts = editTexts(events);
    expect(texts[1]).toBe("first, edited twice");
    expect(texts[2]).toBe("uno");
    expect(texts[3]).toBeNull();
    expect(texts.length).toBe(events.length);
  });

  it("is undone by a rewind past the marker", () => {
    const events: SessionEvent[] = [
      ...log,
      { event: "edit", target: 1, text: "first, edited", at },
      { event: "rewind", to: 3, at },
    ];
    expect(editTexts(events)[1]).toBeNull();
  });
});

describe("elideFlags", () => {
  it("applies elide and unelide in order, live markers only", () => {
    const events: SessionEvent[] = [
      ...log,
      { event: "elide", targets: [1, 2], at },
      { event: "unelide", targets: [1], at },
    ];
    const flags = elideFlags(events);
    expect(flags[1]).toBe(false);
    expect(flags[2]).toBe(true);
    const undone: SessionEvent[] = [...events, { event: "rewind", to: 3, at }];
    expect(elideFlags(undone)[2]).toBe(false);
  });
});

describe("isEditable", () => {
  it("allows user turns and text-only replies, refuses calls and results", () => {
    expect(isEditable(log, 1)).toBe(true);
    expect(isEditable(log, 2)).toBe(true);
    expect(isEditable(log, 4)).toBe(false);
    expect(isEditable(log, 5)).toBe(false);
    expect(isEditable(log, 0)).toBe(false);
    expect(isEditable(log, 99)).toBe(false);
  });
});

describe("editLine", () => {
  it("says warm with the time left, or cold", () => {
    const T0 = Date.parse(at);
    const warm: SessionEvent[] = [
      user("q"),
      {
        event: "assistant_message",
        model: "m",
        blocks: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        sent_at: new Date(T0).toISOString(),
        cache_ttl: "1h",
        at,
      },
    ];
    expect(editLine(cacheState(warm, T0 + 19 * 60_000))).toBe(
      "cache warm · 41 min — this re-writes the history after this turn",
    );
    expect(editLine(cacheState(warm, T0 + 61 * 60_000))).toBe("cache cold — edit freely");
    expect(editLine(null)).toBe("cache cold — edit freely");
  });
});

describe("forkLine", () => {
  const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
    id,
    path: "",
    modified: at,
    user_turns: 1,
    first_user: null,
    title: null,
    ...extra,
  });
  it("names the parent the way its own row is named", () => {
    const parent = meta("p", { title: "The parent", first_user: "opening words" });
    const fork = meta("f", { forked_from: { session: "p", index: 3 } });
    expect(forkLine(fork, [parent, fork])).toBe("from The parent");
    const unnamed = meta("p", { first_user: "opening   words\nhere" });
    expect(forkLine(fork, [unnamed, fork])).toBe("from opening words here");
  });
  it("says when the parent is gone, and nothing for a chat that is not a fork", () => {
    const fork = meta("f", { forked_from: { session: "p", index: 3 } });
    expect(forkLine(fork, [fork])).toBe("from a deleted chat");
    expect(forkLine(meta("plain"), [])).toBeNull();
  });
  it("clips a long name", () => {
    const parent = meta("p", { title: "x".repeat(80) });
    const fork = meta("f", { forked_from: { session: "p", index: 1 } });
    const line = forkLine(fork, [parent, fork], 20)!;
    expect(line.startsWith("from ")).toBe(true);
    expect(line.length).toBe("from ".length + 20);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("the editor's state machine", () => {
  it("opens one turn at a time, tracks the draft, and closes on every exit", () => {
    let s: EditState = null;
    expect(editButtons(s)).toEqual({ save: false, send: false });
    s = editReduce(s, { type: "begin", index: 1, text: "first" });
    expect(s).toEqual({ index: 1, original: "first", draft: "first" });
    // Unchanged: nothing to save, still something to send.
    expect(editButtons(s)).toEqual({ save: false, send: true });
    s = editReduce(s, { type: "draft", text: "first, edited" });
    expect(editButtons(s)).toEqual({ save: true, send: true });
    s = editReduce(s, { type: "draft", text: "   " });
    expect(editButtons(s)).toEqual({ save: false, send: false });
    // Opening another turn replaces the first.
    s = editReduce(s, { type: "begin", index: 3, text: "second" });
    expect(s?.index).toBe(3);
    expect(editReduce(s, { type: "cancel" })).toBeNull();
    expect(editReduce(s, { type: "done" })).toBeNull();
    expect(editReduce(s, { type: "busy" })).toBeNull();
    // A draft with nothing open stays nothing.
    expect(editReduce(null, { type: "draft", text: "x" })).toBeNull();
  });
});
