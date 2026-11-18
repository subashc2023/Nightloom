import { beforeEach, describe, expect, it, vi } from "vitest";

const logged: Record<string, unknown>[] = [];
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  logHandoff: vi.fn(async (r: Record<string, unknown>) => {
    logged.push(r);
    return null;
  }),
}));

import { buildCarry, composeFirstMessage, MAX_READ } from "./handoffCarry";
import { cardLog } from "./handoffButton";
import { handoffRecord, nextTurnRecords, noteHandoffOpened, noteNextTurns, NEXT_TURNS } from "./handoffLog";
import { resetViewState } from "./viewState";
import type { ContentBlock, SessionEvent } from "./types";

const at = (min: number) => new Date(Date.UTC(2026, 10, 16, 12, min)).toISOString();
const user = (text: string, min = 0): SessionEvent => ({ event: "user_message", text, at: at(min) });
const say = (blocks: ContentBlock[], min = 0): SessionEvent => ({
  event: "assistant_message",
  model: "m",
  blocks,
  stop_reason: "end_turn",
  usage: { input_tokens: 1000, output_tokens: 100 },
  at: at(min),
});
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const call = (id: string, name: string, input: unknown): ContentBlock => ({ type: "tool_use", id, name, input });
const live = (events: SessionEvent[]) => events.map(() => true);

const RULE = "never quit the app for me while a build is waiting, I quit it myself when I am ready";
const ASIDE = "the sidebar colour looks a touch too warm on the dark theme tonight for some reason";

/** An old chat: two of his messages, some work, then the wrap-up and its reply. */
function oldChat(): { events: SessionEvent[]; reply: number; prompt: string } {
  const prompt = "Goal: re-run tiers 1-3 on the small sample\n\nRead HANDOFF.md first.";
  const events: SessionEvent[] = [
    { event: "session_created", id: "old", at: at(0) },
    user(RULE, 1),
    say([call("r1", "Read", { file_path: "/p/notes/a.md" }), call("e1", "Edit", { file_path: "/p/src/x.ts", new_string: "y" })], 2),
    user(ASIDE, 3),
    say([text("noted")], 4),
    user("wrap up", 5),
    say([call("h1", "Write", { file_path: "/p/HANDOFF.md", content: "## STATE\n### Goal\nre-run" }), text("```\n" + prompt + "\n```")], 6),
  ];
  return { events, reply: events.length - 1, prompt };
}

beforeEach(() => {
  logged.length = 0;
  resetViewState();
});

describe("757: a hand-off's line", () => {
  it("records the goal, the message as sent, ticked text, unticked ids only, the uncapped list and caps, the check and the cost", () => {
    const { events, reply, prompt } = oldChat();
    const carry = buildCarry({ events, live: live(events), reply, prompt });
    const rule = carry.unquoted.find((m) => m.text === RULE)!;
    const ticks = { [rule.id]: true };
    const sent = composeFirstMessage(carry, "re-run tiers 1-3, small sample first");
    const rec = handoffRecord({ route: "card", from: "old", index: reply, to: "new", sent, carry, goal: "re-run tiers 1-3, small sample first", ticks });
    expect(rec).toMatchObject({
      kind: "handoff",
      v: 1,
      route: "card",
      from_chat: "old",
      from_index: reply,
      to_chat: "new",
      goal: "re-run tiers 1-3, small sample first",
      goal_from: "card",
      prompt_goal: "re-run tiers 1-3 on the small sample",
      sent,
      sent_chars: sent.length,
      carry: true,
      messages: 2,
    });
    // Item 850: no ticks — every message of his went, within the cap.
    expect((rec.ticked as { text: string }[]).map((m) => m.text)).toEqual(carry.words.map((m) => m.text));
    expect((rec.ticked as { text: string }[]).map((m) => m.text)).toContain(RULE);
    expect(rec.dropped).toBe(0);
    const unq = rec.unquoted as { id: string; ticked: boolean; words: number }[];
    expect(unq.every((m) => m.ticked)).toBe(true);
    expect(unq.find((m) => m.id !== rule.id)?.words ?? ASIDE.split(" ").length).toBe(ASIDE.split(" ").length);
    expect((rec.artifacts as { read: unknown[] }).read).toEqual([{ path: "/p/notes/a.md", count: 1 }]);
    expect((rec.caps as { read: number }).read).toBe(MAX_READ);
    expect(rec.missing).toEqual(carry.missing);
    expect(rec.cost).toEqual(carry.cost);
  });

  it("names the goal's source: the prompt's own, or none; a route with no carry says so", () => {
    const { events, reply, prompt } = oldChat();
    const carry = buildCarry({ events, live: live(events), reply, prompt });
    expect(handoffRecord({ route: "card", from: "old", index: reply, to: "n", sent: prompt, carry, goal: null }).goal_from).toBe("prompt");
    expect(handoffRecord({ route: "card", from: "old", index: reply, to: "n", sent: prompt, carry, goal: "" }).goal_from).toBe("none");
    const box = handoffRecord({ route: "box", from: "old", index: null, to: "n", sent: prompt });
    expect(box).toMatchObject({ route: "box", carry: false, goal: "re-run tiers 1-3 on the small sample", goal_from: "prompt" });
    expect(box).not.toHaveProperty("ticked");
  });

  it("cardLog reads his goal and ticks off the card, and noteHandoffOpened sends one line", () => {
    const { events, reply, prompt } = oldChat();
    const carry = buildCarry({ events, live: live(events), reply, prompt });
    const log = cardLog({ chat: "old", index: reply, carry });
    expect(log).toEqual({ route: "card", carry, goal: null, ticks: {} });
    noteHandoffOpened({ ...log, from: "old", index: reply, to: "new", sent: prompt });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "handoff", to_chat: "new", goal_from: "prompt" });
  });
});

