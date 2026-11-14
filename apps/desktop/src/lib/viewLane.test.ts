import { describe, expect, it } from "vitest";
import { inViewLane } from "./viewLane";

// Item 686: the view's openers land in the order they were asked for.
describe("inViewLane", () => {
  it("runs steps one at a time, in the order asked, whatever each one waits on", async () => {
    const done: string[] = [];
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const a = inViewLane(async () => {
      await slow;
      done.push("open a");
    });
    const b = inViewLane(async () => {
      done.push("new chat");
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toEqual([]);
    release();
    await Promise.all([a, b]);
    expect(done).toEqual(["open a", "new chat"]);
  });

  it("a step that fails hands its error to its caller and lets the next run", async () => {
    const failed = inViewLane(async () => {
      throw new Error("no log");
    });
    const next = inViewLane(async () => 7);
    await expect(failed).rejects.toThrow("no log");
    await expect(next).resolves.toBe(7);
  });
});

describe("a hung step", () => {
  it("lets the next step run after the release time", async () => {
    const { inViewLane } = await import("./viewLane");
    void inViewLane(() => new Promise<void>(() => {}), 20);
    const got = await inViewLane(async () => "ran", 20);
    expect(got).toBe("ran");
  });
});
