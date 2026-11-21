import { beforeEach, describe, expect, it } from "vitest";
import { errorWeight, retriedAfter, softKind, softLine } from "./errorWeight";
import { toolResultSummary } from "./transcriptPrefs.svelte";
import { activitySummary, waitingLabel } from "./activity";
import { lastLoggedTurn, toolMarks } from "./contextDial";
import { rowsFromLog } from "./subagentRows";
import { rowState, stateLabel } from "./taskGroups";
import { commandsOf, commandsText } from "./agentCommands";
import { waitingOn, type StillRunningSegment } from "./stillRunning";
import { app, applyTurnEvent } from "./state.svelte";
import type { SessionEvent, SubagentStatus, TurnEvent } from "./types";
import assistantMessageLogicRaw from "./assistantMessage/logic.svelte.ts?raw";
import { asOneFile } from "../test/oneFile";
import jarvisSrcRaw from "./AssistantMessage.svelte?raw";
const jarvisSrc = asOneFile(jarvisSrcRaw, assistantMessageLogicRaw);
import classicSrcRaw from "./AssistantMessageClassic.svelte?raw";
const classicSrc = asOneFile(classicSrcRaw, assistantMessageLogicRaw);
import subViewSrc from "./SubagentView.svelte?raw";

/**
 * Item 700 (his words 2026-11-15: "the red should be reserved for like
 * serious errors or issues. yellow maybe for others?"): an error's weight,
 * and the working line while the turn waits only on background agents.
 */

// The notices as Claude Code 2.1.325 words them (its binary's strings).
const NO_VERDICT =
  "Bash did not run. The automatic safety check gave no verdict on this call, and Claude Code doesn't ask for approval in its place here: auto mode is on. This is not a judgment that the action is unsafe, so issue the Bash call again.";
const NO_RESULT =
  "Bash was not run: only auto mode's safety check can allow it, and that check gave no result. No permission prompt is raised for this tool. This is not a judgment that the action is unsafe. Continue with work that doesn't need it, then tell the user that it was not run and why.";
const UNAVAILABLE = "Auto mode classifier unavailable, denying with retry guidance (fail closed)";
const RECHECK_AUTO =
  "Bash expected this call not to need a review, but it needs one. This is a routine re-check, not an error and not a refusal, and it says nothing about whether the action is safe. Issue the action again once, as-is, in your next response.";
const UNREAD = "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>";
const STALE =
  "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
const PATH_RECHECK =
  'The directory "/x" is the directory that this command was permission-checked in (it was deleted), so the command was not run. Re-issue the command to have it checked afresh.';
const BASH_FAIL = "Exit code 1\nnpm ERR! Test failed. See above for more details.";
const EDIT_FAIL = "<tool_use_error>String to replace not found in file.\nString: foo</tool_use_error>";

const err = (content: string) => ({ content, is_error: true });

