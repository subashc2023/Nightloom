import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ToolRow } from "./client";
import { PHONE_TOOL_VIEW_KEY, countRows, filterToolRows, phoneTools, setPhoneToolView, stepPhoneToolView } from "./toolView.svelte";

// Item 977 on the phone: the same three views, kept in the phone's own storage.
const row = (id: string, ok: boolean | null, children: ToolRow[] = [], name = "Bash"): ToolRow => ({ id, name, summary: "", ok, children });

describe("filterToolRows", () => {
  const tools = [row("a", true), row("b", false), row("c", null), row("q", true, [], "AskUserQuestion"), row("g", true, [row("g1", true), row("g2", false)], "Agent")];
  it("Show all keeps every row", () => {
    expect(countRows(filterToolRows(tools, "all"))).toBe(7);
  });
  it("Hide successful keeps failures, running calls, the question, and a parent of a failure", () => {
    const out = filterToolRows(tools, "failed");
    expect(out.map((t) => t.id)).toEqual(["b", "c", "q", "g"]);
    expect(out[3].children.map((t) => t.id)).toEqual(["g2"]);
  });
  it("Hide all keeps only the model's question", () => {
    expect(filterToolRows(tools, "none").map((t) => t.id)).toEqual(["q"]);
  });
});

describe("the phone's setting", () => {
  beforeEach(() => localStorage.clear());
  it("is saved under its own key and steps all → failed → none", () => {
    setPhoneToolView("all");
    stepPhoneToolView();
    expect(phoneTools.view).toBe("failed");
    expect(localStorage.getItem(PHONE_TOOL_VIEW_KEY)).toBe("failed");
    stepPhoneToolView();
    expect(phoneTools.view).toBe("none");
    setPhoneToolView("all");
  });
  it("the transcript's tool boxes, the chat menu and the cards are wired (974 + 977)", () => {
    const r = readFileSync(new URL("./Remote.svelte", import.meta.url), "utf8");
    expect(r).toContain("filterToolRows(all, phoneTools.view)");
    expect(r).toContain('use:keyPicks={{ pick: ".actions .btn:not(.quiet)" }}');
    expect(r).toContain("onenter={() => {");
    expect(readFileSync(new URL("./ChatMenu.svelte", import.meta.url), "utf8")).toContain("stepPhoneToolView");
  });
});
