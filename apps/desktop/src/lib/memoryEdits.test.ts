import { describe, expect, it } from "vitest";
import { lineOfNeedle, memoryEditOf, memoryPathLabel, sameHead } from "./memoryEdits";

const ok = (content = "The file has been updated successfully.") => ({ content, is_error: false });

describe("memoryPathLabel (backlog 305)", () => {
  it("names memory notes, thread files and AGENTS.md", () => {
    expect(memoryPathLabel("/w/p/.agents/memory/course-progress.md")).toBe("course-progress.md");
    expect(memoryPathLabel("/w/p/.agents/memory/people/stuart.md")).toBe("people/stuart.md");
    expect(memoryPathLabel("/w/p/.agents/threads/stuart/thread.md")).toBe("stuart/thread.md");
    expect(memoryPathLabel("/w/p/AGENTS.md")).toBe("AGENTS.md");
    expect(memoryPathLabel("/Users/x/.nightloom/AGENTS.md")).toBe("AGENTS.md");
    expect(memoryPathLabel("C:\\w\\p\\.agents\\memory\\a.md")).toBe("a.md");
  });
  it("leaves every other file alone", () => {
    expect(memoryPathLabel("/w/p/src/main.rs")).toBeNull();
    expect(memoryPathLabel("/w/p/.agents/notes.md")).toBeNull();
    expect(memoryPathLabel("/w/p/.agents/memory")).toBeNull();
    expect(memoryPathLabel("/w/p/CLAUDE.md")).toBeNull();
    expect(memoryPathLabel("/w/p/docs/memory/a.md")).toBeNull();
  });
});

describe("memoryEditOf (backlog 305)", () => {
  it("reads Claude Code's Edit, Write and MultiEdit", () => {
    expect(
      memoryEditOf(
        { name: "Edit", input: { file_path: "/w/.agents/memory/a.md", old_string: "x", new_string: "y" }, result: ok() },
        null,
      ),
    ).toEqual({ path: "/w/.agents/memory/a.md", label: "a.md", verb: "Updated", needle: "y", skip: 0 });
    expect(
      memoryEditOf(
        {
          name: "Write",
          input: { file_path: "/w/AGENTS.md", content: "hi" },
          result: ok("File created successfully at: /w/AGENTS.md"),
        },
        null,
      )?.verb,
    ).toBe("Created");
    expect(
      memoryEditOf(
        {
          name: "MultiEdit",
          input: { file_path: "/w/.agents/memory/a.md", edits: [{ new_string: "" }, { new_string: "second" }] },
          result: ok(),
        },
        null,
      )?.needle,
    ).toBe("second");
  });
  it("resolves the API engine's relative path against the workspace", () => {
    const ed = memoryEditOf(
      { name: "edit_file", input: { path: "./.agents/memory/b.md", old_string: "a", new_string: "b" }, result: ok("Edited") },
      "/w/proj/",
    );
    expect(ed?.path).toBe("/w/proj/.agents/memory/b.md");
    expect(
      memoryEditOf(
        { name: "write_file", input: { path: "AGENTS.md", content: "c" }, result: ok("Created AGENTS.md (1 bytes)") },
        "/w",
      ),
    ).toMatchObject({ path: "/w/AGENTS.md", verb: "Created" });
  });
  it("draws nothing for a failed, denied, unfinished or ordinary edit", () => {
    const input = { file_path: "/w/.agents/memory/a.md", old_string: "x", new_string: "y" };
    expect(memoryEditOf({ name: "Edit", input, result: null }, null)).toBeNull();
    expect(memoryEditOf({ name: "Edit", input, result: { content: "no", is_error: true } }, null)).toBeNull();
    expect(memoryEditOf({ name: "Edit", input, result: ok("denied"), denied: true }, null)).toBeNull();
    expect(memoryEditOf({ name: "Read", input, result: ok() }, null)).toBeNull();
    expect(
      memoryEditOf({ name: "Edit", input: { ...input, file_path: "/w/src/a.ts" }, result: ok() }, null),
    ).toBeNull();
    // A relative path with nothing to resolve it, and the vault alias.
    expect(memoryEditOf({ name: "edit_file", input: { path: "AGENTS.md" }, result: ok() }, null)).toBeNull();
    expect(memoryEditOf({ name: "write_file", input: { path: "@kb/AGENTS.md" }, result: ok() }, "/w")).toBeNull();
  });
});

describe("lineOfNeedle (backlog 305)", () => {
  const text = "# Progress\n\n- week 1 done\n- week 2 done\n";
  it("finds the line the edit wrote", () => {
    expect(lineOfNeedle(text, "- week 2 done")).toBe(4);
    // A needle opening on a newline starts at the end of the line above.
    expect(lineOfNeedle(text, "\n- week 1 done\n- week 2 done", 1)).toBe(3);
  });
  it("skips the context lines the edit kept", () => {
    // Haiku's habit: old "- week 1 done\n", new "- week 1 done\n- week 2 done\n".
    expect(sameHead("- week 1 done\n", "- week 1 done\n- week 2 done\n")).toBe(1);
    expect(lineOfNeedle(text, "- week 1 done\n- week 2 done\n", 1)).toBe(4);
    expect(sameHead("a", "b")).toBe(0);
    expect(sameHead("x\ny", "x\nyz")).toBe(1);
  });
  it("falls back to the needle's first line, then the top", () => {
    expect(lineOfNeedle(text, "- week 2 done\n- something since changed")).toBe(4);
    expect(lineOfNeedle(text, "gone")).toBe(1);
    expect(lineOfNeedle(text, "")).toBe(1);
  });
});
