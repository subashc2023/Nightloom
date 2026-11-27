// Item 857 (his report, 2026-11-18): Review "kind of stuck", then Continue did
// nothing and "both of the buttons are blocked out". Continue goes while a
// review runs; the review keeps going and saves, or he cancels it; each step
// has a time limit that ends in a line on the card.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import {
  BESIDE_LINE,
  CANCELLED_LINE,
  REVIEW_TIMEOUT_MS,
  cancelReview,
  resetReviews,
  reviewBusy,
  reviewCancellable,
  reviewLine,
  reviewOf,
  runReview,
  type ReviewOptions,
  type ReviewTarget,
} from "./chatReview.svelte";
import { resetHandoff, withHistory } from "./handoff.svelte";
import { app, continueWithPrompt, historyFrom } from "./state.svelte";
import type { AsideResult } from "./types";
import buttonSrc from "./handoffButton.ts?raw";
import transcriptSrcRaw from "./Transcript.svelte?raw";
import classicSrcRaw from "./TranscriptClassic.svelte?raw";
import editsSrc from "../../src-tauri/src/commands/edits.rs?raw";
import transcriptLogicRaw from "./transcript/logic.svelte.ts?raw";
import { asOneFile } from "../test/oneFile";
const transcriptSrc = asOneFile(transcriptSrcRaw, transcriptLogicRaw);
const classicSrc = asOneFile(classicSrcRaw, transcriptLogicRaw);

const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const cssSrc = fs.readFileSync(new URL("../app.css", import.meta.url), "utf8");

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  continueSession: vi.fn(async () => ({ session: "chat-next", events: [], forked: true })),
  listSessions: vi.fn(async () => []),
  send: vi.fn(async () => ({})),
  threadUpkeep: vi.fn(async () => ({ flags: [], struck_moved: 0, merged: [] })),
}));
vi.mock("./threadHandoff.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./threadHandoff.svelte")>()),
  takeThreadHandoff: vi.fn(async () => null),
}));

const target = (over: Partial<ReviewTarget> = {}): ReviewTarget => ({
  chat: "chat-a",
  index: 7,
  agentSession: "sess-857",
  title: "ICS 51 midterm",
  thread: "midterm",
  ...over,
});
const digest = { markdown: "DIGEST", prompt: "PROMPT", issues: 2, corrections: 1, misses: 0, miss_cost_usd: 0 };
const answer = { answer: "## Issue timeline\n- x", cost_usd: 0.2, cache_read: 1, is_error: false, notices: [] } as unknown as AsideResult;

/** An aside that answers only when released, as his 34 s one did. */
function gatedDeps(over: Partial<ReviewOptions> = {}) {
  let release!: (a: AsideResult) => void;
  let fail!: (e: unknown) => void;
  const asked = new Promise<AsideResult>((res, rej) => {
    release = res;
    fail = rej;
  });
  const deps = {
    digest: vi.fn(async () => digest),
    ask: vi.fn((_t: string, _n: number) => asked),
    save: vi.fn(async (chat: string) => `/p/threads/midterm/retrospectives/2026-11-18-${chat}.md`),
    openChat: vi.fn(() => app.activeSessionId),
    cancel: vi.fn(async (n: number) => {
      fail(`the aside was cancelled (${n})`);
    }),
    notify: vi.fn(),
    ...over,
  } satisfies Partial<ReviewOptions>;
  return { deps, release };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetReviews();
  resetHandoff();
  vi.mocked(api.continueSession).mockClear();
  vi.mocked(api.send).mockReset();
  vi.mocked(api.send).mockResolvedValue({} as never);
  app.busy = false;
  app.error = null;
  app.connection = { engine: "anthropic", model: "m" } as unknown as typeof app.connection;
  app.activeSessionId = "chat-a";
});

