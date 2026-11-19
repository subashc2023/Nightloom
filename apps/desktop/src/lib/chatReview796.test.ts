// Item 796: "Review this chat" on the hand-off card — digest (no model), one aside, a saved page.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetReviews, reviewLabel, reviewLine, reviewOf, runReview, type ReviewDeps, type ReviewTarget } from "./chatReview.svelte";
import type { AsideResult } from "./types";
import buttonSrc from "./handoffButton.ts?raw";
import transcriptSrcRaw from "./Transcript.svelte?raw";
import classicSrcRaw from "./TranscriptClassic.svelte?raw";
import mainSrc from "../../src-tauri/src/main.rs?raw";
import transcriptLogicRaw from "./transcript/logic.svelte.ts?raw";
import { asOneFile } from "../test/oneFile";
const transcriptSrc = asOneFile(transcriptSrcRaw, transcriptLogicRaw);
const classicSrc = asOneFile(classicSrcRaw, transcriptLogicRaw);

const target = (over: Partial<ReviewTarget> = {}): ReviewTarget => ({
  chat: "c796",
  index: 12,
  agentSession: "sess-796",
  title: "The chat",
  thread: null,
  ...over,
});

const digest = { markdown: "DIGEST", prompt: "PROMPT\n\nDIGEST", issues: 3, corrections: 2, misses: 1, miss_cost_usd: 0.25 };
const answer = (over: Partial<AsideResult> = {}): AsideResult =>
  ({ answer: "## Issue timeline\n- x", cost_usd: 0.14, cache_read: 330_000, is_error: false, notices: [], ...over }) as AsideResult;

function deps(over: Partial<ReviewDeps> = {}): ReviewDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    digest: vi.fn(async (s: string) => {
      calls.push(`digest ${s}`);
      return digest;
    }),
    ask: vi.fn(async (text: string, seq: number) => {
      calls.push(`ask ${seq >= 2 ** 40 ? "high-seq" : "card-seq"} ${text.startsWith("PROMPT") ? "prompt" : text}`);
      return answer();
    }),
    save: vi.fn(async (chat: string, _t: string, thread: string | null, review: string, cost: number | null, dg: string) => {
      calls.push(`save ${chat} ${thread} ${review.split("\n")[0]} ${cost} ${dg}`);
      return `/p/.agents/threads/t/retrospectives/2026-11-18-${chat}.md`;
    }),
    openChat: () => "c796",
    ...over,
  };
}

beforeEach(() => {
  resetReviews();
  (globalThis as { localStorage?: { clear?: () => void } }).localStorage?.clear?.();
});

describe("796: one press runs digest, aside, save — in that order", () => {
  it("sends the digest's prompt as an aside no card draws, then saves the answer above the digest", async () => {
    const d = deps();
    const s = await runReview(target({ thread: "t" }), d);
    expect(d.calls).toEqual([
      "digest sess-796",
      "ask high-seq prompt",
      "save c796 t ## Issue timeline 0.14 DIGEST",
    ]);
    expect(s.phase).toBe("saved");
    expect(reviewOf("c796", 12).path).toMatch(/retrospectives\/2026-11-18-c796\.md$/);
  });

  it("keeps the saved path per card, so a relaunch shows Open the review", async () => {
    await runReview(target(), deps());
    resetReviews(); // memory gone, as after a relaunch
    expect(reviewOf("c796", 12)).toEqual({ phase: "saved", path: "/p/.agents/threads/t/retrospectives/2026-11-18-c796.md" });
    expect(reviewOf("c796", 14).phase).toBe("idle");
    expect(reviewLabel(reviewOf("c796", 12))).toBe("Open the review");
  });

  it("does not fork a chat he switched away from", async () => {
    const d = deps({ openChat: () => "other" });
    const s = await runReview(target(), d);
    expect(s.phase).toBe("error");
    expect(s.error).toMatch(/switched chats/);
    expect(d.calls).toEqual(["digest sess-796"]);
  });

  it("a failed aside, an empty answer or a failed save is the card's state, never a throw, and saves nothing", async () => {
    let d = deps({ ask: async () => answer({ is_error: true, answer: "", notices: ["usage limit"] }) });
    let s = await runReview(target(), d);
    expect(s.phase).toBe("error");
    expect(reviewLine(s)).toContain("usage limit");
    expect(d.save).not.toHaveBeenCalled();
    resetReviews();
    d = deps({ ask: async () => answer({ answer: "  " }) });
    expect((await runReview(target(), d)).phase).toBe("error");
    resetReviews();
    d = deps({ save: async () => Promise.reject(new Error("open a project first")) });
    s = await runReview(target(), d);
    expect(s.phase).toBe("error");
    expect(s.error).toContain("open a project first");
    expect(reviewOf("c796", 12).phase).toBe("error");
  });

  it("a second press while one runs starts nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({
      digest: async () => {
        await gate;
        return digest;
      },
    });
    const first = runReview(target(), d);
    const again = await runReview(target(), d);
    expect(again.phase).toBe("digest");
    release();
    await first;
    expect(d.ask).toHaveBeenCalledTimes(1);
  });
});

describe("796: the card's words", () => {
  it("label and line follow the phase", () => {
    expect(reviewLabel({ phase: "idle" })).toBe("Review this chat");
    expect(reviewLabel({ phase: "digest" })).toBe("Reading the transcript…");
    expect(reviewLabel({ phase: "review" })).toBe("Reviewing…");
    expect(reviewLine({ phase: "idle" })).toBe("");
    expect(reviewLine({ phase: "review", issues: 3, corrections: 2 })).toContain("3 tool issues, 2 corrections");
    expect(reviewLine({ phase: "saved", path: "/x/y/2026-11-18-c.md", cost: 0.14 })).toBe("Review saved: 2026-11-18-c.md, $0.14.");
  });
});

describe("796: wiring", () => {
  it("both transcripts give the card the hook, only with a Claude Code session", () => {
    for (const s of [transcriptSrc, classicSrc]) {
      expect(s).toContain("review: cliSession");
      expect(s).toContain("runReview(");
      expect(s).toContain("openChat: () => app.activeSessionId");
      expect(s).toContain("openPathAsTab(path, from)");
    }
  });
  it("the button sits in the card's row, which liveHtml leaves alone", () => {
    expect(buttonSrc).toContain("syncReview(row, next, read);");
    expect(buttonSrc).toMatch(/go\.before\(btn\)/);
  });
  it("the two commands are registered", () => {
    expect(mainSrc).toContain("commands::retro::retro_digest,");
    expect(mainSrc).toContain("commands::retro::retro_save,");
  });
});
