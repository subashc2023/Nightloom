/**
 * Endpointing on the phone (item 246 wave 3, design §2.3): an energy VAD
 * (voice activity detector) with an adaptive noise floor. Pure — it sees one
 * number per 20 ms frame (the frame's level in dBFS) and says when he started
 * and stopped talking, so the orb reacts with no round trip and the host is
 * told `end` only after his pause.
 *
 * - Speech starts when the level stays above `floor + margin` (9 dB) for
 *   `onsetMs` (150 ms).
 * - It ends when the level has stayed below that for `silenceMs` (2.0 s by
 *   default — his "couple seconds"; the setting runs 1–4 s).
 * - The floor follows the room: it drops at once to a quieter level and
 *   rises slowly toward a louder one (a walk's wind and traffic), and far
 *   more slowly while he talks, so a long sentence does not become the floor
 *   but a gust that never stops cannot hold an utterance open forever
 *   (`maxUtteranceMs` ends it regardless).
 */

export interface VadOptions {
  /** How far above the floor counts as voice, in dB. */
  marginDb: number;
  /** Extra margin while the reply is being spoken — the phone's own
   *  speaker leaks into its microphone even with echo cancellation. */
  speakingExtraDb: number;
  onsetMs: number;
  silenceMs: number;
  /** The floor's rise per frame toward a louder room, as a fraction of the
   *  gap: under the bar outside speech / over the bar outside speech (a
   *  word starting, or a new steady noise) / inside speech. */
  riseIdle: number;
  riseOnset: number;
  riseSpeech: number;
  /** Where the floor starts, and the bounds it keeps to. */
  initialFloorDb: number;
  minFloorDb: number;
  maxFloorDb: number;
  maxUtteranceMs: number;
}

export const VAD_DEFAULTS: VadOptions = {
  marginDb: 9,
  speakingExtraDb: 6,
  onsetMs: 150,
  silenceMs: 2000,
  riseIdle: 0.02,
  riseOnset: 0.004,
  riseSpeech: 0.001,
  initialFloorDb: -55,
  minFloorDb: -80,
  maxFloorDb: -25,
  maxUtteranceMs: 60_000,
};

/** The silence setting's range, in ms (design: 1–4 s). */
export const SILENCE_MIN = 1000;
export const SILENCE_MAX = 4000;

export type VadEvent =
  /** He started talking `backMs` ago (the onset window). */
  | { kind: "start"; backMs: number }
  /** He stopped: `speechMs` of voice in the utterance, `totalMs` from
   *  onset to the end of the pause. */
  | { kind: "end"; speechMs: number; totalMs: number };

export class Vad {
  readonly opts: VadOptions;
  floor: number;
  /** In an utterance (after onset, before the pause ran out). */
  speaking = false;
  /** The reply is being spoken aloud (raises the bar for barge-in). */
  replying = false;
  private above = 0;
  private sinceVoice = 0;
  private voiced = 0;
  private total = 0;

  constructor(opts: Partial<VadOptions> = {}) {
    this.opts = { ...VAD_DEFAULTS, ...opts };
    this.floor = this.opts.initialFloorDb;
  }

  setSilence(ms: number): void {
    this.opts.silenceMs = Math.min(SILENCE_MAX, Math.max(SILENCE_MIN, ms));
  }

  /** The bar a frame must clear to count as voice. */
  threshold(): number {
    return this.floor + this.opts.marginDb + (this.replying ? this.opts.speakingExtraDb : 0);
  }

  /** 0–1: how far above the floor this level is — the orb's `--level`. */
  level(db: number): number {
    return Math.min(1, Math.max(0, (db - this.floor - 3) / 30));
  }

  /** How long since the last voiced frame, in ms (0 while voiced). */
  quietMs(): number {
    return this.sinceVoice;
  }

  /** Forget the utterance (muted, cancelled); the floor is kept. */
  reset(): void {
    this.speaking = false;
    this.above = 0;
    this.sinceVoice = 0;
    this.voiced = 0;
    this.total = 0;
  }

  /** One frame of `ms` at level `db` (dBFS; -Infinity is clamped). */
  push(db: number, ms = 20): VadEvent | null {
    const o = this.opts;
    const lvl = Number.isFinite(db) ? Math.max(db, -120) : -120;
    const voice = lvl > this.threshold();
    let out: VadEvent | null = null;

    if (!this.speaking) {
      this.above = voice ? this.above + ms : 0;
      if (this.above >= o.onsetMs) {
        this.speaking = true;
        this.voiced = this.above;
        this.total = this.above;
        this.sinceVoice = 0;
        out = { kind: "start", backMs: this.above };
        this.above = 0;
      }
    } else {
      this.total += ms;
      if (voice) {
        this.voiced += ms;
        this.sinceVoice = 0;
      } else {
        this.sinceVoice += ms;
      }
      if (this.sinceVoice >= o.silenceMs || this.total >= o.maxUtteranceMs) {
        out = { kind: "end", speechMs: this.voiced, totalMs: this.total };
        this.reset();
      }
    }

    // The floor: down at once, up slowly — slower while a frame clears the
    // bar (a word may be starting), slowest mid-utterance. A frame that
    // clears it still nudges the floor, so a steady new noise is learned
    // rather than heard as speech forever.
    if (lvl < this.floor) this.floor = lvl;
    else this.floor += (lvl - this.floor) * (this.speaking ? o.riseSpeech : voice ? o.riseOnset : o.riseIdle);
    this.floor = Math.min(o.maxFloorDb, Math.max(o.minFloorDb, this.floor));
    return out;
  }
}