describe("857: Continue during a review", () => {
  it("continues at once while the review pass runs; the review keeps going, saves, and says where in a toast", async () => {
    const { deps, release } = gatedDeps();
    const review = runReview(target(), deps);
    await tick();
    expect(reviewOf("chat-a", 7).phase).toBe("review");
    // His click: nothing about the review holds it.
    await continueWithPrompt("chat-a", 7, "Pick up the thread.");
    expect(api.continueSession).toHaveBeenCalledTimes(1);
    expect(app.activeSessionId).toBe("chat-next");
    // Item 1025: the history pointer goes under the prompt.
    expect(vi.mocked(api.send).mock.calls[0][0]).toBe(withHistory("Pick up the thread.", historyFrom("chat-a")));
    expect(reviewBusy(reviewOf("chat-a", 7))).toBe(true);
    // The aside answers after the switch: the page still saves, under the old chat's card.
    release(answer);
    const s = await review;
    expect(s.phase).toBe("saved");
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(reviewOf("chat-a", 7).path).toMatch(/2026-11-18-chat-a\.md$/);
    expect(deps.notify).toHaveBeenCalledWith("The review of “ICS 51 midterm” is saved: 2026-11-18-chat-a.md");
  });

  it("no toast when he is still on the chat: the card shows it", async () => {
    const { deps, release } = gatedDeps();
    const review = runReview(target(), deps);
    await tick();
    release(answer);
    await review;
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("Cancel stops the aside, shows its line, saves nothing, and frees the button", async () => {
    const { deps } = gatedDeps();
    const review = runReview(target(), deps);
    await tick();
    expect(reviewCancellable(reviewOf("chat-a", 7))).toBe(true);
    expect(cancelReview("chat-a", 7)).toBe(true);
    const s = await review;
    expect(s.phase).toBe("error");
    expect(reviewLine(s)).toBe(CANCELLED_LINE);
    expect(deps.cancel).toHaveBeenCalledWith(expect.any(Number));
    expect(deps.save).not.toHaveBeenCalled();
    expect(reviewBusy(reviewOf("chat-a", 7))).toBe(false);
    expect(cancelReview("chat-a", 7)).toBe(false);
  });

  it("Cancel during the digest stops before any aside is asked", async () => {
    let read!: (d: typeof digest) => void;
    const { deps } = gatedDeps({ digest: vi.fn(() => new Promise<typeof digest>((r) => (read = r))) });
    const review = runReview(target(), deps);
    expect(reviewOf("chat-a", 7).phase).toBe("digest");
    cancelReview("chat-a", 7);
    expect((await review).error).toBe(CANCELLED_LINE);
    read(digest);
    await tick();
    expect(deps.ask).not.toHaveBeenCalled();
    expect(reviewOf("chat-a", 7).phase).toBe("error");
  });

  it("a review pass past its limit is stopped with a visible reason", async () => {
    const { deps } = gatedDeps({ reviewTimeoutMs: 20 });
    const s = await runReview(target(), deps);
    expect(s.phase).toBe("error");
    expect(s.error).toMatch(/ran past .* and was stopped/);
    expect(deps.cancel).toHaveBeenCalledTimes(1);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("a digest past its limit is stopped too", async () => {
    const { deps } = gatedDeps({ digest: vi.fn(() => new Promise<typeof digest>(() => {})), digestTimeoutMs: 20 });
    const s = await runReview(target(), deps);
    expect(s.error).toMatch(/took over .* to read and was stopped/);
    expect(deps.ask).not.toHaveBeenCalled();
  });

  it("the limit is generous against his measured asides (longest 51 s)", () => {
    expect(REVIEW_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 51_000);
  });

  it("the card says Continue won't wait, while the review can still be cancelled", () => {
    expect(reviewLine({ phase: "digest" })).toBe(BESIDE_LINE);
    expect(reviewLine({ phase: "review", issues: 2, corrections: 1 })).toContain(BESIDE_LINE);
    expect(reviewLine({ phase: "saving", issues: 2, corrections: 1 })).not.toContain("Cancel");
    expect(reviewCancellable({ phase: "saving" })).toBe(false);
  });
});

describe("857: wiring", () => {
  it("the card's Continue re-arms after a click that did not continue, and Cancel sits beside a running review", () => {
    expect(buttonSrc).toContain("Promise.resolve(now.onContinue()).finally(");
    expect(buttonSrc).toContain("REVIEW_CANCEL_CLASS");
    expect(buttonSrc).toContain("read()?.review?.cancel();");
    expect(cssSrc).toContain(".markdown .handoff-go .handoff-review-cancel[hidden]");
  });
  it("both transcripts hand the click's work back, and wire Cancel and the toast", () => {
    for (const s of [transcriptSrc, classicSrc]) {
      expect(s).toContain("return continueWithPrompt(from, reply.index");
      expect(s).toContain("cancel: () => void cancelReview(from, reply.index)");
      expect(s).toContain("notify: (m) => addToast(m)");
    }
  });
  it("continue_session does not wait on an aside's hold of the agent", () => {
    expect(editsSrc).toContain("agents::Found::Ready(slot) if !state.aside_cancel.is_empty()");
    expect(editsSrc).toContain("lock.await.set_resume(None);");
  });
});
