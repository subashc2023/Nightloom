import { beforeEach, describe, expect, it } from "vitest";
import type { Segment, ToolCallView } from "./state.svelte";
import {
  DEFAULT_TRANSCRIPT_PREFS,
  flipOverride,
  loadTranscriptPrefs,
  resolveOpen,
  saveTranscriptPrefs,
  segmentIds,
  setTranscriptPref,
  toggleTranscriptPref,
  toolInputSummary,
  toolResultSummary,
  toolSummary,
  transcript,
  applyTranscriptType,
  setTranscriptFont,
  setTranscriptSize,
} from "./transcriptPrefs.svelte";
import type { Override, TranscriptView } from "./transcriptPrefs.svelte";

// The pill bug (nightshift backlog 052): a click on a thinking block while
// the reply still streams has to win over "open while streaming", and stay
// won through the deltas that follow. `resolveOpen` is the whole of that
// rule, extracted so this file can pin it without a DOM.

function view(over: Partial<TranscriptView> = {}): TranscriptView {
  return {
    thinking: false,
    tools: true,
    font: "plex",
    size: 16,
    rev: { thinking: 0, tool: 0 },
    ...over,
  };
}

function call(over: Partial<ToolCallView> = {}): ToolCallView {
  return { id: "toolu_1", name: "bash", input: {}, result: null, ...over };
}

describe("resolveOpen", () => {
  it("opens the thinking block still streaming and closes the finished ones, by default", () => {
    const v = view();
    expect(resolveOpen("thinking", "thinking:0", true, false, {}, v)).toBe(true);
    expect(resolveOpen("thinking", "thinking:0", true, true, {}, v)).toBe(false);
    expect(resolveOpen("thinking", "thinking:0", false, true, {}, v)).toBe(false);
  });

  it("an explicit click closes a streaming thinking block and it stays closed", () => {
    const v = view();
    const o: Record<string, Override> = {};
    // The click lands while the block is forced open: it records "closed".
    o["thinking:0"] = flipOverride("thinking", "thinking:0", true, false, o, v);
    expect(o["thinking:0"].open).toBe(false);
    // The next delta re-evaluates with the same streaming state: still closed.
    expect(resolveOpen("thinking", "thinking:0", true, false, o, v)).toBe(false);
    // And when the block is marked done, still closed — the click won.
    expect(resolveOpen("thinking", "thinking:0", true, true, o, v)).toBe(false);
  });

  it("an explicit click opens a finished thinking block mid-stream", () => {
    const v = view();
    const o: Record<string, Override> = {};
    o["thinking:0"] = flipOverride("thinking", "thinking:0", true, true, o, v);
    expect(o["thinking:0"].open).toBe(true);
    expect(resolveOpen("thinking", "thinking:0", true, true, o, v)).toBe(true);
  });

  it("the thinking toggle on opens every block; a click still folds one", () => {
    const v = view({ thinking: true });
    expect(resolveOpen("thinking", "thinking:2", false, true, {}, v)).toBe(true);
    const o = { "thinking:2": flipOverride("thinking", "thinking:2", false, true, {}, v) };
    expect(o["thinking:2"].open).toBe(false);
    expect(resolveOpen("thinking", "thinking:2", false, true, o, v)).toBe(false);
    // The neighbour is untouched.
    expect(resolveOpen("thinking", "thinking:3", false, true, o, v)).toBe(true);
  });

  it("tool calls follow their toggle, and a click overrides one", () => {
    expect(resolveOpen("tool", "tool:a", false, true, {}, view({ tools: true }))).toBe(true);
    expect(resolveOpen("tool", "tool:a", false, true, {}, view({ tools: false }))).toBe(false);
    const v = view({ tools: false });
    const o = { "tool:a": flipOverride("tool", "tool:a", false, true, {}, v) };
    expect(resolveOpen("tool", "tool:a", false, true, o, v)).toBe(true);
  });

  it("a running tool call is not forced open by streaming", () => {
    expect(resolveOpen("tool", "tool:a", true, false, {}, view({ tools: false }))).toBe(false);
  });

  it("flipping a toggle clears the clicks of its kind and no other", () => {
    const v = view({ thinking: false, tools: true });
    const o: Record<string, Override> = {
      "thinking:0": flipOverride("thinking", "thinking:0", false, true, {}, v), // opened by click
      "tool:a": flipOverride("tool", "tool:a", false, true, {}, v), // folded by click
    };
    expect(resolveOpen("thinking", "thinking:0", false, true, o, v)).toBe(true);
    expect(resolveOpen("tool", "tool:a", false, true, o, v)).toBe(false);
    // Thinking toggled on: the thinking click is stale, the tool click stands.
    const v2 = { ...v, thinking: true, rev: { thinking: 1, tool: 0 } };
    expect(resolveOpen("thinking", "thinking:0", false, true, o, v2)).toBe(true);
    expect(resolveOpen("tool", "tool:a", false, true, o, v2)).toBe(false);
    // Thinking toggled off again: the block folds — the old click does not
    // come back, so the toggle visibly did something both times.
    const v3 = { ...v, thinking: false, rev: { thinking: 2, tool: 0 } };
    expect(resolveOpen("thinking", "thinking:0", false, true, o, v3)).toBe(false);
  });
});

