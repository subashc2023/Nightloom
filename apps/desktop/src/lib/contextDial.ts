/**
 * The context dial's arithmetic (item 533, Filament IV stage 2; the 521
 * report §2 "The context dial"). Pure, so the component draws and the
 * suite pins the same numbers. The dial is a share of a limit: the right
 * column's context window, and later the new-chat page (stage 4), the
 * plan windows and Nightshift (stage 9) — every caller passes a share,
 * an optional notch and an optional inner share.
 *
 * Outside in: a tick scale (minor and major ticks), the track, the used
 * arc (amber up to the notch, orange past it), the notch, a round head at
 * the arc's end, a thin inner arc (the prompt cache's time left), and the
 * figure in the middle (drawn by the component, not here).
 */

export interface DialInput {
  /** Track diameter in px (the mockup's right column: 104). */
  size: number;
  /** Share of the limit used, 0..1 (clamped). */
  share: number;
  /** Where the notch sits, 0..1; null draws none and the arc never turns hot. */
  mark: number | null;
  /** The inner arc's share, 0..1; null draws no inner ring at all. */
  inner: number | null;
  /** Track stroke width (mockup: 5 in the column, 3–6 elsewhere). */
  stroke?: number;
  /** Space around the track for the ticks (mockup: 14). */
  pad?: number;
  /** Minor and major tick counts round the whole circle; 0 draws none. */
  minor?: number;
  major?: number;
}

export interface Ring {
  r: number;
  /** Circumference, for `stroke-dasharray`. */
  c: number;
}

