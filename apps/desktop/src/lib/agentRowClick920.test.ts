import { describe, expect, it } from "vitest";
import { DRAG_AWAY_PX, draggedAway } from "./assistantMessage/logic.svelte";
import logicRaw from "./assistantMessage/logic.svelte.ts?raw";
import jarvisRaw from "./AssistantMessage.svelte?raw";
import classicRaw from "./AssistantMessageClassic.svelte?raw";

/**
 * Item 920 (his words 2026-11-23: "noticed i couldnt click on this error for
 * a few seconds"): an Agent row is a drag source, and WebKit starts a drag
 * after 3 px — a trackpad click that moved that much opened the row on the
 * press and shut it again at the drag's start. The flip is now undone only
 * when the drag ends far from the press.
 */
describe("920: an Agent row's click survives a jittered press", () => {
  it("a drag end near the press is a click; a far one is a drag", () => {
    const at = { x: 100, y: 200 };
    expect(draggedAway(at, { x: 103, y: 201 })).toBe(false);
    expect(draggedAway(at, { x: 100 + DRAG_AWAY_PX - 1, y: 200 })).toBe(false);
    expect(draggedAway(at, { x: 100 + DRAG_AWAY_PX, y: 200 })).toBe(true);
    expect(draggedAway(at, { x: 400, y: 30 })).toBe(true);
    // An engine that reports no place: the old behaviour (undo the flip).
    expect(draggedAway(at, { x: 0, y: 0 })).toBe(true);
  });

  it("the drag's start no longer undoes the press; its end decides", () => {
    const start = logicRaw.slice(logicRaw.indexOf("function dragAgent("), logicRaw.indexOf("function dragAgentEnd("));
    expect(start).not.toMatch(/toggle\(/);
    expect(start).toMatch(/startContentDrag\(e, content\)/);
    const end = logicRaw.slice(logicRaw.indexOf("function dragAgentEnd("));
    expect(end.slice(0, 400)).toMatch(/endContentDrag\(\)/);
    expect(end.slice(0, 400)).toMatch(/draggedAway\(from/);
  });

  for (const [name, src] of [
    ["Jarvis", jarvisRaw],
    ["Classic", classicRaw],
  ] as const) {
    it(`${name}: the row ends its drag through dragAgentEnd, and the soft notice opens on the press`, () => {
      expect(src).toMatch(/ondragend=\{agentTab \? \(e\) => T\.dragAgentEnd\(e\)/);
      const soft = src.slice(src.indexOf("{#snippet softBox("), src.indexOf("{/snippet}", src.indexOf("{#snippet softBox(")));
      expect(soft).toMatch(/onpointerdown=/);
      expect(soft).toMatch(/e\.detail === 0/);
    });
  }
});
