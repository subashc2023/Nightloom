// Item 705 (option A, Console — his pick, blocker 2167): the hand-off card's
// three sizes, the one grip, the stepper, the themed selects and the next
// chat's model. The suite runs in node (no DOM): pure parts are run, the
// card's wiring is read from source, and what needs a page is shot in WebKit
// (nightshift-code notes/runner-design/705-build-report-2026-11-19.md).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_STEP_PX, cardSize, dragCard, fold, isFolded, noteStay, setCardSize, steppedMark, typedMark, unfold } from "./handoffFold.svelte";
import { nextModel, nextModelLabel, nextModelMenu, nextModelRows, setNextModel } from "./nextChatModel.svelte";
import { resetViewState, viewGet } from "./viewState";
import { clearMessage, hasOwnMessage, message, setMessage } from "./handoff.svelte";
import composerSrc from "./Composer.svelte?raw";
import pickerSrc from "./ThreadPicker.svelte?raw";
import buttonSrc from "./handoffButton.ts?raw";
import stateSrc from "./state.svelte.ts?raw";
import transcriptSrc from "./Transcript.svelte?raw";
import classicSrc from "./TranscriptClassic.svelte?raw";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  continueSession: vi.fn(async () => ({ session: "chat-705-next", events: [], forked: true })),
  listSessions: vi.fn(async () => []),
}));

