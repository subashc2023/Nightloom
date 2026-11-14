/**
 * The window's half of a message's timing line (nightshift item 256).
 *
 * Rust writes one line per agent turn to `~/.nightloom/logs/turn-timing.log`
 * (`crates/nightloom-service/src/turn_timing.rs`): each stage as ms after
 * Send. Three stages only the window sees — Send pressed, the
 * `send_agent` call (after a cold chat's reconnect), and the frame that
 * draws the first text — are taken here as epoch ms (`Date.now()`, the
 * clock Rust's marks share) and sent once per turn under the turn's stop
 * key: at the first paint, or when the turn returns without one.
 */
import { invoke } from "@tauri-apps/api/core";

/** What goes to `turn_timing_window`. */
export interface WindowMarks {
  key: string;
  sent: number;
  invoked: number;
  painted: number | null;
}

type Report = (marks: WindowMarks) => void;

interface Pending {
  marks: WindowMarks;
  reported: boolean;
}

export class TurnClock {
  private sentAt: number | null = null;
  private turns = new Map<string, Pending>();
  /** The turn whose reply the transcript on screen is drawing. */
  private foreground: string | null = null;

  constructor(private readonly report: Report) {}

  /** Send pressed. */
  sent(at: number = Date.now()): void {
    this.sentAt = at;
  }

  /** `send_agent` is being called for the turn named `key`. */
  invoked(key: string, at: number = Date.now()): void {
    this.turns.set(key, {
      marks: { key, sent: this.sentAt ?? at, invoked: at, painted: null },
      reported: false,
    });
    this.sentAt = null;
    this.foreground = key;
  }

  /** Whether a paint would still be news — cheap, for the transcript to
   *  ask before it looks at the live reply at all. */
  waitingForPaint(): boolean {
    const t = this.foreground === null ? undefined : this.turns.get(this.foreground);
    return t !== undefined && !t.reported;
  }

  /** A frame drew the foreground turn's first text. */
  painted(at: number = Date.now()): void {
    if (this.foreground === null) return;
    const t = this.turns.get(this.foreground);
    if (!t || t.reported) return;
    t.marks.painted = at;
    this.send(t);
  }

  /** The turn named `key` returned; reported now if no paint was. */
  ended(key: string): void {
    const t = this.turns.get(key);
    if (t && !t.reported) this.send(t);
    this.turns.delete(key);
    if (this.foreground === key) this.foreground = null;
  }

  private send(t: Pending): void {
    t.reported = true;
    this.report({ ...t.marks });
  }
}

/** Whether the live reply has any text yet — the thing the first paint is of. */
export function hasText(segments: readonly { kind: string; text?: string }[] | null | undefined): boolean {
  return !!segments?.some((s) => s.kind === "text" && !!s.text);
}

/** The app's one clock; a failed report costs only the window's stages. */
export const turnClock = new TurnClock((m) => {
  void invoke("turn_timing_window", {
    key: m.key,
    sent: m.sent,
    invoked: m.invoked,
    painted: m.painted ?? undefined,
  }).catch(() => {});
});

/* ---- The turn trace's clock (item 564, Filament IV stage 5) -------------
 *
 * The trace draws each step of a turn — a thinking block, a tool call — as
 * a numbered row with a bar: where in the turn the step started and how
 * long it ran. Neither the CLI's stream nor the log records when a call
 * started or ended, so the window takes those times itself while the turn
 * streams (`Date.now()` at the render that first sees a step, and at the
 * render that first sees it done) and keeps them for the rest of the
 * session. A reply read back from the log after a relaunch has no times:
 * its rows draw without bars, which is the truth, not a fake.
 *
 * Steps are keyed so the recorded reply that replaces the live one (and
 * may be split into one reply per API call) finds the same times: a tool
 * call by its id; a thinking block by the call it came before (`$` at the
 * end of the turn) and how many thinking blocks stand between them.
 */

/** One step's start and end, epoch ms; `end` null while it runs. */
export interface StepStamp {
  start: number;
  end: number | null;
}

/** One turn's times. `t1` null while the turn runs. */
export interface TraceRecord {
  t0: number;
  t1: number | null;
  steps: Record<string, StepStamp>;
  /** The stream's average speed in tokens a second, once measured. */
  tps: number | null;
  /** The last time a live render looked: the turn's end, near enough,
   *  when the live reply gives way before it could close the record. */
  seen?: number;
}

type StepSeg =
  | { kind: "thinking"; done: boolean }
  | { kind: "redacted" }
  | { kind: "tool"; call: { id: string; result: unknown; denied?: boolean } }
  | { kind: string };

/** The trace key of each segment (null for one that is not a step). */
export function stepKeys(segs: readonly StepSeg[]): (string | null)[] {
  const out: (string | null)[] = new Array(segs.length).fill(null);
  let anchor = "$";
  let back = 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s.kind === "tool") {
      const id = (s as { call: { id: string } }).call.id;
      out[i] = `t:${id}`;
      anchor = id;
      back = 0;
    } else if (s.kind === "thinking" || s.kind === "redacted") {
      out[i] = `k:${anchor}:${back++}`;
    }
  }
  return out;
}

/** Whether a step segment has finished. */
export function stepDone(s: StepSeg): boolean {
  if (s.kind === "thinking") return (s as { done: boolean }).done;
  if (s.kind === "tool") {
    const c = (s as { call: { result: unknown; denied?: boolean } }).call;
    return c.result != null || !!c.denied;
  }
  return true;
}

