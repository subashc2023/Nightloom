/**
 * Chapters in a long chat (nightshift item 799, from 793's survey #6): a
 * divider at each phase change and a contents list that jumps to them.
 *
 * Chapters come from marks code can see in the log, never from the model
 * (a model route would have to be measured not to change the cached
 * prefix first — not built):
 *
 * - **start** — his first message (listed, not drawn: the top of the chat);
 * - **hand_off** — an in-place hand-off (item 763 draws its own divider;
 *   listed here, not drawn twice);
 * - **plan** — an `ExitPlanMode` call whose result is not an error: the plan
 *   was approved, and the work after it is the next phase. Drawn after the
 *   message that proposed it;
 * - **wave** — two or more helpers (`Agent` / `Task`) launched in one turn.
 *   Drawn before the message with the first launch;
 * - **commit** — the turn's shell calls committed (a `[branch sha] subject`
 *   line in a result): one chapter per turn, drawn after the turn's last
 *   commit, since a commit closes a phase.
 *
 * Only live events count: a rewound mark drops out, an un-rewind brings it
 * back. Every chapter's key names its mark's log index, which never moves
 * (the log is append-only), so a rename or a removal (`chapterEdits`) keeps
 * to its chapter through reload and rewind.
 */
import { COMMIT_LINE } from "./handoffCarry";
import type { SessionEvent } from "./types";

export type ChapterKind = "start" | "hand_off" | "plan" | "wave" | "commit";

export interface Chapter {
  /** Stable within the chat: `<kind>:<log index of the mark>`. */
  key: string;
  kind: ChapterKind;
  /** The log index of the mark. */
  index: number;
  /** Drawn before the first transcript item whose log index is at least this. */
  anchor: number;
  /** The code's title; a rename replaces it (`chapterEdits`). */
  title: string;
  at: string | null;
  /** Whether the transcript draws a divider for it (start and hand-off have their own places). */
  drawn: boolean;
}

/** Longest title the code writes; his renames are kept whole. */
export const TITLE_MAX = 72;
/** A jump lands a divider this far below the usual jump place, clear of the Contents pill (px). */
export const CONTENTS_CLEAR = 40;
/** Helpers launched in one turn that make a wave. */
export const WAVE_MIN = 2;

