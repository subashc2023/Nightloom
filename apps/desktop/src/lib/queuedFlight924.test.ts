import { describe, expect, it } from "vitest";
import { QUEUED_CHANNEL, launchAt, takeLaunch } from "./sendMotion";
import composerRaw from "./Composer.svelte?raw";
import midTurnRaw from "./MidTurnBubble.svelte?raw";

/**
 * Item 924 (his words 2026-11-23: "dosn't seem to be an animation when i
 * send a msg mid reply into claude"): a message sent while a turn runs
 * flies from the box into its waiting bubble, as a plain send flies into its
 * turn (backlog 194) — the main chat's and an aside's (both go through the
 * composer's `enqueue`, both draw the row as a `MidTurnBubble`).
 */
describe("924: the mid-reply send flies", () => {
  it("its launch is its own channel: the turn's bubble never takes it, the waiting bubble does", () => {
    launchAt({ channel: QUEUED_CHANNEL, at: performance.now(), x: 10, y: 600, w: 300, h: 20 });
    expect(takeLaunch("chat")).toBeNull();
    expect(takeLaunch(QUEUED_CHANNEL)?.y).toBe(600);
    expect(takeLaunch(QUEUED_CHANNEL)).toBeNull();
  });

  it("enqueue measures the box before it clears", () => {
    const body = composerRaw.slice(composerRaw.indexOf("async function enqueue()"), composerRaw.indexOf("async function unsend("));
    const at = body.indexOf("launch(QUEUED_CHANNEL, boxElement(ta))");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(body.indexOf("clearDraft(key, true)"));
    // Before the aside's early return, so an aside's queued question flies too.
    expect(at).toBeLessThan(body.indexOf("if (aside)"));
  });

  it("the waiting bubble lands it, in Jarvis and Classic", () => {
    const lands = midTurnRaw.match(/use:arriveFrom=\{\{ channel: QUEUED_CHANNEL/g) ?? [];
    expect(lands.length).toBe(2);
  });
});
