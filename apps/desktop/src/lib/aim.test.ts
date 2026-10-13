import { describe, expect, it } from "vitest";
import { aimArgs, aimOf } from "./aim";
import type { SessionEvent } from "./types";

const one = "2026-10-13T07:19:57.1Z";
const two = "2026-10-13T07:21:03.2Z";
const reply = (text: string): SessionEvent => ({
  event: "assistant_message",
  model: "m",
  blocks: [{ type: "text", text }],
  stop_reason: null,
  usage: { input_tokens: 0, output_tokens: 0 },
  at: one,
});
const events: SessionEvent[] = [
  { event: "session_created", id: "c", at: one },
  { event: "user_message", text: "one", at: one },
  reply("first"),
  { event: "user_message", text: "two", at: two },
  reply("second a"),
  { event: "elide", targets: [2], at: two } as SessionEvent,
  reply("second b"),
];

describe("a turn's aim (backlog 364)", () => {
  it("his message: its own send time", () => {
    expect(aimOf(events, 1)).toEqual({ at: one });
    expect(aimOf(events, 3)).toEqual({ at: two });
  });
  it("a reply: its exchange's send time and its place among the replies, other events not counted", () => {
    expect(aimOf(events, 2)).toEqual({ at: one, nth: 0 });
    expect(aimOf(events, 4)).toEqual({ at: two, nth: 0 });
    expect(aimOf(events, 6)).toEqual({ at: two, nth: 1 });
  });
  it("none for anything else, or past the list", () => {
    expect(aimOf(events, 0)).toBeNull();
    expect(aimOf(events, 5)).toBeNull();
    expect(aimOf(events, 99)).toBeNull();
    expect(aimOf([reply("orphan")], 0)).toBeNull();
  });
  it("as a command's arguments", () => {
    expect(aimArgs({ at: one })).toEqual({ at: one });
    expect(aimArgs({ at: one, nth: 0 })).toEqual({ at: one, nth: 0 });
    expect(aimArgs(null)).toEqual({});
  });
});
