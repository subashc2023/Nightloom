// Item 633: a running Bash command's real output as the row's passing text
// (Reticle's, taken into Combo). The store is driven directly; the rules are
// read from the components' source, as 610's and 616's are.
import { describe, expect, it } from "vitest";
import passingSrc from "./BashPassing.svelte?raw";
import messageSrc from "./AssistantMessage.svelte?raw";
import classicSrc from "./AssistantMessageClassic.svelte?raw";
import stateSrc from "./state.svelte.ts?raw";
import { PASSING_LINES, endPassing, passingLines, setPassing } from "./bashOutput.svelte";

const css = passingSrc.slice(passingSrc.indexOf("<style"));

describe("the passing-text store", () => {
  it("keeps each call's latest lines, at most six, and drops them at the end", () => {
    expect(passingLines("toolu_A")).toEqual([]);
    setPassing("toolu_A", ["a", "b"]);
    expect(passingLines("toolu_A")).toEqual(["a", "b"]);
    setPassing("toolu_A", ["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(passingLines("toolu_A")).toHaveLength(PASSING_LINES);
    expect(passingLines("toolu_A").at(-1)).toBe("8");
    setPassing("toolu_B", ["other"]);
    endPassing("toolu_A");
    expect(passingLines("toolu_A")).toEqual([]);
    expect(passingLines("toolu_B")).toEqual(["other"]);
    endPassing("toolu_B");
    setPassing("", ["no id"]);
    expect(passingLines("")).toEqual([]);
  });
});

describe("the row", () => {
  it("draws the passing text on a running shell row only, in the modern trace", () => {
    expect(messageSrc).toContain('{#if running && kind === "shell"}<BashPassing id={seg.call.id} />{/if}');
    expect(classicSrc).not.toContain("BashPassing");
  });

  it("is Combo's and Reticle's, never Sweep's, and behind the row", () => {
    expect(css).toMatch(/:global\(\.trace\[data-motion="sweep"\]\) \.passing \{\s*display: none;/);
    expect(css).toMatch(/\.passing \{[^}]*pointer-events: none;[^}]*z-index: -1;/);
    expect(passingSrc).toContain('aria-hidden="true"');
  });

  it("moves only by transform, and only under no-preference (Reduce motion: still)", () => {
    const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(motion).toMatch(/animation: pass-in/);
    const outside = css.slice(0, css.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(outside).not.toMatch(/animation:/);
    const frames = motion.slice(motion.indexOf("@keyframes pass-in"));
    expect(frames).toMatch(/from \{\s*transform: translateY\(10px\);\s*\}\s*to \{\s*transform: translateY\(0\);\s*\}/);
  });

  it("is fed by the live-only tool_output event, which never reaches the segments", () => {
    expect(stateSrc).toMatch(/if \(ev\.type === "tool_output"\) \{\s*setPassing\(ev\.tool_use_id, ev\.lines\);\s*return;/);
    expect(stateSrc).toMatch(/endPassing\(ev\.tool_use_id\)/);
  });
});
