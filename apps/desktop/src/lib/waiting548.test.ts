import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Nightshift items 548 + 549 + 547 (2026-11-10, his words: the hover "pop-up the entire thing just across the
 * entire screen … looks pretty ugly"; the buttons "should all be icons"; "an animation when you click send now").
 * Under Filament IV every waiting message is drawn as a message in the transcript (held rows and the scheduled
 * one too), its actions are icons with names, and Send now flies it into the turn. Classic keeps the rows.
 * Against a stubbed backend; the components are checked by their source (the suite runs in node).
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  takeBackInjected: vi.fn(async () => "cancelled"),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

const { drafts, enqueueMessage, readDraft } = await import("./drafts.svelte");
const { app, frontQueued, takeQueued } = await import("./state.svelte");
const pb = await import("./pendingBubble.svelte");
const motion = await import("./sendMotion");
const src = (p: string) => import(/* @vite-ignore */ `${p}?raw`).then((m) => m.default as string);
const midSrc = await src("./MidTurnBubble.svelte");
const composerSrc = await src("./Composer.svelte");
const schedSrc = await src("./ScheduledBubble.svelte");
const waitSrc = await src("./WaitingChat.svelte");
const actSrc = await src("./WaitAct.svelte");
const bubblesSrc = await src("./PendingBubbles.svelte");

const KEY = "chat-548";

beforeEach(() => {
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(pb.flying)) delete pb.flying[Number(k)];
  app.activeSessionId = KEY;
  app.toasts = [];
  app.busy = false;
  app.parked = null;
  motion.takeLaunch("chat");
  pb.takeMidLanding("", Number.MAX_SAFE_INTEGER);
});

