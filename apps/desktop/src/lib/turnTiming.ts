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