const AGENT_TOOLS = new Set(["Agent", "Task"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Whitespace collapsed, cut at `TITLE_MAX` with an ellipsis. */
export function clip(s: string, max = TITLE_MAX): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** A text's first non-empty line, Markdown heading marks and emphasis dropped. */
export function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/[*_`]+/g, "")
      .trim();
    if (t) return t;
  }
  return "";
}

/** "Committed 799: chapters" / "Committed 799: chapters · +2 more". */
export function commitTitle(subjects: readonly string[]): string {
  const last = subjects[subjects.length - 1] ?? "";
  const more = subjects.length > 1 ? ` · +${subjects.length - 1} more` : "";
  return `Committed ${clip(last, TITLE_MAX - 10 - more.length)}${more}`;
}

/** "3 helpers: wave A, wave B, …". */
export function waveTitle(descriptions: readonly string[]): string {
  const named = descriptions.filter((d) => d).join(", ");
  return clip(`${descriptions.length} helpers${named ? `: ${named}` : ""}`);
}

interface Turn {
  /** Assistant messages of the turn, in order: log index and the calls. */
  msgs: { index: number; at: string; calls: { id: string; name: string; input: Record<string, unknown> }[] }[];
}

/**
 * The chapters of a log, in reading order. `live` is `liveFlags(evs)`.
 */
export function chaptersOf(evs: readonly SessionEvent[], live: readonly boolean[]): Chapter[] {
  const results = new Map<string, { content: string; is_error: boolean }>();
  evs.forEach((e, i) => {
    if (live[i] !== false && e.event === "tool_result") results.set(e.tool_use_id, { content: e.content, is_error: !!e.is_error });
  });
  const out: Chapter[] = [];
  let turn: Turn = { msgs: [] };
  const closeTurn = () => {
    // Helpers: two or more launched this turn.
    const launches = turn.msgs.flatMap((m) => m.calls.filter((c) => AGENT_TOOLS.has(c.name)).map((c) => ({ m, c })));
    if (launches.length >= WAVE_MIN) {
      const first = launches[0].m;
      out.push({
        key: `wave:${first.index}`,
        kind: "wave",
        index: first.index,
        anchor: first.index,
        title: waveTitle(launches.map(({ c }) => clip(str(c.input.description) || str(c.input.subagent_type), 28))),
        at: first.at,
        drawn: true,
      });
    }
    // Commits: one chapter after the turn's last one.
    const subjects: string[] = [];
    let lastAt: { index: number; at: string } | null = null;
    for (const m of turn.msgs) {
      for (const c of m.calls) {
        if (c.name !== "Bash") continue;
        const r = results.get(c.id);
        if (!r || r.is_error) continue;
        for (const hit of r.content.matchAll(COMMIT_LINE)) {
          subjects.push(hit[3].trim());
          lastAt = { index: m.index, at: m.at };
        }
      }
    }
    if (lastAt) {
      out.push({
        key: `commit:${lastAt.index}`,
        kind: "commit",
        index: lastAt.index,
        anchor: lastAt.index + 1,
        title: commitTitle(subjects),
        at: lastAt.at,
        drawn: true,
      });
    }
    turn = { msgs: [] };
  };
  let started = false;
  evs.forEach((e, i) => {
    if (live[i] === false) return;
    if (e.event === "user_message") {
      closeTurn();
      if (!started) {
        started = true;
        out.push({ key: "start", kind: "start", index: i, anchor: i, title: clip(firstLine(e.text)) || "Start", at: e.at, drawn: false });
      }
    } else if (e.event === "hand_off") {
      closeTurn();
      out.push({ key: `hand_off:${i}`, kind: "hand_off", index: i, anchor: i + 1, title: "Handed off", at: e.at, drawn: false });
    } else if (e.event === "assistant_message") {
      const calls = e.blocks.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: rec(b.input) }] : []));
      turn.msgs.push({ index: i, at: e.at, calls });
      for (const c of calls) {
        if (c.name !== "ExitPlanMode") continue;
        const r = results.get(c.id);
        if (!r || r.is_error) continue;
        const plan = clip(firstLine(str(c.input.plan)), TITLE_MAX - 15);
        out.push({
          key: `plan:${i}`,
          kind: "plan",
          index: i,
          anchor: i + 1,
          title: plan ? `Plan approved: ${plan}` : "Plan approved",
          at: e.at,
          drawn: true,
        });
      }
    }
  });
  closeTurn();
  // Reading order: by where each is drawn, ties by the mark.
  return out
    .map((c, n) => ({ c, n }))
    .sort((a, b) => a.c.anchor - b.c.anchor || a.c.index - b.c.index || a.n - b.n)
    .map(({ c }) => c);
}

/** Where the drawn chapters go among the transcript's items (their log indices, in order). */
export function placeChapters<C extends Chapter>(
  items: readonly { index: number }[],
  chapters: readonly C[],
): { before: Map<number, C[]>; tail: C[] } {
  const before = new Map<number, C[]>();
  const tail: C[] = [];
  const drawn = chapters.filter((c) => c.drawn).sort((a, b) => a.anchor - b.anchor || a.index - b.index);
  let p = 0;
  for (const c of drawn) {
    while (p < items.length && items[p].index < c.anchor) p++;
    if (p >= items.length) tail.push(c);
    else before.set(p, [...(before.get(p) ?? []), c]);
  }
  return { before, tail };
}

/** The chapter a view is in: the last one whose place is at or above `top` (px tops, in chapter order). */
export function currentChapter(tops: readonly (number | null)[], top: number): number | null {
  let at: number | null = null;
  tops.forEach((t, i) => {
    if (t !== null && t <= top) at = i;
  });
  return at;
}