describe("700: errorWeight", () => {
  it("weighs each 'not run, redo it' notice soft", () => {
    for (const t of [NO_VERDICT, NO_RESULT, UNAVAILABLE, RECHECK_AUTO, UNREAD, STALE, PATH_RECHECK]) {
      expect(errorWeight(err(t)), t).toBe("soft");
    }
    expect(softKind(NO_VERDICT)).toBe("auto");
    expect(softKind(UNREAD)).toBe("unread");
    expect(softKind(STALE)).toBe("stale");
    expect(softKind(PATH_RECHECK)).toBe("recheck");
  });

  it("weighs an ordinary failure hard, and no error not at all", () => {
    expect(errorWeight(err(BASH_FAIL))).toBe("hard");
    expect(errorWeight(err(EDIT_FAIL))).toBe("hard");
    expect(errorWeight({ content: NO_VERDICT, is_error: false })).toBeNull();
    expect(errorWeight(null)).toBeNull();
  });

  it("folds a soft box to one line, saying whether the model issued it again", () => {
    expect(softLine(NO_VERDICT, false)).toBe("auto mode could not check this call — not run");
    expect(softLine(NO_VERDICT, true)).toBe("auto mode could not check this call — not run, retried");
    expect(softLine(UNREAD, false)).toBe("the file was not read first — not run");
    const call = (id: string, cmd: string) => ({ kind: "tool", call: { id, name: "Bash", input: { command: cmd } } });
    const segs = [call("a", "ls"), { kind: "text" }, call("b", "ls")];
    expect(retriedAfter(segs, 0)).toBe(true);
    expect(retriedAfter([call("a", "ls"), call("b", "pwd")], 0)).toBe(false);
  });

  it("says 'not run', not 'error', in the row's one line and the fold line", () => {
    const view = (content: string) => ({ id: "t", name: "Bash", input: {}, result: err(content) });
    expect(toolResultSummary(view(NO_VERDICT), false)).toBe(`not run · ${NO_VERDICT.length.toLocaleString()} chars`);
    expect(toolResultSummary(view(BASH_FAIL), false)).toMatch(/^error · /);
    const rows = [
      { seg: { kind: "tool" as const, call: view(NO_VERDICT) }, i: 0 },
      { seg: { kind: "tool" as const, call: view(BASH_FAIL) }, i: 1 },
    ];
    expect(activitySummary(rows as never)).toBe("2 tool calls · 1 error · 1 not run");
  });

  it("marks the rail's tool ticks amber for a soft one, live and from the log", () => {
    const marks = toolMarks([
      { kind: "tool", call: { result: err(NO_VERDICT) } },
      { kind: "tool", call: { result: err(BASH_FAIL) } },
    ]);
    expect(marks).toEqual([
      { done: true, error: false, soft: true },
      { done: true, error: true },
    ]);
    const logged = lastLoggedTurn([
      { event: "user_message", at: "2026-11-15T20:00:00Z" },
      { event: "assistant_message", at: "2026-11-15T20:00:01Z", blocks: [{ type: "tool_use", id: "a" }] },
      { event: "tool_result", tool_use_id: "a", is_error: true, content: UNREAD },
    ]);
    expect(logged?.tools).toEqual([{ done: true, error: false, soft: true }]);
  });

  it("gives an Agent call the harness did not run 'not run', not 'failed'", () => {
    const events = [
      { event: "user_message", text: "go", at: "2026-11-15T20:00:00Z" },
      { event: "assistant_message", model: "m", blocks: [{ type: "tool_use", id: "ag", name: "Agent", input: { description: "scan" } }], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 }, at: "2026-11-15T20:00:01Z" },
      { event: "tool_result", tool_use_id: "ag", name: "Agent", content: NO_VERDICT, is_error: true, at: "2026-11-15T20:00:02Z" },
    ] as unknown as SessionEvent[];
    const [r] = rowsFromLog(events, "s");
    expect(r.status).toBe("not run");
    expect(rowState(r)).toBe("soft");
    expect(stateLabel(r)).toBe("not run");
    expect(rowState({ status: "failed" })).toBe("failed");
  });

  it("draws soft amber and hard red in every view of a call (Jarvis, Classic, a subagent's rows)", () => {
    for (const src of [jarvisSrc, classicSrc]) {
      expect(src).toMatch(/errorWeight\(seg\.call\.result\)/);
      expect(src).toMatch(/\.tool-result\.soft \{\s*color: var\(--partial\);/);
      expect(src).toMatch(/\.arow\.soft \.arg,/);
      expect(src).toMatch(/\{@render softBox\(/);
    }
    expect(jarvisSrc).toMatch(/\{:else if st === "soft"\}↻/);
    expect(subViewSrc).toMatch(/class:soft=\{w === "soft"\}/);
    expect(subViewSrc).toMatch(/fallback: depth === 0 && w === "hard"/);
  });

  it("colours a subagent's terminal: red for a failure, yellow for a call not run", () => {
    const live = [
      { kind: "tool", call: { id: "a", name: "Bash", input: { command: "ls" }, result: err(NO_VERDICT) } },
      { kind: "tool", call: { id: "b", name: "Bash", input: { command: "make" }, result: err(BASH_FAIL) } },
    ];
    const rows = commandsOf([], live as never);
    expect(rows.map((r) => [r.error, !!r.soft])).toEqual([
      [false, true],
      [true, false],
    ]);
    const text = commandsText(rows, false);
    expect(text).toContain("\x1b[33m↻ not run");
    expect(text).toContain("\x1b[31m✗ failed");
  });
});

const status = (over: Partial<SubagentStatus> = {}): TurnEvent =>
  ({
    type: "subagent_status",
    tool_use_id: "toolu_a",
    task_id: "a1",
    subagent_type: "general-purpose",
    description: "funding scan",
    prompt: "Scan.",
    status: "running",
    background: true,
    tokens: 0,
    tool_uses: 0,
    duration_ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    rounds: 0,
    ...over,
  }) as TurnEvent;

describe("700: waiting on agents", () => {
  beforeEach(() => {
    app.subagents = [];
    app.toasts = [];
    app.activeSessionId = null;
    app.live = { segments: [{ kind: "tool", call: { id: "toolu_a", name: "Agent", input: {}, result: null } }] } as never;
  });

  it("says 'waiting on N agents' from a stream whose reply ended with agents running", () => {
    applyTurnEvent(status());
    applyTurnEvent(status({ tool_use_id: "toolu_b", task_id: "b1", description: "pricing scan" }));
    applyTurnEvent({ type: "still_running", tasks: ["funding scan", "pricing scan"] } as TurnEvent);
    const segs = app.live!.segments;
    expect(waitingOn(segs, app.subagents)).toBe(2);
    expect(waitingLabel(waitingOn(segs, app.subagents), 178_000)).toBe("waiting on 2 agents · 2 min 58 s");
    // One reports: one left.
    applyTurnEvent(status({ status: "completed" }));
    expect(waitingLabel(waitingOn(app.live!.segments, app.subagents), 5_000)).toBe("waiting on 1 agent · 5 s");
    // The turn moves (the main agent woke and wrote): back to working.
    applyTurnEvent({ type: "text_delta", text: "One is back." } as TurnEvent);
    expect(waitingOn(app.live!.segments, app.subagents)).toBeNull();
    expect(waitingLabel(waitingOn(app.live!.segments, app.subagents), 5_000)).toBe("working · 5 s");
  });

  it("is not waiting once he pressed Stop, or when none still runs", () => {
    const seg: StillRunningSegment = { kind: "still_running", tasks: ["x"], ids: ["x"] };
    expect(waitingOn([seg], [{ tool_use_id: "x", description: "x", status: "running" }])).toBe(1);
    const stopped: StillRunningSegment = { ...seg, stopped: true };
    expect(waitingOn([stopped], [{ tool_use_id: "x", description: "x", status: "running" }])).toBeNull();
    expect(waitingOn([seg], [{ tool_use_id: "x", description: "x", status: "completed" }])).toBeNull();
    expect(waitingLabel(null, 1000)).toBe("working · 1 s");
  });

  it("runs the edge light round the trace block in Jarvis, calm and still under reduced motion", () => {
    expect(jarvisSrc).toMatch(/class:waiting=\{last && waitAgents !== null\}/);
    expect(jarvisSrc).toMatch(/<svg class="wait-edge"/);
    expect(jarvisSrc).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.wait-edge rect \{\s*animation: wait-edge 6s linear infinite;/);
    // Classic: the label only.
    expect(classicSrc).toMatch(/waitingLabel\(waitAgents,/);
    expect(classicSrc).not.toMatch(/wait-edge/);
  });
});
