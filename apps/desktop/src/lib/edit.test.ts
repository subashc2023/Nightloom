import { describe, expect, it } from "vitest";
import {
  REMOVED_TEXT_PLACEHOLDER,
  REMOVED_TOOL_PLACEHOLDER,
  blockEdits,
  blockElisions,
  displayTexts,
  editButtons,
  editChanges,
  editLine,
  editParts,
  editReduce,
  editTexts,
  elideFlags,
  forkLine,
  isEditable,
  replyText,
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
  it("projects the latest live edit of a user turn; a reply's are per block", () => {
    const events: SessionEvent[] = [
      ...log,
      { event: "edit", target: 1, text: "first, edited", at },
      { event: "edit", target: 1, text: "first, edited twice", at },
      { event: "edit", target: 2, text: "uno", at },
    ];
    const texts = editTexts(events);
    expect(texts[1]).toBe("first, edited twice");
    expect(texts[2]).toBeNull();
    expect(texts[3]).toBeNull();
    expect(texts.length).toBe(events.length);
    // 062's shape, no block: the reply's first text block.
    expect(blockEdits(events)[2]).toEqual(new Map([[0, "uno"]]));
    expect(displayTexts(events)[2]).toBe("uno");
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
  it("allows user turns and replies with text — calls or not — and refuses results", () => {
    expect(isEditable(log, 1)).toBe(true);
    expect(isEditable(log, 2)).toBe(true);
    expect(isEditable(log, 4)).toBe(true);
    expect(isEditable(log, 5)).toBe(false);
    expect(isEditable(log, 0)).toBe(false);
    expect(isEditable(log, 99)).toBe(false);
    const noText: SessionEvent[] = [
      ...log.slice(0, 4),
      { ...(reply("", true) as Extract<SessionEvent, { event: "assistant_message" }>), blocks: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }] },
    ];
    expect(isEditable(noText, 4)).toBe(false);
  });
});

// ---- One block of a reply (nightshift backlog 066) ----

// 1 user, 2 reply: thinking, "one", a call, "two"; 3 its result; 4 reply "three".
const blocky: SessionEvent[] = [
  { event: "session_created", id: "s", at },
  user("look"),
  {
    event: "assistant_message",
    model: "m",
    blocks: [
      { type: "thinking", text: "reading" },
      { type: "text", text: "one" },
      { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } },
      { type: "text", text: "two" },
    ],
    stop_reason: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    at,
  },
  { event: "tool_result", tool_use_id: "c1", name: "read_file", content: "x", at },
  reply("three"),
];

describe("blockEdits, blockElisions, replyText", () => {
  it("mirror the core: per block, live markers only, a removed block left out", () => {
    const events: SessionEvent[] = [
      ...blocky,
      { event: "edit", target: 2, block: 3, text: "two, reworded", at },
      { event: "edit", target: 2, block: 1, text: "uno", at },
      { event: "elide", targets: [2], block: 2, at },
    ];
    expect(blockEdits(events)[2]).toEqual(
      new Map([
        [1, "uno"],
        [3, "two, reworded"],
      ]),
    );
    expect(blockElisions(events)[2]).toEqual(new Set([2]));
    expect(elideFlags(events)[2]).toBe(false);
    expect(elideFlags(events)[3]).toBe(false);
    expect(replyText(events, 2)).toBe("unotwo, reworded");
    expect(replyText(events, 4)).toBeNull();
    expect(replyText(events, 1)).toBeNull();
    const restored: SessionEvent[] = [...events, { event: "unelide", targets: [2], block: 2, at }];
    expect(blockElisions(restored)[2]).toEqual(new Set());
    const gone: SessionEvent[] = [...events, { event: "elide", targets: [2], block: 1, at }];
    expect(replyText(gone, 2)).toBe("two, reworded");
    const rewound: SessionEvent[] = [...events, { event: "rewind", to: 4, at }];
    expect(blockEdits(rewound)[2].size).toBe(0);
    expect(blockElisions(rewound)[2].size).toBe(0);
  });
});

describe("the reply editor", () => {
  const label = (b: { name: string }) => `${b.name} a.txt`;

  it("lays a reply out as text parts with each call a marker, edits and removals applied", () => {
    const events: SessionEvent[] = [
      ...blocky,
      { event: "edit", target: 2, block: 1, text: "uno", at },
    ];
    expect(editParts(events, 2, label)).toEqual([
      { kind: "text", block: 1, original: "uno", draft: "uno" },
      { kind: "marker", block: 2, label: "⚙ read_file a.txt" },
      { kind: "text", block: 3, original: "two", draft: "two" },
    ]);
    const removed: SessionEvent[] = [
      ...blocky,
      { event: "elide", targets: [2], block: 2, at },
      { event: "elide", targets: [2], block: 3, at },
    ];
    expect(editParts(removed, 2, label)).toEqual([
      { kind: "text", block: 1, original: "one", draft: "one" },
      { kind: "marker", block: 2, label: REMOVED_TOOL_PLACEHOLDER },
      { kind: "marker", block: 3, label: REMOVED_TEXT_PLACEHOLDER },
    ]);
    expect(editParts(events, 1, label)).toEqual([]);
  });

  it("drafts per block; Save needs a change and something left; blank drafts are removals", () => {
    const parts = editParts(blocky, 2, label);
    let s: EditState = editReduce(null, { type: "begin", index: 2, text: "onetwo", parts });
    expect(editButtons(s)).toEqual({ save: false, send: false });
    s = editReduce(s, { type: "draft", text: "two, reworded", block: 3 });
    expect(editButtons(s)).toEqual({ save: true, send: false });
    expect(editChanges(s)).toEqual([{ block: 3, text: "two, reworded" }]);
    // The first block emptied: a removal, with the second still there.
    s = editReduce(s, { type: "draft", text: "  ", block: 1 });
    expect(editChanges(s)).toEqual([
      { block: 1, text: "" },
      { block: 3, text: "two, reworded" },
    ]);
    expect(editButtons(s).save).toBe(true);
    // Everything emptied but the call: still a Save — the call stands.
    s = editReduce(s, { type: "draft", text: "", block: 3 });
    expect(editButtons(s).save).toBe(true);
    // A reply with no call, emptied whole: not a Save; that is Remove.
    let plain: EditState = editReduce(null, {
      type: "begin",
      index: 4,
      text: "three",
      parts: editParts(blocky, 4, label),
    });
    plain = editReduce(plain, { type: "draft", text: "", block: 0 });
    expect(editButtons(plain)).toEqual({ save: false, send: false });
    // A draft without a block on a reply is the joined text, not a part.
    const untouched = editReduce(s, { type: "draft", text: "x" });
    expect(untouched?.draft).toBe("x");
    expect(untouched?.parts).toEqual(s?.parts);
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
