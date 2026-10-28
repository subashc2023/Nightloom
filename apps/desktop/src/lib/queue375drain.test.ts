import { beforeEach, describe, expect, it, vi } from "vitest";
// Svelte's client runtime, as compiled components use it: the composer's
// `key` is a `$derived`, and the bug lived in what such a derived returns
// once its component is torn down.
// @ts-expect-error -- Svelte ships no type declarations for its internal client runtime.
import * as $ from "svelte/internal/client";
import { draftKey, drafts, enqueueMessage, readDraft } from "./drafts.svelte";
import { app, openChatKey, takeQueued, turnOwnsKey } from "./state.svelte";
import composerSrc from "./Composer.svelte?raw";
import stateSrc from "./state.svelte?raw";

// Nightshift backlog 375 (his report, 2026-10-18), review: drive the
// drain the way the composer runs it across the real switch. He queued a
// message in an AI Safety Collective chat while its turn ran, opened a
// chat in ICS 51 (another project) — which tears down the composer that
// sent the turn — and when the AISCI turn ended its queued message was
// sent into the ICS 51 chat. `send()` goes to the chat open now; the drain
// took the row by the torn-down composer's key, which still said AISCI.

const AISCI = "chat-aisci";
const ICS51 = "chat-ics51";

/** A composer's `key` exactly as Composer.svelte derives it, in Svelte's
 *  client runtime; `tearDown` is the view change destroying it. */
function mountComposerKey(active: { v: unknown }, project: { v: unknown }) {
  let read = (): string => "";
  const tearDown = $.effect_root(() => {
    const key = $.derived(() => draftKey($.get(active as never), $.get(project as never)));
    read = () => $.get(key) as string;
    $.render_effect(() => void $.get(key));
  });
  $.flush();
  return { key: () => read(), tearDown };
}

/** The chat a drained row is sent to: `send()` reads the open chat. */
function sendTarget(): string | null {
  return app.activeSessionId;
}

function open(chat: string, project: string) {
  app.activeSessionId = chat;
  app.project = { id: project } as never;
}

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("375: a queued message never reaches another chat (the drain, driven)", () => {
  it("a turn that ends after a switch to another project's chat sends nothing there", () => {
    open(AISCI, "p-aisci");
    const active = $.state(AISCI);
    const project = $.state("p-aisci");
    const composer = mountComposerKey(active, project);
    // He sends in AISCI: the turn leaves from the open chat's key.
    const from = openChatKey();
    // While it runs he queues a message there.
    enqueueMessage(composer.key(), "for AISCI only", []);
    // He opens a chat in ICS 51: the composer that sent the turn is torn down.
    composer.tearDown();
    $.set(active, ICS51);
    $.set(project, "p-ics51");
    $.flush();
    open(ICS51, "p-ics51");
    // The mechanism, as measured: the torn-down composer's key is stale.
    expect(composer.key()).toBe(AISCI);

    // The AISCI turn ends: its composer's drain runs.
    const row = takeQueued(composer.key(), false, from);
    const sent = row ? { to: sendTarget(), text: row.text } : null;
    expect(sent).toBeNull();
    expect(readDraft(AISCI).queue.map((r) => r.text)).toEqual(["for AISCI only"]);

    // Send next pressed in ICS 51, even through the stale composer: only ICS 51's queue.
    expect(takeQueued(composer.key(), false)).toBeNull();
    enqueueMessage(ICS51, "for ICS 51", []);
    const mine = takeQueued(composer.key(), false);
    expect(mine && { to: sendTarget(), text: mine.text }).toEqual({ to: ICS51, text: "for ICS 51" });
    expect(readDraft(AISCI).queue.map((r) => r.text)).toEqual(["for AISCI only"]);

    // Back in AISCI, Send next sends it there.
    open(AISCI, "p-aisci");
    const back = takeQueued(AISCI, false);
    expect(back && { to: sendTarget(), text: back.text }).toEqual({ to: AISCI, text: "for AISCI only" });
  });

  it("whatever a drain takes comes from the queue of the chat it is sent to", () => {
    enqueueMessage(AISCI, "a", []);
    enqueueMessage(ICS51, "b", []);
    for (const [chat, stale] of [
      [ICS51, AISCI],
      [AISCI, ICS51],
    ]) {
      open(chat, "p");
      const before = readDraft(chat).queue.map((r) => r.text);
      const row = takeQueued(stale, false);
      expect(row ? [row.text] : []).toEqual(before.slice(0, 1));
    }
  });

  it("a row goes into a running turn only if the turn is its chat's", () => {
    expect(turnOwnsKey({ chat: AISCI }, AISCI)).toBe(true);
    expect(turnOwnsKey({ chat: ICS51 }, AISCI)).toBe(false);
    // A New chat's first turn: its pending key, before and after it has an id.
    expect(turnOwnsKey({ chat: null, pendingKey: "new:p-aisci:normal" }, "new:p-aisci:normal")).toBe(true);
    expect(turnOwnsKey({ chat: null, pendingKey: "new:p-aisci:normal" }, "new:p-ics51:normal")).toBe(false);
    expect(turnOwnsKey({ chat: null, pendingKey: null }, AISCI)).toBe(false);
  });

  it("the composer and the turn use these rules", () => {
    expect(composerSrc).toContain("const q = takeQueued(key, aside !== null, from);");
    expect(composerSrc.match(/sendKey !== key \|\| sendKey !== liveKey\(\)/g)?.length).toBe(2);
    expect(stateSrc).toMatch(/const turn = fg;\s*if \(!turn \|\| !app\.busy \|\| app\.parked\) return;[^]*?if \(!turnOwnsKey\(turn, key\)\) return;/);
  });
});
