import { describe, expect, it } from "vitest";
import { rewoundMessage, rewoundRuns, swapIn, untouched } from "./rewindDraft.svelte";
import type { SessionEvent } from "./types";

const AT = "2026-01-01T00:00:00Z";

describe("rewoundMessage", () => {
  const events: SessionEvent[] = [
    { event: "session_created", id: "c", at: AT },
    {
      event: "user_message",
      text: "look at this",
      images: [{ media_type: "image/png", data: "AAA" }],
      documents: [{ media_type: "application/pdf", name: "a.pdf", data: "BBB" }],
      at: AT,
    },
  ];
  it("hands back his message with its images and files as chips", () => {
    let id = 0;
    const back = rewoundMessage(events, 1, () => ++id);
    expect(back?.text).toBe("look at this");
    expect(back?.attachments.map((a) => [a.id, a.kind, a.name, a.data])).toEqual([
      [1, "image", "image-1", "AAA"],
      [2, "document", "a.pdf", "BBB"],
    ]);
  });
  it("is null for anything but his message", () => {
    expect(rewoundMessage(events, 0, () => 0)).toBeNull();
    expect(rewoundMessage(events, 9, () => 0)).toBeNull();
  });
});

describe("swapIn / untouched", () => {
  const chip = { id: 7, kind: "image" as const, name: "x", media_type: "image/png", data: "C" };
  it("puts the message in, keeps typed chips after its own, and stashes typed text", () => {
    const s = swapIn({ text: "half", attachments: [chip] }, { text: "msg", attachments: [] });
    expect(s.after).toEqual({ text: "msg", attachments: [chip] });
    expect(s.before.text).toBe("half");
    expect(s.stashed).toBe(true);
    expect(untouched({ text: "msg" }, s)).toBe(true);
    expect(untouched({ text: "msg!" }, s)).toBe(false);
  });
  it("stashes nothing from a blank box", () => {
    expect(swapIn({ text: "  ", attachments: [] }, { text: "m", attachments: [] }).stashed).toBe(false);
  });
});

describe("rewoundRuns", () => {
  it("counts each run's messages at its first item, continuations not counted", () => {
    const items = [
      { kind: "user", superseded: false },
      { kind: "assistant", superseded: false },
      { kind: "user", superseded: true },
      { kind: "assistant", superseded: true },
      { kind: "assistant", superseded: true },
      { kind: "user", superseded: false },
      { kind: "assistant", superseded: true },
    ];
    const continued = [false, false, false, false, true, false, false];
    expect(rewoundRuns(items, continued)).toEqual([null, null, 2, null, null, null, 1]);
  });
});
