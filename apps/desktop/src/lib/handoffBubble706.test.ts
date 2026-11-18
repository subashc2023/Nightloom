import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import UserBubble from "./UserBubble.svelte";
import UserBubbleClassic from "./UserBubbleClassic.svelte";
import { handoffIsPlain, parseHandoffMessage } from "./handoffBubble";
import { SECTIONS_MARK, wrapUpWithSections } from "./handoffCarry";

// Item 706 (his ask, 2026-11-15): Wrap up now's message draws as a folded
// Nightloom hand-off card on his side, with the turn's buttons; once he
// edits it, it is his plain message again.

const sent = wrapUpWithSections("Wrap up: finish what is half-done, write the hand-off.", "", true);
const withGoal = wrapUpWithSections("Wrap up: finish what is half-done.", "ship the  drafts fix", false);

describe("parseHandoffMessage", () => {
  it("reads every wrap-up Nightloom sends (the addendum's mark)", () => {
    const h = parseHandoffMessage(sent);
    expect(h).not.toBeNull();
    expect(h!.headline).toBe("Wrap up: finish what is half-done, write the hand-off.");
    expect(h!.goal).toBe(false);
    expect(h!.text).toBe(sent.trim());
    expect(h!.lines).toBe(sent.trim().split("\n").length);
  });
  it("heads the card with his goal when he gave one", () => {
    const h = parseHandoffMessage(withGoal)!;
    expect(h.goal).toBe(true);
    expect(h.headline).toBe("ship the drafts fix");
  });
  it("leaves his own words alone", () => {
    for (const t of ["", "please wrap up", "Hand-off contents", "a handoff please"]) expect(parseHandoffMessage(t)).toBeNull();
  });
  it("reads a message he wrote that already holds the mark (his own copy)", () => {
    expect(parseHandoffMessage(`${SECTIONS_MARK}\nA. goal`)?.headline).toBe("A. goal");
  });
  it("clips a long first line", () => {
    const h = parseHandoffMessage(wrapUpWithSections("x".repeat(400), "", false))!;
    expect(h.headline.length).toBeLessThanOrEqual(140);
    expect(h.headline.endsWith("…")).toBe(true);
  });
});

describe("handoffIsPlain: an edit makes it his", () => {
  it("is the card when never edited and the original version", () => {
    expect(handoffIsPlain(null, null)).toBe(false);
    expect(handoffIsPlain(null, 1)).toBe(false);
  });
  it("is plain once saved over in place", () => {
    expect(handoffIsPlain("the text before", null)).toBe(true);
  });
  it("is plain as a fork's edited message (a later version)", () => {
    expect(handoffIsPlain(null, 2)).toBe(true);
  });
});

describe("the bubble, Jarvis and Classic", () => {
  for (const [name, Bubble] of [
    ["Jarvis", UserBubble],
    ["Classic", UserBubbleClassic],
  ] as const) {
    it(`${name}: a wrap-up draws as the folded hand-off card`, () => {
      const html = render(Bubble, { props: { text: sent } }).body;
      expect(html).toContain("data-handoff-bubble");
      expect(html).toContain("Nightloom hand-off");
      expect(html).toMatch(/<details class="hb-fold[^"]*"(?![^>]*\sopen)/);
      expect(html).not.toContain('class="user-text"');
      if (name === "Classic") expect(html).toMatch(/hb-card[^"]*classic/);
    });
    it(`${name}: an edited wrap-up is his plain words`, () => {
      const html = render(Bubble, { props: { text: sent, plain: true } }).body;
      expect(html).not.toContain("data-handoff-bubble");
      expect(html).toContain("user-text");
    });
    it(`${name}: his ordinary message is unchanged`, () => {
      const html = render(Bubble, { props: { text: "hello there" } }).body;
      expect(html).not.toContain("data-handoff-bubble");
      expect(html).toContain("hello there");
    });
  }
});

describe("the phone (Remote.svelte) draws it the same way", () => {
  it("its rows give the card what it reads: the words, and whether he edited them", async () => {
    const { transcriptRows } = await import("../remote/client");
    const at = "2026-11-18T20:00:00Z";
    const ev = [
      { event: "session_created", id: "c", at },
      { event: "user_message", text: sent, at },
      { event: "user_message", text: sent, at },
      { event: "edit", target: 2, text: sent.replace("Wrap up:", "Wrap up, skip shots:"), at },
    ] as unknown as Parameters<typeof transcriptRows>[0];
    const users = transcriptRows(ev).filter((r) => r.kind === "user") as { said: string; edited: boolean }[];
    expect(users.map((u) => !u.edited && parseHandoffMessage(u.said) !== null)).toEqual([true, false]);
  });
  it("Remote.svelte uses the shared detection, and not on an edited message", async () => {
    const src = (await import("../remote/Remote.svelte?raw")).default as string;
    expect(src).toContain("parseHandoffMessage(r.said)");
    expect(src).toMatch(/ran \|\| r\.edited \? null : parseHandoffMessage/);
  });
});
