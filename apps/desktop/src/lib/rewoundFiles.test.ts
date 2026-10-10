import { describe, expect, it } from "vitest";
import { rewoundWrites, shellTargets } from "./rewoundFiles";
import type { SessionEvent } from "./types";

const at = "2026-09-28T07:20:07Z";
const usage = { input_tokens: 0, output_tokens: 0 } as never;

function call(id: string, name: string, input: unknown): SessionEvent {
  return {
    event: "assistant_message",
    model: "m",
    blocks: [{ type: "tool_use", id, name, input }],
    stop_reason: null,
    usage,
    at,
  };
}
function result(id: string, name: string, content: string, is_error = false): SessionEvent {
  return { event: "tool_result", tool_use_id: id, name, content, is_error, at };
}
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });

describe("rewoundWrites (item 259)", () => {
  // The Stuart 9 shape: a brainstorm note and HANDOFF.md created, a memory
  // file appended to, all in the turn that was rewound.
  const events: SessionEvent[] = [
    user("earlier"),
    call("a0", "Write", { file_path: "/p/kept.md", content: "x" }),
    result("a0", "Write", "File created successfully at: /p/kept.md"),
    user("brainstorm"),
    call("t1", "Write", { file_path: "/p/.agents/brainstorm.md", content: "x" }),
    result("t1", "Write", "File created successfully at: /p/.agents/brainstorm.md"),
    call("t2", "Edit", { file_path: "/p/.agents/memory/index.md", old_string: "a", new_string: "b" }),
    result("t2", "Edit", "The file /p/.agents/memory/index.md has been updated successfully."),
    call("t3", "Bash", { command: "cat >> .agents/memory/family.md <<'EOF'\nx\nEOF" }),
    result("t3", "Bash", ""),
    call("t4", "Write", { file_path: "/p/HANDOFF.md", content: "x" }),
    result("t4", "Write", "File created successfully at: /p/HANDOFF.md"),
    call("t5", "Write", { file_path: "/p/failed.md", content: "x" }),
    result("t5", "Write", "permission denied", true),
    call("t6", "Write", { file_path: "/p/brainstorm-old.md", content: "x" }),
    result("t6", "Write", "The file /p/brainstorm-old.md has been updated successfully."),
    call("t7", "Read", { file_path: "/p/other.md" }),
    result("t7", "Read", "..."),
  ];
  const live = events.map(() => true);

  it("lists what the rewound turns wrote, and only those", () => {
    expect(rewoundWrites(events, live, 3)).toEqual([
      { path: "/p/.agents/brainstorm.md", how: "created", tool: "Write" },
      { path: "/p/.agents/memory/index.md", how: "edited", tool: "Edit" },
      { path: ".agents/memory/family.md", how: "shell", tool: "Bash" },
      { path: "/p/HANDOFF.md", how: "created", tool: "Write" },
      { path: "/p/brainstorm-old.md", how: "edited", tool: "Write" },
    ]);
  });

  it("skips events already superseded", () => {
    const partly = live.map((_, i) => i < 10);
    expect(rewoundWrites(events, partly, 3).map((w) => w.path)).toEqual([
      "/p/.agents/brainstorm.md",
      "/p/.agents/memory/index.md",
      ".agents/memory/family.md",
    ]);
  });

  it("a Write whose result never came (a stopped turn) is not called created", () => {
    const stopped = [user("go"), call("s", "Write", { file_path: "/p/x.md", content: "" })];
    expect(rewoundWrites(stopped, [true, true], 0)).toEqual([{ path: "/p/x.md", how: "edited", tool: "Write" }]);
  });
});

describe("shellTargets", () => {
  it("names redirected and teed files, not descriptors or variables", () => {
    expect(shellTargets("echo hi > out.txt 2>&1")).toEqual(["out.txt"]);
    expect(shellTargets("cat a >> 'notes/x y.md'")).toEqual(["notes/x y.md"]);
    expect(shellTargets("ls | tee -a log.txt")).toEqual(["log.txt"]);
    expect(shellTargets("echo $x > $OUT; echo > /dev/null")).toEqual([]);
    expect(shellTargets("git status")).toEqual([]);
    expect(shellTargets("if [ a -ge 2 ]; then echo; fi")).toEqual([]);
  });

  // Stuart 9's rewound turn (2026-09-28): the heredoc body held "->" and
  // "> x" text, the append followed a `cd`, and a sed script held a `;`.
  it("skips heredoc bodies, follows cd, and finds sed -i's file", () => {
    const cmd = [
      "cd /p/.agents/memory && cat >> family.md <<'EOF'",
      "- claim -> complexity; see > notes",
      "EOF",
      "sed -i '' 's/^- x.*/&\\n- y (a, b claims); see z/' index.md && tail -3 index.md",
    ].join("\n");
    expect(shellTargets(cmd)).toEqual(["/p/.agents/memory/family.md", "/p/.agents/memory/index.md"]);
    expect(shellTargets(`python3 -c "open('o','w').write('a > b')" > out.txt`)).toEqual(["out.txt"]);
  });
});
