import { describe, expect, it, vi } from "vitest";
import { JUMP_DOWN_SHOW, latestTop, scrollToLatest, showJumpDown } from "./navigator";

// Item 218: the round ⌄ centred above the composer. It shows when the
// view is scrolled up past a threshold, hides at the foot, and a click
// lands on the latest message.

describe("showJumpDown", () => {
  const client = 600;
  const height = 3000;
  const foot = height - client;

  it("hides at the foot of the chat", () => {
    expect(showJumpDown(foot, client, height)).toBe(false);
  });

  it("hides within the threshold of the foot", () => {
    expect(showJumpDown(foot - JUMP_DOWN_SHOW, client, height)).toBe(false);
    expect(showJumpDown(foot - 40, client, height)).toBe(false);
  });

  it("shows once scrolled up past the threshold", () => {
    expect(showJumpDown(foot - JUMP_DOWN_SHOW - 1, client, height)).toBe(true);
    expect(showJumpDown(0, client, height)).toBe(true);
  });

  it("hides when the chat does not scroll", () => {
    expect(showJumpDown(0, client, client)).toBe(false);
    expect(showJumpDown(0, client, client + 8)).toBe(false);
  });

  it("hides while a click is carrying the view down", () => {
    expect(showJumpDown(0, client, height, true)).toBe(false);
  });

  it("a reply growing under a reader scrolled up keeps it shown", () => {
    // He reads at the top while the reply streams: the foot moves away,
    // the view stays where he is, the button stays.
    expect(showJumpDown(0, client, height)).toBe(true);
    expect(showJumpDown(0, client, height + 2000)).toBe(true);
  });
});

describe("scrollToLatest", () => {
  it("scrolls the viewport to the latest message", () => {
    const scrollTo = vi.fn();
    scrollToLatest({ scrollHeight: 3000, clientHeight: 600, scrollTo } as never);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2400, behavior: "smooth" });
  });

  it("never asks for a negative top", () => {
    expect(latestTop(300, 600)).toBe(0);
  });
});
