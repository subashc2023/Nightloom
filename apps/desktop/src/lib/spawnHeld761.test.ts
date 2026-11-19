// Item 761: a spawn the Agent hook holds for a same-type sibling's first
// reply says so on its row, through the passing-text store the backend's
// `tool_output` feeds (one line while held, none once it goes).
import { describe, expect, it } from "vitest";
import assistantMessageLogicRaw from "./assistantMessage/logic.svelte.ts?raw";
import { asOneFile } from "../test/oneFile";
import messageSrcRaw from "./AssistantMessage.svelte?raw";
const messageSrc = asOneFile(messageSrcRaw, assistantMessageLogicRaw);
import classicSrcRaw from "./AssistantMessageClassic.svelte?raw";
const classicSrc = asOneFile(classicSrcRaw, assistantMessageLogicRaw);
import { passingEvent, passingLines } from "./bashOutput.svelte";

const isShell = (n: string) => n === "Bash";

describe("a held spawn's row", () => {
  it("shows the hold's words while held and nothing once it goes", () => {
    const held = "Held: waiting for the first reusable helper's first reply, so this one starts from its cached prompt (at most 10 s)";
    expect(passingEvent({ type: "tool_output", tool_use_id: "toolu_AG", lines: [held] }, isShell)).toBe(true);
    expect(passingLines("toolu_AG")).toEqual([held]);
    passingEvent({ type: "tool_output", tool_use_id: "toolu_AG", lines: [] }, isShell);
    expect(passingLines("toolu_AG")).toEqual([]);
    // And an Agent call's result clears it at once (no remnant).
    passingEvent({ type: "tool_output", tool_use_id: "toolu_AG", lines: [held] }, isShell);
    passingEvent({ type: "tool_result", tool_use_id: "toolu_AG", name: "Agent", content: "report" }, isShell);
    expect(passingLines("toolu_AG")).toEqual([]);
  });

  it("is drawn on a running Agent row in both traces", () => {
    const mount = "{#if running && isAgentCall(seg.call.name)}<BashPassing id={seg.call.id} />{/if}";
    expect(messageSrc).toContain(mount);
    expect(classicSrc).toContain(mount);
    expect(classicSrc).toContain("class:bash-pass={(running && (shell || isAgentCall(seg.call.name))) || remnant}");
  });
});
