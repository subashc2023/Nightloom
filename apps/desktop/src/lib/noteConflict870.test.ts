// Item 870: an open note with unsaved edits whose file changed outside
// Nightloom — Save never writes over the outside version without his pick,
// and no choice drops either text until he makes it.
import { describe, expect, it } from "vitest";
import { BOTH_MINE, BOTH_THEIRS, BOTH_END, bothText, outsideChange } from "./noteConflict";

describe("870: a note changed outside while he has unsaved edits", () => {
  it("the file as loaded: nothing to do", () => {
    expect(outsideChange({ disk: "a", saved: "a", text: "a b" })).toBe("none");
  });
  it("the file now matches his text (his own save landing): adopt it as saved", () => {
    expect(outsideChange({ disk: "a b", saved: "a", text: "a b" })).toBe("adopt");
  });
  it("changed outside with no unsaved edits: take the file", () => {
    expect(outsideChange({ disk: "theirs", saved: "a", text: "a" })).toBe("reload");
  });
  it("changed outside with unsaved edits: a conflict, never a silent overwrite", () => {
    expect(outsideChange({ disk: "theirs", saved: "a", text: "mine" })).toBe("conflict");
  });

  it("Show both keeps every line of both texts, marking only what differs", () => {
    const mine = "# Title\nshared\nmy line\nend\n";
    const theirs = "# Title\nshared\ntheir line\nend\n";
    const both = bothText(mine, theirs);
    expect(both).toBe(
      `# Title\nshared\n${BOTH_MINE}\nmy line\n${BOTH_THEIRS}\ntheir line\n${BOTH_END}\nend\n`,
    );
  });
  it("Show both with nothing in common is both whole texts", () => {
    const both = bothText("one", "two");
    expect(both).toContain("one");
    expect(both).toContain("two");
    expect(both.indexOf(BOTH_MINE)).toBeLessThan(both.indexOf("one"));
    expect(both.indexOf("one")).toBeLessThan(both.indexOf(BOTH_THEIRS));
    expect(both.indexOf(BOTH_THEIRS)).toBeLessThan(both.indexOf("two"));
  });
  it("Show both when one side only added lines loses neither", () => {
    const both = bothText("a\nb\n", "a\nb\nc\n");
    expect(both.startsWith("a\nb\n")).toBe(true);
    expect(both).toContain(`${BOTH_THEIRS}\nc\n${BOTH_END}`);
  });
  it("the markers say plainly which text is whose", () => {
    expect(BOTH_MINE).toMatch(/yours/i);
    expect(BOTH_THEIRS).toMatch(/outside Nightloom/i);
  });
});

import { app, mirrorDraft } from "./state.svelte";
import { draftBase } from "./state/notes.svelte";

describe("870: a draft remembers the file text it was typed against", () => {
  it("trusted while the draft is the same, forgotten once saved or replaced", () => {
    mirrorDraft("k:870", "mine", "base");
    expect(draftBase("k:870")).toBe("base");
    // A draft written by another path (a proposal, a restore): unknown.
    app.noteDrafts["k:870"] = "other";
    expect(draftBase("k:870")).toBe(null);
    mirrorDraft("k:870", "same", "same");
    expect(app.noteDrafts["k:870"]).toBeUndefined();
    expect(draftBase("k:870")).toBe(null);
  });
});
