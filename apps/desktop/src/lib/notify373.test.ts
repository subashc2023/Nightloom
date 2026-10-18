import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "./types";

// Nightshift backlog 373: he raised a question card, switched to another
// app, and no banner came. The banner was decided once, when the card
// landed — the window was in front then, so nothing posted, ever. Now a
// card the focused window receives is held, and posts when he leaves while
// it still waits.

const notify = vi.fn(async (_t: string, _b: string) => {});
vi.mock("./api", () => ({ notify: (t: string, b: string) => notify(t, b) }));

const on = { turnEnd: true, needsYou: true, usageRefresh: true };
const question = (id: string): ApprovalRequest =>
  ({ id, name: "AskUserQuestion", input: { questions: [] }, effect: "read" }) as unknown as ApprovalRequest;

let focused = true;

beforeEach(() => {
  vi.resetModules();
  notify.mockClear();
  focused = true;
  vi.stubGlobal("document", { hasFocus: () => focused, visibilityState: "visible" });
});
afterEach(() => vi.unstubAllGlobals());

describe("the held needs-you banner (backlog 373)", () => {
  it("a card that lands while he looks posts nothing then, and posts when he leaves with it waiting", async () => {
    const { notifyNeedsYou, postHeldNeedsYou } = await import("./notify");
    await notifyNeedsYou("Plans", question("q1"), on);
    expect(notify).not.toHaveBeenCalled();
    focused = false;
    await postHeldNeedsYou(() => true, on);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("Plans");
  });

  it("a card he answered before leaving posts nothing", async () => {
    const { notifyNeedsYou, postHeldNeedsYou } = await import("./notify");
    await notifyNeedsYou("Plans", question("q1"), on);
    await postHeldNeedsYou(() => false, on);
    expect(notify).not.toHaveBeenCalled();
  });

  it("each held card posts once — a second departure does not repeat it", async () => {
    const { notifyNeedsYou, postHeldNeedsYou } = await import("./notify");
    await notifyNeedsYou("Plans", question("q1"), on);
    await postHeldNeedsYou(() => true, on);
    await postHeldNeedsYou(() => true, on);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a card that lands while he is away posts at once, and is not held", async () => {
    const { notifyNeedsYou, postHeldNeedsYou } = await import("./notify");
    focused = false;
    await notifyNeedsYou("Plans", question("q1"), on);
    expect(notify).toHaveBeenCalledTimes(1);
    await postHeldNeedsYou(() => true, on);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("the switch off holds nothing and posts nothing", async () => {
    const { notifyNeedsYou, postHeldNeedsYou } = await import("./notify");
    const off = { ...on, needsYou: false };
    await notifyNeedsYou("Plans", question("q1"), off);
    await postHeldNeedsYou(() => true, on);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("onAway (backlog 373)", () => {
  it("fires when he leaves, not again while away, and again after he returns and leaves", async () => {
    const { onAway, setWindowFocused } = await import("./away.svelte");
    const left = vi.fn();
    onAway(left);
    setWindowFocused(false);
    setWindowFocused(false);
    expect(left).toHaveBeenCalledTimes(1);
    setWindowFocused(true);
    setWindowFocused(false);
    expect(left).toHaveBeenCalledTimes(2);
  });
});

describe("the wiring (backlog 373)", () => {
  it("the state posts held banners on leaving, asking whether each call still waits", async () => {
    const src = (await import("./state.svelte.ts?raw")).default as string;
    expect(src).toContain("onAway(() => void postHeldNeedsYou(approvalWaits))");
    expect(src).toMatch(/function approvalWaits[\s\S]*pendingApprovals[\s\S]*app\.background/);
  });
});