/**
 * The session's trace records. `observe` is called on every render of a
 * live reply; `find` by a recorded one. Records are indexed by every tool
 * id in them, which is what a recorded reply can look them up by.
 */
export class TraceBook {
  private byTool = new Map<string, TraceRecord>();
  private live = new WeakMap<object, StepStamp>();

  /**
   * Stamp a live turn's steps at `now`; returns the turn's record. `fresh`
   * is the first look at a reply already under way (a chat opened mid-turn):
   * a step already done then has no honest start, so it gets no stamp.
   */
  observe(rec: TraceRecord, segs: readonly StepSeg[], now: number = Date.now(), fresh = false): TraceRecord {
    const keys = stepKeys(segs);
    rec.seen = now;
    segs.forEach((s, i) => {
      const k = keys[i];
      if (k === null) return;
      // The same segment object across renders keeps its stamp even as a
      // thinking block's key changes when the call after it arrives; a new
      // object for the same block finds it under its key before the call
      // came (`k:$:n`, the same n).
      let st = typeof s === "object" ? this.live.get(s) : undefined;
      if (!st) {
        st = rec.steps[k] ?? (k.startsWith("k:") ? rec.steps[`k:$:${k.split(":").pop()}`] : undefined);
        if (!st) {
          if (fresh && stepDone(s)) return;
          st = { start: now, end: null };
        }
        if (typeof s === "object") this.live.set(s, st);
      }
      if (st.end === null && stepDone(s)) st.end = now;
      rec.steps[k] = st;
      if (s.kind === "tool") this.byTool.set((s as { call: { id: string } }).call.id, rec);
    });
    // A key that moved (a thinking block re-anchored) leaves no stale copy.
    const live = new Set(keys.filter((k): k is string => k !== null));
    for (const k of Object.keys(rec.steps)) if (!live.has(k) && k.startsWith("k:")) delete rec.steps[k];
    return rec;
  }

  /** The turn ended at `at`: steps still open end with it. */
  close(rec: TraceRecord, at: number = Date.now()): void {
    if (rec.t1 === null) rec.t1 = at;
    for (const st of Object.values(rec.steps)) if (st.end === null) st.end = rec.t1;
  }

  /** The record a reply's segments belong to, by any of its tool ids. */
  find(segs: readonly StepSeg[]): TraceRecord | null {
    for (const s of segs) {
      if (s.kind !== "tool") continue;
      const r = this.byTool.get((s as { call: { id: string } }).call.id);
      if (r) return r;
    }
    return null;
  }
}

/** The app's one book; session only, like the folds it sits beside. */
export const traceBook = new TraceBook();

/** Where a step's bar sits in the turn, as shares of the turn's span. */
export function barOf(st: StepStamp | undefined, t0: number, tEnd: number): { left: number; width: number } | null {
  if (!st) return null;
  const span = Math.max(1, tEnd - t0);
  const a = Math.min(Math.max(0, st.start - t0), span);
  const b = Math.min(Math.max(a, (st.end ?? tEnd) - t0), span);
  const left = a / span;
  // A step shorter than a pixel still shows as a tick.
  const width = Math.max(0.015, (b - a) / span);
  return { left: Math.min(left, 1 - width), width };
}

/** `0.4 s`, `11.8 s`, `2 min 3 s`. */
export function fmtSecs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const whole = Math.floor(s);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

/* ---- Stream speed (item 564) ---------------------------------------------
 *
 * The header's "~38 tok/s". The backend reports output tokens once per API
 * call, at its end (`message_delta`), so a live speed cannot be read from
 * usage; it is estimated from the characters the reply streams (its words
 * and any thinking text it shows) at four characters a token. Thinking a
 * model keeps to itself streams nothing and so counts nothing: the figure
 * is the speed of what he can see, and says so in its title.
 */
export const CHARS_PER_TOKEN = 4;

export class SpeedMeter {
  /** Tokens per second, one entry per one-second sample, newest last. */
  readonly samples: number[] = [];
  private last: { chars: number; at: number } | null = null;
  private streamedTok = 0;
  private streamedMs = 0;

  constructor(private readonly keep = 24) {}

  /** Sample the reply's streamed character count at `at`. */
  sample(chars: number, at: number = Date.now()): void {
    if (this.last) {
      const dt = at - this.last.at;
      if (dt <= 0) return;
      const tok = Math.max(0, chars - this.last.chars) / CHARS_PER_TOKEN;
      this.samples.push((tok * 1000) / dt);
      if (this.samples.length > this.keep) this.samples.shift();
      if (tok > 0) {
        this.streamedTok += tok;
        this.streamedMs += dt;
      }
    }
    this.last = { chars, at };
  }

  /** Average speed over the seconds that streamed anything; null before any. */
  rate(): number | null {
    return this.streamedMs > 0 ? (this.streamedTok * 1000) / this.streamedMs : null;
  }
}

/** The sparkline's points in a `w`×`h` box, oldest left; empty under two samples. */
export function sparkPoints(samples: readonly number[], w: number, h: number, slots = 24): string {
  if (samples.length < 2) return "";
  const max = Math.max(1, ...samples);
  const step = w / Math.max(1, slots - 1);
  const x0 = w - step * (samples.length - 1);
  return samples
    .map((v, i) => `${(x0 + i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`)
    .join(" ");
}
