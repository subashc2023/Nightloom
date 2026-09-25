/**
 * Per-message token sizes (nightshift backlog 090, 2026-09-16): what each
 * turn added to the context, read from the numbers the recorder already
 * keeps — no tokenizer, no extra request.
 *
 * The log records one `usage` per assistant message, and its `input_tokens`
 * is the **whole** prompt, cached or not (both engines normalise Anthropic's
 * exclusive count into that; see `RawUsage::normalize` in the service and
 * `Usage` in `types.ts`). So the context after reply j is
 * `in_j + out_j` — the same figure the top-bar gauge reads — and the growth
 * from one reply to the next, `in_j − (in_{j−1} + out_{j−1})`, is exactly
 * what arrived between them: a user message with its attachments when one
 * did, or the tool results of a round when none did. A reply's own size is
 * its output. Tool results are one bucket per round and are charged to the
 * reply that made the calls, since that is the message that brought them
 * in.
 *
 * The first reply's input holds the system prompt and the first message
 * together; the log does not separate them, so the first user turn's figure
 * is flagged `preamble` and its title says so. The sizes telescope: the sum
 * of every turn's figure is the last reply's `in + out`, which is what the
 * gauge shows — the reconciliation the item asks for, pinned in the test.
 *
 * Nothing is guessed: a superseded turn (rewound out of the context) shows
 * nothing, a growth that comes out negative (a compaction or an edit shrank
 * the context between two replies) shows nothing, and a reply whose usage
 * was not recorded shows nothing and breaks the chain for the turn after it.
 */
import type { SessionEvent, Usage } from "./types";

export interface TurnSize {
  /** Tokens this turn added to the context. */
  tokens: number;
  /** A reply's own output, when this is a reply. */
  out?: number;
  /** What the reply's tool calls brought back, when any round followed it. */
  results?: number;
  /** The first user turn: the figure holds the system prompt too. */
  preamble?: boolean;
}

/** Recorded, as opposed to the zeros an old log or a failed turn carries. */
function recorded(u: Usage | undefined): u is Usage {
  return !!u && (u.input_tokens > 0 || u.output_tokens > 0);
}

/**
 * One entry per event, null where nothing can be said. `live` is
 * `liveFlags(events)`: a rewound turn is not in the context and gets no
 * figure, and the chain runs over the live replies only.
 */
export function turnSizes(events: readonly SessionEvent[], live: readonly boolean[]): (TurnSize | null)[] {
  const sizes: (TurnSize | null)[] = events.map(() => null);
  // The last live reply, and whether its usage was recorded — the context
  // it left behind is what the next growth is measured from.
  let prev: { i: number; ctx: number | null } | null = null;
  let pendingUser: number | null = null;
  let pendingResults = false;
  events.forEach((e, i) => {
    if (!live[i]) return;
    if (e.event === "user_message") {
      pendingUser = i;
      return;
    }
    if (e.event === "tool_result") {
      pendingResults = true;
      return;
    }
    if (e.event !== "assistant_message") return;
    const u = e.usage;
    if (!recorded(u)) {
      prev = { i, ctx: null };
      pendingUser = null;
      pendingResults = false;
      return;
    }
    const before = prev === null ? 0 : prev.ctx;
    const growth = before === null ? null : u.input_tokens - before;
    if (growth !== null && growth >= 0) {
      if (pendingUser !== null) {
        sizes[pendingUser] = { tokens: growth, ...(prev === null ? { preamble: true } : {}) };
      } else if (prev !== null && pendingResults) {
        const owner = sizes[prev.i];
        if (owner) {
          owner.tokens += growth;
          owner.results = (owner.results ?? 0) + growth;
        }
      }
    }
    sizes[i] = { tokens: u.output_tokens, out: u.output_tokens };
    prev = { i, ctx: u.input_tokens + u.output_tokens };
    pendingUser = null;
    pendingResults = false;
  });
  return sizes;
}

/** `812`, `1.2k`, `48k`, `1.1M` — the gauge's spelling, with a decimal
 *  under ten thousand where it changes the reading. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(1))}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${parseFloat((n / 1_000).toFixed(1))}k`;
  return String(n);
}

/** Share of the model's window, or null when the window is unknown. */
export function shareOf(tokens: number, limit: number | null | undefined): number | null {
  if (!limit || limit <= 0) return null;
  return Math.min(tokens / limit, 1);
}

/** A turn over this share of the window gets the bar and the percentage. */
export const SHARE_BAR_FROM = 0.05;

/** `24%`, or "" under the bar's threshold or with no window. */
export function fmtShare(share: number | null): string {
  if (share === null || share < SHARE_BAR_FROM) return "";
  return `${Math.round(share * 100)}%`;
}

/** The hover sentence for a turn's figure. */
export function sizeTitle(size: TurnSize, kind: "user" | "assistant", limit: number | null): string {
  const n = size.tokens.toLocaleString();
  const of = limit ? ` — ${Math.round((size.tokens / limit) * 100)}% of the ${limit.toLocaleString()}-token window` : "";
  if (kind === "user") {
    return size.preamble
      ? `${n} tokens: this message and the system prompt together — the log does not separate them${of}`
      : `${n} tokens this message added to the context${of}`;
  }
  const parts = [`${(size.out ?? 0).toLocaleString()} out`];
  if (size.results) parts.push(`${size.results.toLocaleString()} from its tool results`);
  return `${n} tokens this reply added to the context: ${parts.join(" · ")}${of}`;
}

/*
 * The draft's live estimate (nightshift backlog 155, 2026-09-24): "while
 * I'm writing a prompt, it would be quite nice if I could see in the
 * corner or something how many tokens I've written so far, especially
 * when it comes to the longer prompts." Characters over four, rounded up —
 * the rule of `nightloom_core::context::estimate_tokens`, which the Context
 * page already uses, counted in code points as Rust's `chars()` counts
 * them. Within ~10–20% for English prose, worse for code and non-Latin
 * text; the exact count (the API engine's count endpoint) is a later batch.
 */

/** Characters per token, as `nightloom_core::context::CHARS_PER_TOKEN`. */
export const CHARS_PER_TOKEN = 4;

/** Under this estimate the composer shows nothing: a short message is not
 *  decorated (the item's ~50). */
export const DRAFT_TOKENS_FROM = 50;

/** The estimate for `text`: code points over four, rounded up. */
export function estimateTokens(text: string): number {
  // UTF-16 length less one per surrogate pair = code points, without
  // spreading a long draft into an array on every update.
  const pairs = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  return Math.ceil((text.length - pairs) / CHARS_PER_TOKEN);
}

/** The composer's figure for a draft, or null under the threshold. */
export function draftEstimate(text: string): { tokens: number; long: string; short: string } | null {
  const tokens = estimateTokens(text);
  if (tokens < DRAFT_TOKENS_FROM) return null;
  return { tokens, long: `~${tokens.toLocaleString("en-US")} tokens`, short: `~${fmtTokens(tokens)}` };
}

/** The hover sentence for the draft's figure. */
export function draftEstimateTitle(tokens: number): string {
  return `About ${tokens.toLocaleString("en-US")} tokens in the message box — an estimate (characters ÷ ${CHARS_PER_TOKEN}), the text only; attachments are not counted. Close for English prose, rougher for code and other scripts.`;
}
