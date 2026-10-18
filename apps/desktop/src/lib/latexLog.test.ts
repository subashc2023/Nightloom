import { describe, expect, it } from "vitest";
import { firstTexError, isTexPath } from "./latexLog";
import { fileSegments, HIGHLIGHT_MAX_CHARS, languageForPath, languageOf, LANGUAGES } from "./codeHighlight";

describe("a file tab's language by extension (380)", () => {
  it("names the language for the files he opens", () => {
    expect(languageForPath("/a/table.tex")).toBe("latex");
    expect(languageForPath("/a/x.py")).toBe("python");
    expect(languageForPath("/a/main.rs")).toBe("rust");
    expect(languageForPath("/a/b.TS")).toBe("typescript");
    expect(languageForPath("/a/c.yml")).toBe("yaml");
    expect(languageForPath("/a/Cargo.toml")).toBe("ini");
    expect(languageForPath("/a/README.md")).toBe("markdown");
    expect(languageForPath("/a/notes.txt")).toBeNull();
    expect(languageForPath("/a/.bashrc")).toBeNull();
    expect(languageForPath("/a/Makefile")).toBeNull();
  });
  it("colours a .tex, .py, .rs and .ts file and keeps every character", () => {
    const files: [string, string][] = [
      ["t.tex", "\\documentclass{standalone}\n% a comment\n\\begin{tabular}{cc} a & b \\end{tabular}\n"],
      ["x.py", "def f(x):\n    return 'a' # c\n"],
      ["m.rs", "fn main() { let x: u8 = 1; }\n"],
      ["a.ts", "const x: number = 1; // c\n"],
    ];
    for (const [p, text] of files) {
      const segs = fileSegments(text, p);
      expect(segs.map((s) => s.text).join("")).toBe(text);
      expect(segs.some((s) => s.cls.startsWith("hljs-"))).toBe(true);
    }
  });
  it("draws a file past the cap, or of no known language, as one plain run", () => {
    const big = "x = 1\n".repeat(Math.ceil(HIGHLIGHT_MAX_CHARS / 6) + 1);
    expect(fileSegments(big, "big.py")).toEqual([{ text: big, cls: "" }]);
    expect(fileSegments("a & b", "n.txt")).toEqual([{ text: "a & b", cls: "" }]);
  });
  it("leaves the chat's menu and fence languages as they were", () => {
    expect(LANGUAGES.map((l) => l.id)).not.toContain("latex");
    expect(languageOf("latex")).toBeNull();
    expect(languageOf("yaml")).toBeNull();
    expect(languageOf("py")?.id).toBe("python");
  });
});

describe("a TeX log's first error (381)", () => {
  it("reads the error and its source line", () => {
    const log = [
      "This is pdfTeX, Version 3.141592653",
      "(./table.tex",
      "! Undefined control sequence.",
      "l.4 \\nosuchmacro",
      "                 ",
      "The control sequence at the end of the top line",
      "! Emergency stop.",
    ].join("\n");
    expect(firstTexError(log)).toEqual({ message: "Undefined control sequence.", line: 4, context: "\\nosuchmacro" });
  });
  it("gives the message alone when no l.<n> follows", () => {
    expect(firstTexError("x\n! LaTeX Error: File `nope.sty' not found.\n! Emergency stop.\n")).toEqual({
      message: "LaTeX Error: File `nope.sty' not found.",
      line: null,
      context: null,
    });
  });
  it("is null for a clean log", () => {
    expect(firstTexError("Output written on table.pdf (1 page).\n")).toBeNull();
  });
  it("knows a .tex path", () => {
    expect(isTexPath("/a/Table.TEX")).toBe(true);
    expect(isTexPath("/a/x.sty")).toBe(false);
  });
});