/** A next chat continuing "old": its first message, then `turns` more. */
function nextChat(turns: number): SessionEvent[] {
  const events: SessionEvent[] = [
    { event: "session_created", id: "new", at: at(10), forked_from: { session: "old", index: 6, reason: "handoff" } },
    user("Goal: re-run tiers 1-3\n\nRead HANDOFF.md first.", 11),
    say([call("t1", "Read", { file_path: "/p/HANDOFF.md" }), call("t2", "Bash", { command: "sed -n 1,40p notes/runner-design/a.md" })], 12),
  ];
  for (let n = 0; n < turns; n++) {
    events.push(user(`go on ${n}`, 13 + n));
    events.push(say([call(`w${n}`, "Edit", { file_path: `/p/src/f${n}.ts`, new_string: "z" })], 13 + n));
  }
  return events;
}

describe("757: the next chat's first turns", () => {
  it("one line per turn with the files it read, edited and named in shell, keyed to the hand-off", () => {
    const events = nextChat(2);
    const recs = nextTurnRecords("new", events, live(events), 0);
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({
      kind: "next_turn",
      chat: "new",
      forked_from: { session: "old", index: 6 },
      turn: 1,
      read: [{ path: "/p/HANDOFF.md", count: 1 }],
      shell: [{ path: "notes/runner-design/a.md", count: 1 }],
      edited: [],
      tools: 2,
    });
    expect(recs[2]).toMatchObject({ turn: 3, edited: [{ path: "/p/src/f1.ts", count: 1 }], read: [] });
    // No message text in a turn's line.
    expect(JSON.stringify(recs)).not.toContain("go on");
  });

  it("nothing for a chat that does not continue a hand-off", () => {
    const events = nextChat(1);
    events[0] = { event: "session_created", id: "new", at: at(10) };
    expect(nextTurnRecords("new", events, live(events), 0)).toEqual([]);
    events[0] = { event: "session_created", id: "new", at: at(10), forked_from: { session: "old", index: 6 } };
    expect(nextTurnRecords("new", events, live(events), 0)).toEqual([]);
  });

  it("at each turn's end only the new turns go, up to the first 30, and a relaunch does not repeat them", () => {
    let events = nextChat(1);
    noteNextTurns("new", events, live(events));
    expect(logged.map((r) => r.turn)).toEqual([1, 2]);
    noteNextTurns("new", events, live(events));
    expect(logged.map((r) => r.turn)).toEqual([1, 2]);
    events = nextChat(NEXT_TURNS + 5);
    noteNextTurns("new", events, live(events));
    expect(logged.at(-1)!.turn).toBe(NEXT_TURNS);
    expect(logged).toHaveLength(NEXT_TURNS);
    noteNextTurns("new", events, live(events));
    expect(logged).toHaveLength(NEXT_TURNS);
  });

  it("a rewound message is not a turn", () => {
    const events = nextChat(2);
    const flags = live(events);
    flags[3] = false;
    flags[4] = false;
    const recs = nextTurnRecords("new", events, flags, 0);
    expect(recs.map((r) => r.turn)).toEqual([1, 2]);
    expect(recs[1]).toMatchObject({ edited: [{ path: "/p/src/f1.ts", count: 1 }] });
  });
});
