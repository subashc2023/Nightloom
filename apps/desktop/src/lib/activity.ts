/**
 * The activity block (nightshift backlog 096, 2026-09-16): a reply's tool
 * calls and thinking as one aligned group rather than a run of bare mono
 * lines and pills.
 *
 * This is the pure part — how a reply's segments group into blocks, what
 * a row is called, and what the folded line says — so the suite can pin it
 * without a DOM. `AssistantMessage.svelte` draws what this returns.
 *
 * Grouping is by run: consecutive thinking, redacted-thinking and tool
 * segments form one block; a text segment (the model narrating between
 * calls) or a notice ends it, and the next call starts another. A block
 * therefore reads in the order the reply happened, with the model's own
 * sentences between its bursts of work. Removed blocks (backlog 066) keep
 * their placeholder outside any block: they are edits to the context, not
 * activity.
 */
import type { Segment } from "./state.svelte";

/** A segment with its index into the reply's segments, which the override
 *  ids and the hover Remove are keyed by. */
export interface Placed<S = Segment> {
  seg: S;
  i: number;
}

export type Group =
  | { kind: "activity"; rows: Placed[]; key: string }
  | { kind: "one"; seg: Segment; i: number };

/** What a segment is in the block: activity, or something that stands alone. */
export function isActivity(seg: Segment): boolean {
  return seg.kind === "thinking" || seg.kind === "redacted" || seg.kind === "tool";
}

/**
 * Group a reply's segments into activity blocks and standalone segments.
 * `ids` is `segmentIds(segs)`; a block is keyed by its first row's id
 * (`block:tool:toolu_1`, `block:thinking:0`) so a click on the fold line
 * can be remembered the way a click on a row is.
 */
export function groupSegments(segs: readonly Segment[], ids: readonly string[]): Group[] {
  const out: Group[] = [];
  let open: { kind: "activity"; rows: Placed[]; key: string } | null = null;
  segs.forEach((seg, i) => {
    if (isActivity(seg)) {
      if (!open) {
        open = { kind: "activity", rows: [], key: `block:${ids[i] ?? String(i)}` };
        out.push(open);
      }
      open.rows.push({ seg, i });
    } else {
      open = null;
      out.push({ kind: "one", seg, i });
    }
  });
  return out;
}

/**
 * The name a row shows. An MCP tool arrives as `mcp__<server>__<tool>`; the
 * row says the tool part with its underscores as spaces (`search chats`),
 * and the full name goes in the title. Everything else keeps its name —
 * `Bash`, `Read`, `ToolSearch` are already short.
 */
export function shortToolName(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  if (!m) return name;
  return m[1].replace(/_+/g, " ");
}

/** The counts a folded block says. */
export interface ActivityCounts {
  tools: number;
  thinking: number;
  errors: number;
  denied: number;
}