/** A fake element at a place, with 10px/8px padding. */
function at(x: number, y: number, w = 300, h = 40): Element {
  return { getBoundingClientRect: () => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) } as unknown as Element;
}
(globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({ paddingLeft: "10px", paddingTop: "8px" });

describe("548: which waiting messages the transcript draws", () => {
  it("while a turn runs here: the rows not yet taken, in both layouts (465's rule)", () => {
    const a = enqueueMessage(KEY, "one", []);
    const b = enqueueMessage(KEY, "two", []);
    readDraft(KEY).queue[1]!.inject = { turn: "t", id: "i", after: "after a step" } as never;
    expect(pb.bubbledRows(readDraft(KEY).queue, true, true).map((q) => q.id)).toEqual([a.id]);
    expect(pb.bubbledRows(readDraft(KEY).queue, true, false).map((q) => q.id)).toEqual([a.id]);
    expect(b.id).not.toBe(a.id);
  });
  it("no turn running: Filament IV draws the held rows; Classic leaves them in the tray", () => {
    const a = enqueueMessage(KEY, "held after a stop", []);
    expect(pb.bubbledRows(readDraft(KEY).queue, false, true).map((q) => q.id)).toEqual([a.id]);
    expect(pb.bubbledRows(readDraft(KEY).queue, false, false)).toEqual([]);
  });
  it("a turn running in another chat: the rows stay in the tray (its head says where the turn is)", () => {
    enqueueMessage(KEY, "x", []);
    expect(pb.bubbledRows(readDraft(KEY).queue, false, true, true)).toEqual([]);
  });
  it("the composer leaves out exactly the rows the transcript draws (one place each)", () => {
    expect(composerSrc).toContain("bubbledRows(queue, app.busy && !app.parked, !classic(), app.busy && !!app.parked)");
    expect(bubblesSrc).toContain("bubbledRows(readDraft(key).queue, busyHere, !classic(), app.busy && !!app.parked)");
  });
  it("the state lines are short, the long ones stay as their tips", () => {
    expect(pb.pendingHead("turn-end")).toBe("queued · goes when this turn ends");
    expect(pb.pendingHead("next-step")).toBe("queued · goes at Claude's next step");
    expect(pb.pendingHead("now")).toContain("sending now");
    expect(pb.pendingHead("turn-end", false, "stopped")).toBe("queued · held — you stopped the turn");
    expect(pb.pendingHead("turn-end", false, "wrapped")).toContain("HANDOFF.md");
    expect(pb.pendingHead("turn-end", false, "idle")).toBe("queued · waiting to send");
    expect(pb.heldTip("stopped")).toContain("Send now");
    expect(midSrc).toContain("use:tip={held ? heldTip(held) : pendingLabel(st, arrive)}");
  });
  it("no waiting message's whole text is a hover tip under Filament IV", () => {
    const fil = composerSrc.slice(composerSrc.indexOf('<div class="queue-row fil"'), composerSrc.indexOf("{/if}\n      {/each}"));
    expect(fil.length).toBeGreaterThan(100);
    expect(fil).not.toContain("use:tip={q.text}");
    expect(fil).toContain('"more"');
    expect(schedSrc).not.toContain("use:tip={s.text}");
    expect(schedSrc).toContain("<FoldText");
    expect(waitSrc).toContain("<FoldText lines={10}");
    // The chip with the hover tip is Classic's only.
    expect(composerSrc).toContain('!onWaitingPage && classic()}\n    <ScheduledChip');
    expect(bubblesSrc).toContain("const sched = $derived(!classic() &&");
  });
  it("the wrap-up queued while away keeps its tag as a bubble", () => {
    expect(midSrc).toContain("wrap-up · queued while you were away");
    expect(midSrc).toContain("handoff.queuedId === row.id");
  });
});

describe("548: Send now on a held row goes once, through the composer's drain", () => {
  it("the registered send runs once per press, for that row; unregistering stops it", async () => {
    const a = enqueueMessage(KEY, "first", []);
    const b = enqueueMessage(KEY, "second", []);
    const sent: string[] = [];
    const off = pb.registerSendHeld(async (qid) => {
      if (!frontQueued(KEY, qid)) return;
      const q = takeQueued(KEY, false);
      if (q) sent.push(q.text);
    });
    expect(await pb.sendHeld(b.id)).toBe(true);
    expect(sent).toEqual(["second"]);
    // The other row is still waiting, unchanged; the sent one is gone (not sent twice).
    expect(readDraft(KEY).queue.map((q) => q.text)).toEqual(["first"]);
    await pb.sendHeld(b.id);
    expect(sent).toEqual(["second"]);
    off();
    expect(await pb.sendHeld(a.id)).toBe(false);
    expect(readDraft(KEY).queue.map((q) => q.text)).toEqual(["first"]);
    expect(app.toasts.length).toBe(1);
  });
  it("the composer's bridge fronts the row and drains explicitly", () => {
    expect(composerSrc).toContain("registerSendHeld(async (qid) => {\n            if (frontQueued(liveKey(), qid)) await drain(true);");
  });
});

describe("547: Send now flies the message from its waiting place", () => {
  it("the bubble's last place is handed on when it leaves, padded like the box's launch", () => {
    const r = enqueueMessage(KEY, "stop that and run the tests", []);
    pb.flying[r.id] = true;
    pb.trackFlight(r.id, r.text, at(500, 300));
    pb.trackFlight(r.id, r.text, at(500, 280));
    readDraft(KEY).queue.splice(0, 1);
    const seen: { x: number; y: number }[] = [];
    pb.flightLeft(r.id, false, (l) => {
      seen.push(l);
      motion.launchAt(l);
    });
    expect(seen).toEqual([expect.objectContaining({ channel: "chat", x: 510, y: 288, w: 280 })]);
    expect(pb.flying[r.id]).toBeUndefined();
    // The delivered bubble takes it once — not for another message, not twice.
    expect(pb.takeMidLanding("something else")).toBeNull();
    expect(pb.takeMidLanding("stop that   and run the tests")).toMatchObject({ x: 510, y: 288 });
    expect(pb.takeMidLanding("stop that and run the tests")).toBeNull();
  });
  it("a bubble that leaves while still queued (a chat switch) does not fly", () => {
    const r = enqueueMessage(KEY, "x", []);
    pb.flying[r.id] = true;
    pb.trackFlight(r.id, r.text, at(1, 2));
    let n = 0;
    pb.flightLeft(r.id, true, () => n++);
    expect(n).toBe(0);
    expect(pb.hasMidLanding()).toBe(false);
  });
  it("a landing goes stale after 1.5 s", () => {
    const r = enqueueMessage(KEY, "late", []);
    pb.flying[r.id] = true;
    pb.trackFlight(r.id, r.text, at(1, 2));
    pb.flightLeft(r.id, false, () => {});
    expect(pb.takeMidLanding("late", performance.now() + 2000)).toBeNull();
    expect(pb.hasMidLanding()).toBe(false);
  });
  it("Edit and Cancel ground the flight, and the words are never lost", async () => {
    const r = enqueueMessage(KEY, "keep these words", []);
    pb.flying[r.id] = true;
    expect(await pb.editPending(KEY, r.id)).toBe(true);
    expect(pb.flying[r.id]).toBeUndefined();
    expect(readDraft(KEY).text).toContain("keep these words");
    expect(readDraft(KEY).queue).toEqual([]);
    const c = enqueueMessage(KEY, "cancel me", []);
    pb.flying[c.id] = true;
    expect(await pb.cancelPending(KEY, c.id)).toBe(true);
    expect(pb.flying[c.id]).toBeUndefined();
    expect(readDraft(KEY).queue).toEqual([]);
  });
  it("reduced motion: no mark is set, and the landing does not fly", () => {
    expect(midSrc).toContain("if (row && filament && !reducedMotion()) flying[row.id] = true;");
    expect(midSrc).toContain("if (reducedMotion()) return;");
    expect(schedSrc).toContain('if (!reducedMotion()) launch("chat"');
  });
  it("a held row drained by the composer flies from its bubble (Filament IV only)", () => {
    expect(composerSrc).toContain('(classic() ? null : document.querySelector(`.midturn[data-queue-id="${q.id}"] .user-bubble`))');
  });
});

describe("549: every action is an icon with a name, a tip and the keyboard", () => {
  it("WaitAct is a button with an aria-label and a tip", () => {
    expect(actSrc).toContain('type="button"');
    expect(actSrc).toContain("aria-label={label}");
    expect(actSrc).toContain("use:tip={hint ? `${label} — ${hint}` : label}");
    expect(actSrc).toContain("<Icon name={icon}");
  });
  it("each action of the Filament bubble is a WaitAct, bound to its own call", () => {
    const fil = midSrc.slice(midSrc.indexOf("{#if filament}"), midSrc.indexOf("{:else}\n<div"));
    for (const [mt, call] of [
      ["send-held", "sendHeld(row!.id)"],
      ["send-reply", "sendAsReply(chatKey, row!.id)"],
      ["send-now", "sendNow(chatKey, row!.id)"],
      ["arrive", "letArrive[row!.id] = true"],
      ["edit", "editPending(chatKey, row!.id)"],
      ["cancel", "confirming = true"],
    ]) {
      const i = fil.indexOf(`data-mt="${mt}"`);
      expect(i, mt).toBeGreaterThan(0);
      const tag = fil.slice(fil.lastIndexOf("<WaitAct", i), fil.indexOf("/>", i));
      expect(tag, mt).toContain(call);
      expect(tag, mt).toMatch(/label="[A-Z]/);
    }
    expect(fil).not.toMatch(/>Send now<\/button|>Edit<\/button|>Cancel<\/button/);
  });
  it("Classic keeps the word buttons", () => {
    const old = midSrc.slice(midSrc.indexOf("{:else}\n<div"));
    expect(old).toContain(">Send now</button");
    expect(old).toContain(">Edit</button>");
    expect(waitSrc).toContain(">Cancel</button");
  });
  it("the scheduled bubble and the waiting page offer the card's actions as icons", () => {
    for (const s of [schedSrc, waitSrc]) {
      expect(s).toMatch(/icon="send"[^>]*label="Send now"[^>]*disabled=\{!!s\.claimed\}/);
      expect(s).toMatch(/icon="pencil"[^>]*label="Edit"/);
      expect(s).toMatch(/icon="x"[^>]*label="Cancel"/);
      expect(s).toMatch(/icon="check"[^>]*label="Keep"/);
    }
  });
});
