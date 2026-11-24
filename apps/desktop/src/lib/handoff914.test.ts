import { beforeEach, describe, expect, it, vi } from "vitest";
import { handoff, markAttended, noteActivity, noteAgentTurnEnd, noteShown, resetHandoff, setMarkAt, stayHere } from "./handoff.svelte";
import { app, askAside } from "./state.svelte";
import { drafts } from "./drafts.svelte";
import * as api from "./api";
import composerSrc from "./Composer.svelte?raw";

/**
 * Item 914 (his bug, 2026-11-23: "past 300k but there's no handoff thing? is
 * it cuz i sent like an 'ask aside' question since the handoff thing
 * apperaed"): the card is removed only by its own buttons or a sent
 * hand-off. The cause was not the aside — it touches no hand-off state —
 * but that the open chat's card went whenever another chat's reading took
 * the projection (`handoff.chat`), or the app relaunched, and nothing read
 * it back until the chat's own next turn ended.
 */

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(async () => ({
    answer: "an answer",
    cost_usd: 0,
    cache_read: 10,
    is_error: false,
    notices: [],
    model: "claude-opus-5",
    input_tokens: 1200,
    output_tokens: 34,
  })),
  cancelAside: vi.fn(async () => null),
}));

const LIMIT = 1_000_000;
const PAST = 310_000; // past the 300k cap

function reset(): void {
  resetHandoff();
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const c of ["a", "b", "c", "fresh"]) {
    markAttended(c);
    setMarkAt("chat", c, null);
  }
  // Present: nothing typed long ago would read as away.
  noteActivity(Date.now());
  app.activeSessionId = "a";
  app.asides = [];
  app.aside = null;
  app.connection = {
    provider: "claude-code",
    model: "default",
    thinking: "off",
    tools: false,
    contextLimit: LIMIT,
    price: null,
    mcp: [],
    reviewers: [],
    workspace: "/tmp",
    search: null,
    knowledge: null,
    engine: "claude-code",
    agent: null,
  };
  vi.mocked(api.askAside).mockClear();
}

describe("914 — the card stays until its buttons or a hand-off remove it", () => {
  beforeEach(reset);

  it("card up → an aside asked and answered → the card is still up", async () => {
    noteAgentTurnEnd("a", PAST, LIMIT, [], true);
    expect([handoff.chat, handoff.stage]).toEqual(["a", "due"]);
    await askAside("a side question");
    expect(api.askAside).toHaveBeenCalledTimes(1);
    expect(app.asides[0]?.turns[0]?.answer).toBe("an answer");
    expect([handoff.chat, handoff.stage]).toEqual(["a", "due"]);
  });

  it("another chat's turn end took the card away; coming back to the chat brings it back", () => {
    noteAgentTurnEnd("a", PAST, LIMIT, [], true);
    // A turn ends in chat b (on screen or in the background).
    noteAgentTurnEnd("b", 20_000, LIMIT, [], false);
    expect(handoff.chat).toBe("b");
    // Chat a open again, idle: the composer's reading.
    noteShown("a", PAST, LIMIT);
    expect([handoff.chat, handoff.stage, handoff.queuedId]).toEqual(["a", "due", 0]);
    expect(handoff.used).toBe(PAST);
  });

  it("after a relaunch (no stage kept) the open chat past its mark shows the card, and queues nothing", () => {
    noteShown("fresh", PAST, LIMIT);
    expect([handoff.chat, handoff.stage, handoff.queuedId]).toEqual(["fresh", "due", 0]);
    expect(drafts["fresh"]?.queue ?? []).toEqual([]);
  });

  it("a reading on open never lowers the stage (a stale or missing figure cannot put the card away)", () => {
    noteAgentTurnEnd("a", PAST, LIMIT, [], true);
    noteAgentTurnEnd("b", 20_000, LIMIT, [], false);
    noteShown("a", 5_000, LIMIT);
    expect([handoff.chat, handoff.stage]).toEqual(["a", "due"]);
    // No figure at all: nothing moves.
    noteAgentTurnEnd("b", 20_000, LIMIT, [], false);
    noteShown("a", null, LIMIT);
    expect(handoff.chat).toBe("b");
  });

  it("a Stay here is kept across the switch (the card does not come back unasked)", () => {
    noteAgentTurnEnd("a", PAST, LIMIT, [], true);
    stayHere();
    const at = handoff.dismissedAt;
    expect(at).toBeGreaterThan(0);
    noteAgentTurnEnd("b", 20_000, LIMIT, [], false);
    noteShown("a", PAST + 1000, LIMIT);
    expect([handoff.chat, handoff.stage, handoff.dismissedAt]).toEqual(["a", "idle", at]);
  });

  it("the shown chat's reading is a no-op (its own turn readings move it)", () => {
    noteAgentTurnEnd("a", PAST, LIMIT, [], true);
    noteShown("a", 5_000, LIMIT);
    expect(handoff.stage).toBe("due");
  });

  it("the chat's composer (not an aside's) calls it whenever the open chat is not the one shown and no turn runs", () => {
    const i = composerSrc.indexOf("noteShown(chat, used, limit)");
    expect(i).toBeGreaterThan(0);
    const effect = composerSrc.slice(composerSrc.lastIndexOf("$effect(", i), i);
    expect(effect).toContain("if (aside || app.busy");
    expect(effect).toContain("handoff.chat === app.activeSessionId");
  });
});
