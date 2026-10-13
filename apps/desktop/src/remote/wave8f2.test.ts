// Nightshift 300, wave 8B F2: the reply's order, subagent steps, the live
// turn's order, the menu's preview, the keyboard fit, code blocks.
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../lib/types";
import { emptyTurn, foldTurnEvent, liveSegments, transcriptRows } from "./client";
import { plainPreview } from "./preview";
import { fitTo } from "./viewport";
import { codeLanguage, moreRight } from "./codeBlocks";

const at = "2026-10-04T19:00:00Z";
const M = "claude-haiku-4-5";
const am = (blocks: unknown[]): SessionEvent => ({ event: "assistant_message", model: M, blocks, at }) as unknown as SessionEvent;

const subagentLog = (): SessionEvent[] => [
  { event: "user_message", text: "go", at } as SessionEvent,
  am([{ type: "text", text: "I'll launch a subagent." }, { type: "tool_use", id: "A1", name: "Agent", input: { description: "List" } }]),
  { event: "tool_result", tool_use_id: "A1", name: "Agent", content: "done", at } as unknown as SessionEvent,
  am([
    { type: "text", text: '<subagent parent="A1">\n▸ Bash ls -la /a/very/long/path\n↳ total 800\nIt has 30 entries.\n</subagent>' },
    { type: "text", text: "Found 30. Reading one." },
    { type: "tool_use", id: "B1", name: "Read", input: { file_path: "/tmp/x" } },
    { type: "tool_use", id: "B2", name: "Read", input: { file_path: "/tmp/y" } },
  ]),
  am([{ type: "text", text: "Done." }]),
];

describe("transcriptRows: order and subagents (300 A1, A2)", () => {
  it("keeps words and calls in the order they happened, a run of calls one box", () => {
    const r = transcriptRows(subagentLog())[1];
    if (r.kind !== "assistant") throw new Error("reply expected");
    const shape = r.seq.map((s) => (s.kind === "text" ? `text:${s.part.text}` : `tools:${s.tools.map((t) => t.name).join("+")}`));
    expect(shape).toEqual(["text:I'll launch a subagent.", "tools:Agent", "text:Found 30. Reading one.", "tools:Read+Read", "text:Done."]);
  });
  it("folds the subagent block under its Agent call, never as prose", () => {
    const r = transcriptRows(subagentLog())[1];
    if (r.kind !== "assistant") throw new Error("reply expected");
    expect(r.text).not.toContain("<subagent");
    expect(r.text).not.toContain("▸");
    expect(r.parts.map((p) => p.text)).toEqual(["I'll launch a subagent.", "Found 30. Reading one.", "Done."]);
    const agent = r.tools.find((t) => t.id === "A1");
    expect(agent?.steps).toBe("▸ Bash ls -la /a/very/long/path\n↳ total 800\nIt has 30 entries.");
    expect(agent?.ok).toBe(true);
  });
  it("keeps the old lists whole (tools and parts) for the menu", () => {
    const r = transcriptRows(subagentLog())[1];
    if (r.kind !== "assistant") throw new Error("reply expected");
    expect(r.tools.map((t) => t.id)).toEqual(["A1", "B1", "B2"]);
  });
  it("a subagent block with no call to hang on draws as its own Agent card", () => {
    const rows = transcriptRows([am([{ type: "text", text: '<subagent parent="gone">\n▸ Read a\n</subagent>' }])]);
    const r = rows[0];
    if (r.kind !== "assistant") throw new Error("reply expected");
    expect(r.parts).toEqual([]);
    expect(r.seq).toHaveLength(1);
    expect(r.seq[0].kind === "tools" && r.seq[0].tools[0]).toMatchObject({ name: "Agent", steps: "▸ Read a" });
  });
});

describe("liveSegments (300 A2, the live turn)", () => {
  it("puts each call where it came in the streaming text", () => {
    let live = emptyTurn();
    live = foldTurnEvent(live, { type: "text_delta", text: "First I look. " } as never);
    live = foldTurnEvent(live, { type: "tool_call", id: "c1", name: "Bash", input: { command: "ls" } } as never);
    live = foldTurnEvent(live, { type: "tool_call", id: "c2", name: "Read", input: { file_path: "/x" } } as never);
    live = foldTurnEvent(live, { type: "text_delta", text: "Then I answer." } as never);
    expect(liveSegments(live).map((s) => (s.kind === "text" ? s.text : s.tools.map((t) => t.id).join("+")))).toEqual(["First I look. ", "c1+c2", "Then I answer."]);
  });
  it("a call with no recorded place (an older fold) goes before the text, as before", () => {
    const live = { text: "words", tools: [{ id: "x", name: "Bash", summary: "", ok: null, children: [] }], compacted: false };
    expect(liveSegments(live).map((s) => s.kind)).toEqual(["tools", "text"]);
  });
});

describe("plainPreview (300 A25)", () => {
  it("drops the marks and keeps the words", () => {
    expect(plainPreview("# Plan\nSome **bold** and *it* and `code` and [a link](http://x).")).toBe("Plan\nSome bold and it and code and a link.");
  });
  it("lists, quotes, tables and fences read as text", () => {
    expect(plainPreview("- one\n- two\n> said\n| a | b |\n|---|---|\n| 1 | 2 |\n```ts\nlet x = 1;\n```")).toBe("• one\n• two\nsaid\na · b\n1 · 2\nlet x = 1;");
  });
  it("spends none of its three lines on blank ones", () => {
    expect(plainPreview("# Plan\n\nHere is a **table**:\n\n\nAnd more.")).toBe("Plan\nHere is a table:\nAnd more.");
  });
  it("leaves snake_case and arithmetic alone", () => {
    expect(plainPreview("call my_func_name with 2 * 3 * 4")).toBe("call my_func_name with 2 * 3 * 4");
  });
});

describe("fitTo (300 A15)", () => {
  it("sizes the page to the visible part when the keyboard is up", () => {
    expect(fitTo(874, { height: 520, offsetTop: 300, scale: 1 })).toEqual({ height: 520, top: 300, keyboard: true });
  });
  it("Safari's bars moving is not a keyboard", () => {
    expect(fitTo(874, { height: 800, offsetTop: 0, scale: 1 })).toEqual({ height: 800, top: 0, keyboard: false });
  });
  it("a pinch zoom leaves the page alone", () => {
    expect(fitTo(874, { height: 400, offsetTop: 100, scale: 2 })).toBeNull();
    expect(fitTo(874, null)).toBeNull();
  });
});

describe("code blocks (300 A24)", () => {
  it("reads the fence's language", () => {
    expect(codeLanguage("language-python")).toBe("python");
    expect(codeLanguage("hljs language-c++")).toBe("c++");
    expect(codeLanguage("")).toBe("");
  });
  it("fades the edge only while more is to the right", () => {
    expect(moreRight(0, 600, 360)).toBe(true);
    expect(moreRight(240, 600, 360)).toBe(false);
    expect(moreRight(0, 360, 360)).toBe(false);
  });
});
