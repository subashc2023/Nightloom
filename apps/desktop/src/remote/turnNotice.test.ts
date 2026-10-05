import { describe, expect, it } from "vitest";
import { NEW_CHAT_TURN, turnEndedFor } from "./turnNotice";

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