export interface DialGeometry {
  /** The SVG's width and height. */
  box: number;
  /** The centre (both axes). */
  mid: number;
  stroke: number;
  track: Ring;
  minorRing: Ring;
  majorRing: Ring;
  innerRing: Ring;
  /** `stroke-dasharray` for the minor and major tick circles; "" for none. */
  minorDash: string;
  majorDash: string;
  /** The amber part: its length along the track (0 draws nothing). */
  cool: number;
  /** The orange part past the notch: its length, and where it starts. */
  hot: number;
  hotOffset: number;
  /** The notch: two points, in the unrotated frame (12 o'clock = 0). */
  notch: { x1: number; y1: number; x2: number; y2: number } | null;
  /** The head's angle in degrees clockwise from 12 o'clock, and its radius. */
  headDeg: number;
  headR: number;
  /** The inner arc's length (0 when cold, null when not drawn). */
  inner: number | null;
  past: boolean;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function dialGeometry(input: DialInput): DialGeometry {
  const stroke = input.stroke ?? 5;
  const pad = input.pad ?? 14;
  const box = input.size + pad * 2;
  const mid = box / 2;
  const ring = (r: number): Ring => ({ r, c: 2 * Math.PI * r });
  const track = ring(input.size / 2);
  const minorRing = ring(track.r + stroke / 2 + 4);
  const majorRing = ring(track.r + stroke / 2 + 5);
  const innerRing = ring(Math.max(1, track.r - stroke / 2 - 5));
  const minor = input.minor ?? 50;
  const major = input.major ?? 10;
  // One short dash per tick: a 1px (1.4px for majors) mark, then the gap
  // to the next; the offset centres the mark on its angle.
  const minorDash = minor > 0 ? `1 ${minorRing.c / minor - 1}` : "";
  const majorDash = major > 0 ? `1.4 ${majorRing.c / major - 1.4}` : "";

  const share = clamp01(input.share);
  const mark = input.mark == null ? null : clamp01(input.mark);
  const coolShare = mark == null ? share : Math.min(share, mark);
  const hotShare = mark == null ? 0 : Math.max(0, share - mark);

  let notch: DialGeometry["notch"] = null;
  if (mark != null) {
    // Unrotated frame: angle 0 at 12 o'clock, clockwise.
    const a = mark * 2 * Math.PI;
    const at = (rr: number) => [mid + rr * Math.sin(a), mid - rr * Math.cos(a)];
    const [x1, y1] = at(track.r - stroke / 2 - 3);
    // Out past the ticks: 10 px in the mockup's 14 px pad, shorter on a
    // small dial (a top-bar chip) so the notch stays inside its box.
    const [x2, y2] = at(track.r + stroke / 2 + Math.min(10, pad * 0.72));
    notch = { x1, y1, x2, y2 };
  }

  return {
    box,
    mid,
    stroke,
    track,
    minorRing,
    majorRing,
    innerRing,
    minorDash,
    majorDash,
    cool: coolShare * track.c,
    hot: hotShare * track.c,
    hotOffset: mark == null ? 0 : -mark * track.c,
    notch,
    headDeg: share * 360,
    headR: stroke / 2 + 1.5,
    inner: input.inner == null ? null : clamp01(input.inner) * innerRing.c,
    past: hotShare > 0,
  };
}

/**
 * Tick counts for a window: a minor tick every 20k and a major every 100k
 * (the mockup's 1M: 50 and 10), held to what reads at the dial's size.
 * Null limit: no scale (the window is unknown, so no step means anything).
 */
export function tickCounts(limit: number | null): { minor: number; major: number } {
  if (!limit || limit <= 0) return { minor: 0, major: 0 };
  const minor = Math.round(limit / 20_000);
  const major = Math.round(limit / 100_000);
  return {
    minor: minor >= 4 && minor <= 60 ? minor : 0,
    major: major >= 2 && major <= 20 ? major : 0,
  };
}

/** `212k`, `1M`, `1.25M`, `950`: the dial's centre and the column's figures. */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(2))}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${parseFloat((n / 1_000).toFixed(1))}k`;
  return String(Math.max(0, Math.round(n)));
}

/** The hand-off legend line: `88k away`, `past hand-off`, or the mark itself before any use. */
export function handoffText(used: number | null, markTokens: number | null): string | null {
  if (markTokens == null || markTokens <= 0) return null;
  if (used == null || used <= 0) return shortTokens(markTokens);
  if (used >= markTokens) return "past hand-off";
  return `${shortTokens(markTokens - used)} away`;
}

/**
 * A round ceiling for a bar's scale: 1, 2 or 5 times a power of ten, at or
 * above `n` (3.1k → 5k), so This turn's In and Out share one honest scale.
 */
export function niceCeil(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

/** The week's bar turns hot past this share (521 report §2, bar colours). */
export const WEEK_HOT = 0.85;

/** One tool call of the turn, as the column counts it. */
export interface ToolMark {
  done: boolean;
  error: boolean;
}

/**
 * This turn's tool calls, in order, from the live reply's segments (or the
 * last reply's when idle): done means a result came back.
 */
export function toolMarks(segments: readonly { kind: string; call?: { result: { is_error: boolean } | null } }[]): ToolMark[] {
  const out: ToolMark[] = [];
  for (const s of segments) {
    if (s.kind !== "tool" || !s.call) continue;
    out.push({ done: s.call.result != null, error: !!s.call.result?.is_error });
  }
  return out;
}

/** `3 done · 1 running`, `4 done`, `1 running`; null with no calls. */
export function toolsText(marks: readonly ToolMark[]): string | null {
  if (marks.length === 0) return null;
  const done = marks.filter((m) => m.done).length;
  const running = marks.length - done;
  return [done > 0 ? `${done} done` : "", running > 0 ? `${running} running` : ""].filter(Boolean).join(" · ");
}

/** `0:41`, `12:05`, `1:02:09`: a turn's elapsed time. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The finished turn as the log has it: what This turn shows when idle. */
export interface LoggedTurn {
  startedAt: number | null;
  endedAt: number | null;
  tools: ToolMark[];
  /** The turn's last reply's usage (the newest request's figures). */
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number } | null;
}

type LogEvent =
  | { event: "user_message"; at: string }
  | {
      event: "assistant_message";
      at: string;
      usage?: { input_tokens: number; output_tokens: number; cache_read_tokens?: number } | null;
      blocks: readonly { type: string; id?: string; tool_use_id?: string; is_error?: boolean }[];
    }
  | { event: "tool_result"; tool_use_id: string; is_error?: boolean }
  | { event: string };

/**
 * The last turn in the log: from his last message to the end, its tool
 * calls (a call is done once its result is in the log, as a block or as
 * an event) and its last reply's usage. Null before his first message.
 */
export function lastLoggedTurn(events: readonly LogEvent[]): LoggedTurn | null {
  let from = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === "user_message") {
      from = i;
      break;
    }
  }
  if (from < 0) return null;
  const startedAt = Date.parse((events[from] as { at: string }).at);
  const ids: string[] = [];
  const results = new Map<string, boolean>();
  let endedAt: number | null = null;
  let usage: LoggedTurn["usage"] = null;
  for (let i = from + 1; i < events.length; i++) {
    const e = events[i];
    if (e.event === "assistant_message") {
      const a = e as Extract<LogEvent, { event: "assistant_message" }>;
      const t = Date.parse(a.at);
      if (Number.isFinite(t)) endedAt = t;
      if (a.usage && (a.usage.input_tokens > 0 || a.usage.output_tokens > 0)) usage = a.usage;
      for (const b of a.blocks ?? []) {
        if (b.type === "tool_use" && b.id) ids.push(b.id);
        else if (b.type === "tool_result" && b.tool_use_id) results.set(b.tool_use_id, !!b.is_error);
      }
    } else if (e.event === "tool_result") {
      const r = e as Extract<LogEvent, { event: "tool_result" }>;
      results.set(r.tool_use_id, !!r.is_error);
    }
  }
  return {
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    endedAt,
    tools: ids.map((id) => ({ done: results.has(id), error: results.get(id) ?? false })),
    usage,
  };
}

/**
 * This turn's In: what the newest request carried that was not read back
 * from the cache (fresh input plus cache writes). With no cache split
 * reported, null — the whole prompt is the context figure, not the turn's.
 */
export function freshIn(u: { input_tokens: number; cache_read_tokens?: number } | null): number | null {
  if (!u || u.cache_read_tokens == null) return null;
  return Math.max(0, u.input_tokens - u.cache_read_tokens);
}

/** The column head's model: `claude-opus-5-5` → `opus 5.5`; anything else as given. */
export function modelShort(id: string | null | undefined): string {
  if (!id) return "";
  const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (x) return `${x[1]} ${x[2]}.${x[3]}`;
  return id.replace(/^claude-/, "");
}
