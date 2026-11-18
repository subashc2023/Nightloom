// Item 800: saved message prompts with blanks — the pure rules.
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_VERSIONS,
  blankWords,
  blanks,
  dateWord,
  fillAuto,
  insertAt,
  matching,
  move,
  nameProblem,
  nextBlank,
  restoreVersion,
  saveIn,
  seeds,
  slashToken,
  trash,
  untrash,
  wantsClipboard,
  type MessagePrompt,
} from "./savedPrompts";
import { forgetSelection, lastSelection, noteSelection } from "./selectionMemory";

function p(id: string, name: string, body = "x", extra: Partial<MessagePrompt> = {}): MessagePrompt {
  return { id, name, body, updated: 1, versions: [], ...extra };
}

describe("blanks", () => {
  it("finds word blanks and leaves JSON and spaced braces alone", () => {
    const t = 'Review {file} for {what}; config {"a": 1} and { x } and {date}.';
    expect(blanks(t).map((b) => b.word)).toEqual(["file", "what", "date"]);
    expect(blankWords("{a} {b} {a}")).toEqual(["a", "b"]);
  });

  it("Tab goes to the next blank past the selected one, wrapping; ⇧Tab back", () => {
    const t = "A {one} B {two} C {three}";
    const one = blanks(t)[0];
    const two = blanks(t)[1];
    const three = blanks(t)[2];
    expect(nextBlank(t, one.start, one.end)).toEqual({ start: two.start, end: two.end });
    expect(nextBlank(t, three.start, three.end)).toEqual({ start: one.start, end: one.end });
    expect(nextBlank(t, two.start, two.end, true)).toEqual({ start: one.start, end: one.end });
    expect(nextBlank(t, one.start, one.end, true)).toEqual({ start: three.start, end: three.end });
    expect(nextBlank("no blanks", 0, 0)).toBeNull();
  });
});

describe("the /name token", () => {
  it("is found at the start, after a space or a new line, never mid-word", () => {
    expect(slashToken("/wr", 3)).toEqual({ start: 0, end: 3, query: "wr" });
    expect(slashToken("hi /sp", 6)).toEqual({ start: 3, end: 6, query: "sp" });
    expect(slashToken("line\n/", 6)).toEqual({ start: 5, end: 6, query: "" });
    expect(slashToken("a/b", 3)).toBeNull();
    expect(slashToken("notes/x.md", 10)).toBeNull();
  });

  it("matches live prompts by prefix, an exact name first", () => {
    const list = [p("1", "specs"), p("2", "spec"), p("3", "spelling", "x", { deleted: 5 })];
    expect(matching(list, "spe").map((x) => x.name)).toEqual(["specs", "spec"]);
    expect(matching(list, "spec").map((x) => x.name)).toEqual(["spec", "specs"]);
  });
});

describe("filling and inserting", () => {
  it("fills clipboard, date and selection; an empty one stays a blank", () => {
    const body = "On {date}: {selection} vs {clipboard} — {why}";
    expect(fillAuto(body, { date: "2026-11-18", selection: "the quote", clipboard: "pasted" })).toBe(
      "On 2026-11-18: the quote vs pasted — {why}",
    );
    expect(fillAuto(body, { date: "2026-11-18", selection: null, clipboard: "" })).toBe(
      "On 2026-11-18: {selection} vs {clipboard} — {why}",
    );
    expect(wantsClipboard(body)).toBe(true);
    expect(wantsClipboard("{date}")).toBe(false);
    expect(dateWord(new Date(2026, 10, 8))).toBe("2026-11-08");
  });

  it("replaces the token and selects the first blank left, else puts the caret at the end", () => {
    const text = "Please /sp";
    const r = insertAt(text, slashToken(text, text.length)!, "launch {item} now");
    expect(r.text).toBe("Please launch {item} now");
    expect(r.text.slice(r.select.start, r.select.end)).toBe("{item}");
    const q = insertAt("/w", { start: 0, end: 2 }, "done");
    expect(q).toEqual({ text: "done", select: { start: 4, end: 4 } });
  });
});

describe("the list", () => {
  it("an edit keeps the version it replaced; an unchanged save keeps none", () => {
    let list = [p("a", "wrapup", "v1")];
    list = saveIn(list, "a", "wrapup", "v1", 10);
    expect(list[0].versions).toEqual([]);
    list = saveIn(list, "a", "wrapup", "v2", 20);
    list = saveIn(list, "a", "wrap", "v3", 30);
    expect(list[0].body).toBe("v3");
    expect(list[0].versions.map((v) => v.body)).toEqual(["v2", "v1"]);
    expect(list[0].versions[0]).toEqual({ name: "wrapup", body: "v2", at: 30 });
    list = restoreVersion(list, "a", 1, 40);
    expect(list[0].body).toBe("v1");
    expect(list[0].versions.map((v) => v.body)).toEqual(["v3", "v2", "v1"]);
  });

  it("keeps at most MAX_VERSIONS", () => {
    let list = [p("a", "n", "0")];
    for (let i = 1; i <= MAX_VERSIONS + 5; i++) list = saveIn(list, "a", "n", String(i), i);
    expect(list[0].versions.length).toBe(MAX_VERSIONS);
  });

  it("a new prompt goes at the end; names are checked", () => {
    const list = saveIn([p("a", "wrapup")], null, " spec ", "b", 5);
    expect(list.map((x) => x.name)).toEqual(["wrapup", "spec"]);
    expect(nameProblem(list, "Spec", null)).toBe("/spec already exists.");
    expect(nameProblem(list, "spec", list[1].id)).toBeNull();
    expect(nameProblem(list, "two words", null)).toMatch(/no spaces/);
    expect(nameProblem(list, "", null)).toMatch(/name/);
  });

  it("delete goes to the trash; restore is refused while the name is taken", () => {
    let list = trash([p("a", "x"), p("b", "y")], "a", 7);
    expect(list[0].deleted).toBe(7);
    expect(matching(list, "x")).toEqual([]);
    const taken = saveIn(list, null, "x", "new", 8);
    expect(untrash(taken, "a")).toBeNull();
    list = untrash(list, "a")!;
    expect(list[0].deleted).toBeNull();
  });

  it("moves among the live ones, skipping the trash", () => {
    const list = [p("a", "a"), p("b", "b", "x", { deleted: 1 }), p("c", "c")];
    expect(move(list, "c", -1).map((x) => x.id)).toEqual(["c", "b", "a"]);
    expect(move(list, "a", -1)).toEqual(list);
  });

  it("starts with his wrap-up and the spec launch, wrap-up first", () => {
    const s = seeds("WRAP TEXT", 100);
    expect(s.map((x) => x.name)).toEqual(["wrapup", "spec"]);
    expect(s[0].body).toBe("WRAP TEXT");
    expect(blankWords(s[1].body)).toEqual(["item", "spec", "date"]);
  });
});

describe("the remembered selection", () => {
  beforeEach(() => forgetSelection());

  it("keeps a transcript selection, not one inside a box, for ten minutes", () => {
    // Stand-ins for a reply's text node and a textarea (no DOM in this run).
    const box = { closest: () => ({}) } as unknown as Node;
    const para = { closest: () => null } as unknown as Node;
    const text = { parentElement: para } as unknown as Node;
    noteSelection("  quoted words ", text, 1000);
    noteSelection("typed in the box", box, 2000);
    expect(lastSelection(2000)).toBe("quoted words");
    expect(lastSelection(1000 + 10 * 60 * 1000 + 1)).toBeNull();
  });
});