export function countActivity(rows: readonly Placed[]): ActivityCounts {
  const c: ActivityCounts = { tools: 0, thinking: 0, errors: 0, denied: 0 };
  for (const { seg } of rows) {
    if (seg.kind === "tool") {
      c.tools++;
      if (seg.call.denied) c.denied++;
      else if (seg.call.result?.is_error) c.errors++;
    } else if (seg.kind === "thinking" || seg.kind === "redacted") {
      c.thinking++;
    }
  }
  return c;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The folded line: `4 tool calls · 2 thinking`, with `· 1 error` or
 * `· 1 denied` when there is something to know, and `· working` while the
 * reply is still streaming (the fold is not offered then, but the line is
 * still what a reader would want if it were).
 */
export function activitySummary(rows: readonly Placed[], streaming = false): string {
  const c = countActivity(rows);
  const parts: string[] = [];
  if (c.tools > 0) parts.push(plural(c.tools, "tool call", "tool calls"));
  if (c.thinking > 0) parts.push(`${c.thinking} thinking`);
  if (c.errors > 0) parts.push(plural(c.errors, "error", "errors"));
  if (c.denied > 0) parts.push(`${c.denied} denied`);
  if (streaming) parts.push("working");
  return parts.join(" · ");
}

/**
 * Whether a block is folded to its one line. Folding is what the tools
 * toggle off means once the reply is done; while it streams the block
 * stays open so the rows arrive where they can be seen. A click on the
 * fold line records the opposite (`overrides[key]`), under the tools
 * toggle's revision, so flipping the toggle clears it like a row's click.
 */
export function resolveFolded(
  key: string,
  streaming: boolean,
  overrides: Record<string, { open: boolean; rev: number }>,
  prefs: { tools: boolean; rev: { tool: number } },
): boolean {
  const o = overrides[key];
  if (o !== undefined && o.rev === prefs.rev.tool) return !o.open;
  if (streaming) return false;
  return !prefs.tools;
}

/**
 * Thinking the model kept to itself (nightshift backlog 097, 2026-09-16).
 *
 * A thinking block can arrive with no text: the Claude 5 family defaults
 * `thinking.display` to `omitted`, the block then carries a signature and
 * nothing else, and the Claude Code CLI runs that way (measured 2026-09-16
 * on CLI 2.1.263 with Haiku 4.5: a `thinking` block with `thinking: ""`
 * and two empty `thinking_delta`s). Nightloom's own API engine asks for
 * `summarized`, so its blocks have a summary to open. Either way a block
 * with nothing in it is a fact to state, not a button to offer.
 */
export const HIDDEN_THINKING_TITLE =
  "This model does not return its thinking; only that it thought.";

/** A finished thinking block with nothing to open. While it still streams
 *  an empty one is merely early, and reads as thinking under way. */
export function thinkingHidden(seg: Segment): boolean {
  return seg.kind === "thinking" && seg.done && seg.text.trim() === "";
}

export type ThinkingState = "none" | "hidden" | "shown";

/**
 * What the chat's recorded replies say about thinking, for the top-bar
 * chip and ⌘⇧T: `none` when no reply has thought yet, `hidden` when every
 * thinking block is empty (the toggle would open nothing), `shown` when at
 * least one has text. Redacted thinking counts as hidden — it has nothing
 * to show either.
 */
export function thinkingState(
  events: readonly { event: string; blocks?: readonly { type: string; text?: string }[] }[],
): ThinkingState {
  let blocks = 0;
  for (const e of events) {
    if (e.event !== "assistant_message" || !e.blocks) continue;
    for (const b of e.blocks) {
      if (b.type === "thinking") {
        blocks++;
        if ((b.text ?? "").trim() !== "") return "shown";
      } else if (b.type === "redacted_thinking") {
        blocks++;
      }
    }
  }
  return blocks === 0 ? "none" : "hidden";
}

/**
 * Models whose thinking is omitted unless asked for a summary (`external`,
 * the API reference as read for backlog 097: Opus 5, Opus 4.7 and 4.8,
 * Sonnet 5, Fable 5 and 5.1). Matched by family so dated snapshots count.
 * On Nightloom's API engine the summary is asked for, so this matters
 * before the first reply only on the Claude Code engine, where the CLI
 * decides.
 */
export function modelOmitsThinking(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return (
    /opus-?5/.test(m) ||
    /opus-?4[.-][78]/.test(m) ||
    /sonnet-?5/.test(m) ||
    /fable/.test(m)
  );
}

/**
 * Whether the thinking toggle (the top-bar chip, ⌘⇧T, the palette row) has
 * anything to open in this chat: nothing, when every recorded thinking
 * block is empty, or when none has thought yet and the Claude Code engine
 * is on a model that omits its thinking. A pure function of the log and
 * the connection, so the three call sites cannot disagree.
 */
export function thinkingToggleDead(
  events: Parameters<typeof thinkingState>[0],
  connection: { engine?: string; model?: string | null } | null | undefined,
): boolean {
  const avail = thinkingState(events);
  if (avail === "hidden") return true;
  return avail === "none" && connection?.engine === "claude-code" && modelOmitsThinking(connection?.model);
}

/** `working · 41 s`, or `working · 2 min 3 s` past a minute. */
export function workingLabel(elapsedMs: number): string {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  if (s < 60) return `working · ${s} s`;
  const m = Math.floor(s / 60);
  return `working · ${m} min ${s % 60} s`;
}
