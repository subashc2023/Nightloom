import { describe, expect, it } from "vitest";
import { readSaysTaken } from "./notesTree";

// Review fix (item 457): New note writes an empty file, so it must know
// when the name is already on disk.
describe("readSaysTaken", () => {
  it("a missing file is free", () => {
    expect(readSaysTaken("cannot read a/plan.md: No such file or directory (os error 2)")).toBe("free");
  });
  it("a directory is a folder, not a free name", () => {
    expect(readSaysTaken("cannot read a: Is a directory (os error 21)")).toBe("folder");
  });
  it("a file that is there but will not read as text (a PDF) is taken", () => {
    expect(readSaysTaken("cannot read paper.pdf: stream did not contain valid UTF-8")).toBe("taken");
    expect(readSaysTaken("cannot read x.md: Permission denied (os error 13)")).toBe("taken");
  });
  it("an error that is not the read's own is left to the save", () => {
    expect(readSaysTaken("no project is open")).toBe("free");
    expect(readSaysTaken(new Error("../x.md reaches outside the notes folder"))).toBe("free");
  });
});