describe("segmentIds", () => {
  const think = (done: boolean): Segment => ({ kind: "thinking", text: "…", done });
  const text: Segment = { kind: "text", text: "hi" };
  const tool = (id: string): Segment => ({ kind: "tool", call: call({ id }) });

  it("numbers thinking blocks among themselves and names tools by the API id", () => {
    expect(segmentIds([think(true), text, tool("toolu_9"), think(false)])).toEqual([
      "thinking:0",
      "",
      "tool:toolu_9",
      "thinking:1",
    ]);
  });

  it("appending segments, as the streaming builder does, moves no earlier id", () => {
    const segs: Segment[] = [think(true), tool("toolu_1")];
    const before = segmentIds(segs);
    segs.push(text, think(false), tool("toolu_2"));
    expect(segmentIds(segs).slice(0, 2)).toEqual(before);
  });
});

describe("toolSummary", () => {
  it("prefers the description, then the command, then the longest string", () => {
    expect(toolInputSummary({ command: "ls -la", description: "List the folder" })).toBe(
      "List the folder",
    );
    expect(toolInputSummary({ command: "ls -la", timeout: 5 })).toBe("ls -la");
    expect(toolInputSummary({ a: "short", b: "a much longer argument" })).toBe(
      "a much longer argument",
    );
    expect(toolInputSummary({ file_path: "/tmp/x.md", offset: 3 })).toBe("/tmp/x.md");
  });

  it("falls back to compact JSON for inputs with no string in them", () => {
    expect(toolInputSummary({ n: 3 })).toBe('{"n":3}');
    expect(toolInputSummary("plain")).toBe('"plain"');
    expect(toolInputSummary(null)).toBe("null");
  });

  it("cuts to one line of about sixty characters", () => {
    const long = "x".repeat(200);
    const s = toolInputSummary({ command: long });
    expect(s.length).toBe(60);
    expect(s.endsWith("…")).toBe(true);
    expect(toolInputSummary({ command: "echo a\n\n  echo   b" })).toBe("echo a echo b");
  });

  it("says what came back, or that nothing has yet", () => {
    expect(toolResultSummary(call(), true)).toBe("running");
    expect(toolResultSummary(call(), false)).toBe("no result");
    expect(toolResultSummary(call({ result: { content: "a".repeat(1234), is_error: false } }), false)).toBe(
      "1,234 chars",
    );
    expect(toolResultSummary(call({ result: { content: "boom", is_error: true } }), false)).toBe(
      "error · 4 chars",
    );
    expect(toolResultSummary(call({ denied: true, result: { content: "no", is_error: true } }), false)).toBe(
      "denied",
    );
  });

  it("joins the three with middle dots", () => {
    const c = call({
      name: "Bash",
      input: { command: "cat post.md", description: "Print second post's text" },
      result: { content: "x".repeat(30336), is_error: false },
    });
    expect(toolSummary(c, false)).toBe("Bash · Print second post's text · 30,336 chars");
  });
});

describe("prefs storage", () => {
  beforeEach(() => localStorage.clear());

  // Plex at 16 px and the pre-toggle reading (thinking off, tools on):
  // the defaults a first launch after the release must not change.
  const defaults = { thinking: false, tools: true, font: "plex", size: 16 };

  it("defaults to thinking off and tools on, Plex at 16 px", () => {
    expect(DEFAULT_TRANSCRIPT_PREFS).toEqual(defaults);
    expect(loadTranscriptPrefs()).toEqual(defaults);
  });

  it("round-trips through localStorage", () => {
    saveTranscriptPrefs({ thinking: true, tools: false, font: "newsreader", size: 17 });
    expect(loadTranscriptPrefs()).toEqual({
      thinking: true,
      tools: false,
      font: "newsreader",
      size: 17,
    });
  });

  it("survives a malformed or partial record by falling to the defaults", () => {
    localStorage.setItem("nightloom.transcript", "{not json");
    expect(loadTranscriptPrefs()).toEqual(defaults);
    localStorage.setItem(
      "nightloom.transcript",
      JSON.stringify({ thinking: "yes", tools: false, font: "comic", size: 40 }),
    );
    expect(loadTranscriptPrefs()).toEqual({ ...defaults, tools: false });
  });

  it("setting a pref saves it and bumps only its kind's revision", () => {
    const revThinking = transcript.rev.thinking;
    const revTool = transcript.rev.tool;
    setTranscriptPref("thinking", true);
    expect(transcript.thinking).toBe(true);
    expect(transcript.rev.thinking).toBe(revThinking + 1);
    expect(transcript.rev.tool).toBe(revTool);
    expect(loadTranscriptPrefs().thinking).toBe(true);
    toggleTranscriptPref("tool");
    expect(transcript.tools).toBe(false);
    expect(transcript.rev.tool).toBe(revTool + 1);
    expect(loadTranscriptPrefs()).toEqual({ ...defaults, thinking: true, tools: false });
  });

  it("the face and size land on the root as two custom properties", () => {
    const set: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => void (set[k] = v) } };
    applyTranscriptType({ font: "newsreader", size: 15 }, root);
    expect(set).toEqual({ "--transcript-font": "var(--serif)", "--transcript-size": "15px" });
    applyTranscriptType({ font: "plex", size: 17 }, root);
    expect(set["--transcript-font"]).toBe("var(--sans)");
    expect(set["--transcript-size"]).toBe("17px");
  });

  it("setting the face or size is saved", () => {
    setTranscriptFont("newsreader");
    setTranscriptSize(17);
    expect(loadTranscriptPrefs().font).toBe("newsreader");
    expect(loadTranscriptPrefs().size).toBe(17);
  });
});
