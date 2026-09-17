import { describe, expect, it } from "vitest";
import type { Segment, ToolCallView } from "./state.svelte";
import {
  chatName,
  filesChanged,
  fmtElapsed,
  needsYouBody,
  needsYouTitle,
  parseNotifyPrefs,
  turnEndBody,
  turnEndTitle,
  usageRefreshBody,
  usageRefreshTitle,
} from "./notify";

// The turn-end banner (nightshift backlog 079): the switches' defaults and
// the copy, in the shape the design board draws.

function call(over: Partial<ToolCallView>): Segment {
  return { kind: "tool", call: { id: "t", name: "Bash", input: {}, result: null, ...over } };
}

describe("parseNotifyPrefs", () => {
  it("defaults every switch on, and reads each back", () => {
    const all = { turnEnd: true, needsYou: true, usageRefresh: true };
    expect(parseNotifyPrefs(null)).toEqual(all);
    expect(parseNotifyPrefs("nonsense")).toEqual(all);
    expect(parseNotifyPrefs('{"turnEnd":false}')).toEqual({ ...all, turnEnd: false });
    expect(parseNotifyPrefs('{"needsYou":false,"turnEnd":true}')).toEqual({ ...all, needsYou: false });
    // A preference stored before backlog 116 has no usageRefresh: on.
    expect(parseNotifyPrefs('{"turnEnd":true,"needsYou":true}').usageRefresh).toBe(true);
    expect(parseNotifyPrefs('{"usageRefresh":false}')).toEqual({ ...all, usageRefresh: false });
  });
});

// The Refresh-now banner (nightshift backlog 116): the title and the
// headline figures, each part only when there is one.
describe("the Refresh-now banner", () => {
  const week = { from: "2026-09-10", to: "2026-09-16", days_with_data: 7, usd: 12.345, by_model: [] };
  it("names the outcome", () => {
    expect(usageRefreshTitle(false)).toBe("Usage refreshed");
    expect(usageRefreshTitle(true)).toBe("Usage refresh failed");
  });
  it("carries this week's dollars and the plan's two percentages", () => {
    expect(usageRefreshBody({ available: true, week }, { five_hour: 41.4, seven_day: 22.6 }, null)).toBe(
      "$12.35 in 7 days · 5h 41% · week 23%",
    );
  });
  it("drops a part that is missing, and says so when all are", () => {
    expect(usageRefreshBody({ available: true, week }, null, null)).toBe("$12.35 in 7 days");
    expect(usageRefreshBody({ available: false, week: null }, { five_hour: 3, seven_day: null }, null)).toBe("5h 3%");
    expect(usageRefreshBody(null, null, null)).toBe("the ledger is current");
  });
  it("writes a failed run's body from the error's first line", () => {
    expect(usageRefreshBody({ available: true, week }, null, "collector exited 1\nTraceback…")).toBe(
      "collector exited 1",
    );
  });
});

describe("filesChanged", () => {
  it("counts distinct files written or edited on either engine, not reads, denials or failures", () => {
    const segs: Segment[] = [
      call({ name: "Read", input: { file_path: "/a.md" } }),
      call({ name: "Write", input: { file_path: "/a.md" }, result: { content: "ok", is_error: false } }),
      call({ name: "Edit", input: { file_path: "/a.md" }, result: { content: "ok", is_error: false } }),
      call({ name: "Edit", input: { file_path: "/b.md" }, result: { content: "ok", is_error: false } }),
      call({ name: "write_file", input: { path: "c.md" }, result: { content: "ok", is_error: false } }),
      call({ name: "Write", input: { file_path: "/d.md" }, denied: true }),
      call({ name: "Write", input: { file_path: "/e.md" }, result: { content: "no", is_error: true } }),
      { kind: "text", text: "done" },
    ];
    expect(filesChanged(segs)).toBe(3);
  });
});

describe("the copy", () => {
  it("formats elapsed time the way the moon row does", () => {
    expect(fmtElapsed(41_000)).toBe("41 s");
    expect(fmtElapsed(130_000)).toBe("2 min 10 s");
    expect(fmtElapsed(120_000)).toBe("2 min");
    expect(fmtElapsed(3_840_000)).toBe("1 h 4 min");
  });

  it("names the chat by its title, else its first message, else New chat", () => {
    expect(chatName("q5 divergence sweep", "hello")).toBe("q5 divergence sweep");
    expect(chatName(null, "hello there\nsecond line")).toBe("hello there");
    expect(chatName(null, null)).toBe("New chat");
    expect(chatName("x".repeat(80), null)).toBe(`${"x".repeat(57)}…`);
  });

  it("writes the turn-finished banner: files · tokens · time, each only when present", () => {
    const segs: Segment[] = [
      call({ name: "Write", input: { file_path: "/a.md" }, result: { content: "", is_error: false } }),
      call({ name: "Write", input: { file_path: "/b.md" }, result: { content: "", is_error: false } }),
      call({ name: "Write", input: { file_path: "/c.md" }, result: { content: "", is_error: false } }),
    ];
    expect(turnEndTitle("q5 divergence sweep", false)).toBe("q5 divergence sweep — turn finished");
    expect(turnEndBody(segs, 48_200, 130_000, null)).toBe("3 files changed · 48k out · 2 min 10 s");
    expect(turnEndBody([], 1_234, 12_000, null)).toBe("1.2k out · 12 s");
    expect(turnEndBody([], null, 500, null)).toBe("done");
    expect(turnEndBody([segs[0]], 0, null, null)).toBe("1 file changed");
  });

  it("writes a failed turn's banner from the error's first line", () => {
    expect(turnEndTitle("q5", true)).toBe("q5 — turn failed");
    expect(turnEndBody([], 10, 10_000, "process exited 1\ndetails")).toBe("process exited 1");
  });

  it("writes the needs-you banner: the call, the argument, waits until you answer", () => {
    const req = { id: "1", name: "Bash", input: { command: "python3 bin/usagectl.py" } };
    expect(needsYouTitle("q5 divergence sweep", req)).toBe("q5 divergence sweep — Run Bash?");
    expect(needsYouBody(req)).toBe("python3 bin/usagectl.py · waits until you answer");
    expect(needsYouTitle("q5", { name: "AskUserQuestion" })).toBe("q5 — Claude asks a question");
    expect(needsYouBody({ name: "AskUserQuestion", input: { questions: [] } })).toBe("waits until you answer");
    expect(needsYouTitle("q5", { name: "ExitPlanMode" })).toBe("q5 — Approve the plan?");
  });
});