/** A storage that outlives `resetViewState`, as localStorage outlives a relaunch. */
function disk(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe("705: the grip sizes the card first, then the box", () => {
  it("down: a step per CARD_STEP_PX to compact, then mini; the rest goes to the box", () => {
    expect(dragCard("full", 10)).toEqual({ size: "full", rest: 0 });
    expect(dragCard("full", CARD_STEP_PX)).toEqual({ size: "compact", rest: 0 });
    expect(dragCard("full", 2 * CARD_STEP_PX)).toEqual({ size: "mini", rest: 0 });
    expect(dragCard("full", 2 * CARD_STEP_PX + 30)).toEqual({ size: "mini", rest: 30 });
    expect(dragCard("mini", 25)).toEqual({ size: "mini", rest: 25 });
  });
  it("up: the card grows back first, then the box grows", () => {
    expect(dragCard("mini", -CARD_STEP_PX)).toEqual({ size: "compact", rest: 0 });
    expect(dragCard("mini", -2 * CARD_STEP_PX - 12)).toEqual({ size: "full", rest: -12 });
    expect(dragCard("full", -40)).toEqual({ size: "full", rest: -40 });
  });
  it("is wired to the composer's one handle, and the box moves only with what is left", () => {
    expect(composerSrc).toMatch(/const r = dragCard\(start, startH - h\)/);
    expect(composerSrc).toMatch(/if \(r\.rest !== 0 \|\| boxMoved\)/);
    expect(composerSrc).toContain("class:hc-grip={handoffCardUp}");
  });
});

describe("705: the card's size survives a chat switch and a relaunch", () => {
  beforeEach(() => resetViewState(null));
  it("keeps compact and mini per chat, on disk", () => {
    const store = disk();
    resetViewState(store);
    setCardSize("c705", "due", "compact");
    fold("c705b", "due");
    expect(cardSize("c705", "due")).toBe("compact");
    expect(cardSize("other", "due")).toBe("full");
    resetViewState(store); // the relaunch: memory gone, the disk read again
    expect(cardSize("c705", "due")).toBe("compact");
    expect(isFolded("c705b", "due")).toBe(true);
  });
  it("Expand, the ▾ and Stay here open it in full again", () => {
    fold("c705c", "due");
    unfold("c705c");
    expect(cardSize("c705c", "due")).toBe("full");
    setCardSize("c705c", "due", "compact");
    setCardSize("c705c", "due", "full");
    expect(viewGet("handoff.card:c705c", "")).toBe("");
    setCardSize("c705c", "due", "mini");
    noteStay("c705c");
    expect(cardSize("c705c", "due")).toBe("full");
  });
});

describe("705: a half-typed wrap-up message is never dropped", () => {
  it("survives minimize, compact, Stay here and a size change; only Reset drops it", () => {
    setMessage("c705m", "my half-typed wrap-");
    setCardSize("c705m", "due", "compact");
    fold("c705m", "due");
    noteStay("c705m");
    unfold("c705m");
    expect(message("c705m")).toBe("my half-typed wrap-");
    expect(hasOwnMessage("c705m")).toBe(true);
    clearMessage("c705m");
    expect(hasOwnMessage("c705m")).toBe(false);
  });
  it("the card writes each keystroke through, and compact keeps the text box (two lines), never removes it", () => {
    expect(composerSrc).toMatch(/oninput=\{\(e\) => \{\s*noteActivity\(\);\s*setMessage\(app\.activeSessionId/);
    expect(composerSrc).toContain("rows={full ? 4 : 2}");
    expect(composerSrc).toContain("class:hc-clip={!full}");
  });
});

describe("705: every control of today's card is on option A", () => {
  const card = composerSrc.slice(composerSrc.indexOf('{#if handoffCardUp && handoffSize === "mini"}'), composerSrc.indexOf('{:else if handoffHere && handoff.stage === "wrapping"}'));
  it("draws the three states", () => {
    expect(card).toContain('class="handoff handoff-min handoff-min-open hc hc-mini"');
    expect(card).toContain('class="handoff hc" class:hc-compact={!full}');
  });
  it.each([
    ["Wrap up now", "onclick={() => void sendWrapUpNow()}>Wrap up now"],
    ["Stay here", "noteStay(app.activeSessionId); stayHere();"],
    ["Minimize", 'aria-label="Minimize"'],
    ["Restore (▴ and a click on the line)", "unfold(app.activeSessionId)"],
    ["Reset the message", "onclick={() => clearMessage(app.activeSessionId)}>Reset the message"],
    ["the stepper's −", "stepMark(-1)"],
    ["the stepper's +", "stepMark(1)"],
    ["the typed mark", "onchange={(e) => typeMark("],
    ["the themed thread pick", "<ThreadPicker menu />"],
    ["the next chat's model", "onpick={(id) => setNextModel(app.activeSessionId, id)}"],
    ["the goal (full)", "<HandoffGoal chat={app.activeSessionId} />"],
  ])("%s", (_name, needle) => {
    expect(card).toContain(needle);
  });
  it("the stepper steps by 5 to the nearest 5, within 1–100", () => {
    expect(steppedMark(72, 1)).toBe(75);
    expect(steppedMark(72, -1)).toBe(70);
    expect(steppedMark(75, 1)).toBe(80);
    expect(steppedMark(75, -1)).toBe(70);
    expect(steppedMark(98, 1)).toBe(100);
    expect(steppedMark(100, 1)).toBe(100);
    expect(steppedMark(5, -1)).toBe(1);
    expect(steppedMark(1, -1)).toBe(1);
    expect(steppedMark(1, 1)).toBe(5);
    expect(composerSrc).toContain("setChatThreshold(String(steppedMark(handoffThresholdPct, dir)))");
  });
  it("a typed mark: clamped and rounded; an emptied box or no number changes nothing (review)", () => {
    expect(typedMark("")).toBeNull();
    expect(typedMark("  ")).toBeNull();
    expect(typedMark("abc")).toBeNull();
    expect(typedMark("0")).toBe(1);
    expect(typedMark("150")).toBe(100);
    expect(typedMark("72.6")).toBe(73);
    expect(typedMark("40")).toBe(40);
    // The box shows the mark as kept after a clamp or a refusal.
    expect(composerSrc).toContain("onchange={(e) => typeMark(e.currentTarget as HTMLInputElement)}");
    expect(composerSrc).toMatch(/setChatThreshold\(input\.value\);\s*input\.value = String\(handoffThresholdPct\);/);
  });
  it("the thread pick is the themed button and the shared menu, not the native select", () => {
    expect(pickerSrc).toMatch(/\{:else if menu\}\s*<HudSelect/);
  });
});

describe("705: the next chat's model", () => {
  beforeEach(() => {
    resetViewState(null);
    nextModelMenu.chatName = "Opus 5.5";
    nextModelMenu.families = [
      { key: "opus", pick: "claude-opus-5-5", label: "Opus 5.5", detail: "" },
      { key: "fable", pick: "claude-fable-5-2", label: "Fable 5.2", detail: "" },
    ];
  });
  it("defaults to this chat's model, and a pick is kept per chat on disk", () => {
    const store = disk();
    resetViewState(store);
    expect(nextModel("w1")).toBe("");
    expect(nextModelLabel("w1")).toEqual({ name: "Opus 5.5", isDefault: true });
    expect(nextModelRows("w1")[0]).toMatchObject({ id: "", label: "this chat's", on: true });
    setNextModel("w1", "claude-fable-5-2");
    resetViewState(store);
    expect(nextModel("w1")).toBe("claude-fable-5-2");
    expect(nextModelLabel("w1")).toEqual({ name: "Fable 5.2", isDefault: false });
    expect(nextModelRows("w1").find((r) => r.on)?.id).toBe("claude-fable-5-2");
    expect(nextModel("w2")).toBe("");
  });
  it("both cards read the same value: the hand-off card and the reply's next-chat card", () => {
    for (const s of [transcriptSrc, classicSrc]) {
      expect(s).toContain("rows: nextModelRows(from), pick: (id: string) => setNextModel(from, id)");
    }
    expect(buttonSrc).toMatch(/function syncModel\(/);
    expect(buttonSrc).toContain("read()?.model?.pick(r.id)");
  });
  it("Continue opens the new chat on the pick (both routes share openContinuation)", async () => {
    expect(stateSrc).toMatch(/const pick = nextModel\(from\);[\s\S]{0,200}await switchModel\(pick\)/);
    const { app, continueChat } = await import("./state.svelte");
    const { handoff, resetHandoff } = await import("./handoff.svelte");
    resetHandoff();
    app.activeSessionId = "w705";
    handoff.chat = "w705";
    app.busy = false;
    app.draft.engine = "claude-code";
    app.draft.agentModel = "claude-opus-5-5";
    setNextModel("w705", "claude-fable-5-2");
    await continueChat();
    expect(app.activeSessionId).toBe("chat-705-next");
    expect(app.draft.agentModel).toBe("claude-fable-5-2");
  });
  it("item 857 kept: Continue never waits on a running review", () => {
    expect(buttonSrc).toContain("the review keeps running and saves its page");
    expect(buttonSrc).toMatch(/b\.disabled = next\.used \|\| next\.blocked !== null;/);
  });
});
