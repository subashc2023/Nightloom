import { describe, expect, it } from "vitest";
import { LATE_NOTICE_MS, NEW_CHAT_TURN, noticeFor, turnEndedFor } from "./turnNotice";

describe("turnEndedFor (300 A16/B2)", () => {
  it("a turn in the chat on screen gives no toast even when the host's current chat is stale", () => {
    // The re-test: a held message had gone to another chat, then he sent here.
    expect(turnEndedFor("here", "approve-chat", "here", false)).toBeNull();
  });
  it("the first message of a new chat gives no toast", () => {
    expect(turnEndedFor(NEW_CHAT_TURN, "approve-chat", null, true)).toBeNull();
    expect(turnEndedFor(NEW_CHAT_TURN, "approve-chat", "fresh-id", false)).toBeNull();
  });
  it("a turn in another chat names that chat", () => {
    expect(turnEndedFor("recipes-chat", "here", "here", false)).toBe("recipes-chat");
  });
  it("a turn the page did not see start falls back to the host's current chat", () => {
    expect(turnEndedFor(null, "curl-chat", "here", false)).toBe("curl-chat");
    expect(turnEndedFor(null, "here", "here", false)).toBeNull();
    expect(turnEndedFor(null, null, "here", false)).toBeNull();
  });
});

describe("a late turn-end notice (300 review 2)", () => {
  it("is judged by the turn the read saw end, not the held message's turn begun since", () => {
    // The read saw chat A's turn end; the queue then sent a held message in B.
    const ended = { turn: "A", host: "A", at: 1000 };
    const n = noticeFor(ended, "B", "B", 1000 + 2000);
    expect(n).toEqual({ turn: "A", host: "A", late: true });
    // B on screen: the toast names A, never B.
    expect(turnEndedFor(n.turn, n.host, "B", false)).toBe("A");
    // A on screen: no toast.
    expect(turnEndedFor(n.turn, n.host, "A", false)).toBe(null);
  });

  it("no ended turn, or one older than the window: the running turn, as before", () => {
    expect(noticeFor(null, "B", "B", 5)).toEqual({ turn: "B", host: "B", late: false });
    expect(noticeFor({ turn: "A", host: "A", at: 0 }, "B", "B", LATE_NOTICE_MS + 1)).toEqual({ turn: "B", host: "B", late: false });
  });
});
