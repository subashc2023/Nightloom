// Item 454: the pieces that made a tab switch slow, pinned.
import { describe, expect, it, vi } from "vitest";
// DOMPurify needs a DOM this environment lacks (see markdown.test.ts); the
// cache, not the sanitiser, is under test, so it passes the HTML through.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
import { REPLY_CACHE_CHARS, renderReply, replyCacheStats } from "./markdown";
import { versionStarts, versionsAt, type ForkInfo } from "./versions";
import type { SessionMeta } from "./types";

describe("renderReply's cache (item 454)", () => {
  it("gives the same HTML for the same text, from the cache the second time", () => {
    const src = "Gradient step $x_{t+1} = x_t - \\eta g$ and\n\n$$\\sum_i a_i$$\n\n**bold** `code`";
    const before = replyCacheStats().entries;
    const first = renderReply(src);
    expect(replyCacheStats().entries).toBe(before + 1);
    const second = renderReply(src);
    expect(second).toBe(first);
    expect(replyCacheStats().entries).toBe(before + 1);
    expect(first).toContain("katex");
  });

  it("does not keep a reply larger than a quarter of the cap", () => {
    const before = replyCacheStats().entries;
    renderReply("a".repeat(REPLY_CACHE_CHARS / 4 + 10));
    expect(replyCacheStats().entries).toBe(before);
  });

  it("stays under its cap however many replies go through", () => {
    const big = "word ".repeat(200_000); // ~1 MB of source per reply
    for (let i = 0; i < 15; i++) renderReply(`${i} ${big}`);
    expect(replyCacheStats().chars).toBeLessThanOrEqual(REPLY_CACHE_CHARS);
  });
});

describe("versionStarts (item 454)", () => {
  const at = (m: number) => `2026-10-04T00:${String(m).padStart(2, "0")}:00Z`;
  const meta = (id: string, parent?: string, index = 3): SessionMeta =>
    ({
      id,
      path: `/x/${id}.jsonl`,
      modified: at(0),
      user_turns: 2,
      first_user: id,
      title: null,
      ...(parent ? { forked_from: { session: parent, index } } : {}),
    }) as SessionMeta;
  const list = [meta("k", "f", 3), meta("g", "o", 3), meta("f", "o", 3), meta("o"), meta("other", "o", 7), meta("x")];
  const info = new Map<string, ForkInfo>([
    ["f", { cut: 3, created: at(10) }],
    ["g", { cut: 3, created: at(20) }],
    ["k", { cut: 4, created: at(30) }],
    ["other", { cut: 5, created: at(40) }],
  ]);

  it("holds exactly the messages versionsAt finds versions for", () => {
    const starts = versionStarts(list, info);
    for (const s of ["k", "g", "f", "o", "other", "x"])
      for (let i = 0; i < 10; i++)
        if (!starts.has(`${s}\u0000${i}`)) expect(versionsAt(list, info, s, i)).toBeNull();
    expect(starts.has("o\u00003")).toBe(true);
    expect(versionsAt(list, info, "o", 3)).not.toBeNull();
  });
});
