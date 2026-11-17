// Item 775: aside changes reach the main chat — the note's text, where it
// sits in his message, and how his bubble reads it back.
import { describe, expect, it } from "vitest";
import {
  changesLine,
  chipWords,
  cleanChanges,
  loadNotes,
  noteText,
  questionHead,
  saveNotes,
  splitAsideNote,
  withNote,
  type PendingAsideNote,
} from "./asideNotes";
import { joinAttachNote, splitAttachNote } from "./keep";

const one: PendingAsideNote = {
  id: "u1:3:1",
  question: "can you fix the typo in the readme and bump the version while you are at it please",
  changes: [
    { path: "README.md", added: 1, removed: 1, how: "edited" },
    { path: "notes/new.md", added: 4, removed: null, how: "written" },
  ],
  at: 1,
};
const two: PendingAsideNote = {
  id: "u2:5:2",
  question: "run the formatter",
  changes: [
    { path: "src/a, b.ts", added: null, removed: null, how: "shell" },
    { path: "old.txt", added: null, removed: null, how: "deleted" },
  ],
  at: 2,
};

describe("the note (item 775)", () => {
  it("is nothing when no aside changed anything", () => {
    expect(noteText([])).toBe("");
    expect(noteText([{ ...one, changes: [] }])).toBe("");
    expect(withNote("hi", "")).toBe("hi");
  });

  it("names each aside by its first 60 characters and each file with its lines", () => {
    const t = noteText([one]);
    expect(t).toContain("an aside the user asked beside this chat changed files:");
    expect(t).toContain(`- aside "${questionHead(one.question)}": \`README.md\` (+1 −1), \`notes/new.md\` (written whole, 4 lines)`);
    expect(questionHead(one.question).length).toBe(60);
    expect(t).toContain("Re-read these before relying on their earlier contents.");
  });

  it("batches several asides into one block", () => {
    const t = noteText([one, two]);
    expect(t.match(/<nightloom-aside-changes>/g)?.length).toBe(1);
    expect(t).toContain("2 asides the user asked");
    expect(t).toContain("`src/a, b.ts` (changed by a shell command), `old.txt` (deleted)");
  });

  it("goes at the very end of his words, so everything before it is the message as typed", () => {
    const sent = withNote("what now?", noteText([one]));
    expect(sent.startsWith("what now?\n\n<nightloom-aside-changes>\n")).toBe(true);
    expect(sent.endsWith("</nightloom-aside-changes>")).toBe(true);
  });

  it("reads back out of the message: his words, and the rows for the chip", () => {
    const sent = withNote("what now?", noteText([one, two]));
    const s = splitAsideNote(sent);
    expect(s.text).toBe("what now?");
    expect(s.rows?.map((r) => r.changes)).toEqual([
      ["README.md (+1 −1)", "notes/new.md (written whole, 4 lines)"],
      ["src/a, b.ts (changed by a shell command)", "old.txt (deleted)"],
    ]);
    expect(s.files).toBe(4);
    expect(chipWords(4)).toBe("carries 4 aside changes");
    expect(chipWords(1)).toBe("carries 1 aside change");
  });

  it("leaves a message without one alone, and text that only mentions the tag", () => {
    expect(splitAsideNote("plain").rows).toBeNull();
    const mid = "see <nightloom-aside-changes> in the code\nand more";
    expect(splitAsideNote(mid)).toEqual({ text: mid, rows: null, files: 0 });
  });

  it("is drawn out of his words by the bubble's split, the files' note after it kept for an edit", () => {
    const files = "[Attached a file — saved for you to open with your tools:\n- /w/.nightloom/files/c/a.csv]";
    const sent = `${withNote("look", noteText([one]))}\n\n${files}`;
    const s = splitAttachNote(sent);
    expect(s.said).toBe("look");
    expect(s.files.map((f) => f.name)).toEqual(["a.csv"]);
    expect(s.aside?.length).toBe(1);
    // An edit puts both back exactly.
    expect(joinAttachNote(s.said, s.note)).toBe(sent);
    // A message without a note splits as before (no `aside` key).
    expect(splitAttachNote("hello")).toEqual({ said: "hello", files: [], note: "" });
  });

  it("an aside's line says whether the main chat has heard", () => {
    expect(changesLine(one.changes, true)).toBe(
      "Changed README.md, notes/new.md — the main chat will hear of these changes on its next message",
    );
    const many = [...one.changes, ...two.changes];
    expect(changesLine(many, false)).toBe(
      "Changed README.md, notes/new.md, src/a, b.ts and 1 more — the main chat was told of these changes with its next message",
    );
  });

  it("cleans what the backend sends and survives the store", () => {
    expect(cleanChanges([{ path: "a", added: 1, removed: 2, how: "edited" }, { path: "" }, null, { path: "b", how: "x" }])).toEqual([
      { path: "a", added: 1, removed: 2, how: "edited" },
      { path: "b", added: null, removed: null, how: "edited" },
    ]);
    expect(cleanChanges(undefined)).toEqual([]);
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    saveNotes({ chatA: [one], secret: [two], empty: [] }, storage, (c) => c === "secret");
    expect(loadNotes(storage)).toEqual({ chatA: [one] });
    saveNotes({}, storage);
    expect(loadNotes(storage)).toEqual({});
    expect(loadNotes({ getItem: () => "{not json" })).toEqual({});
  });
});
