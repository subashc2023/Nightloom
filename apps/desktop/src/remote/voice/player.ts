/**
 * The reply, spoken (item 246 wave 3, design §2.3): the host sends each
 * sentence as `{"t":"audio","seq","sentence"}` then one binary WAV frame.
 * Decoding is asynchronous, so a later sentence can be ready before an
 * earlier one; `SeqQueue` releases them strictly in order. Everything plays
 * through the one AudioContext the tap that opened voice mode unlocked,
 * via an AnalyserNode whose level drives the orb while it speaks.
 *
 * Barge-in: `hush()` stops the sentence playing, drops everything queued,
 * and ignores the hushed reply's stragglers until the next reply's first
 * sentence arrives (`seq` 0 — the host numbers each reply from 0).
 */

/** Items released in `seq` order, whatever order they arrive in. */
export class SeqQueue<T> {
  private next = 0;
  private waiting = new Map<number, T>();
  private deaf = false;

  /** A new reply (its seq 0 arrived): whatever was left of the last one
   *  is gone, and a hush is over. */
  reset(): void {
    this.waiting.clear();
    this.next = 0;
    this.deaf = false;
  }

  /** Offer `seq`; returns what is now releasable, in order. */
  put(seq: number, item: T): T[] {
    if (this.deaf || seq < this.next) return [];
    this.waiting.set(seq, item);
    const out: T[] = [];
    while (this.waiting.has(this.next)) {
      out.push(this.waiting.get(this.next)!);
      this.waiting.delete(this.next);
      this.next++;
    }
    return out;
  }

  /** Drop everything, and stay deaf until the next reply's `reset`. */
  hush(): void {
    this.waiting.clear();
    this.deaf = true;
  }

  get pending(): number {
    return this.waiting.size;
  }
}

export interface Line {
  seq: number;
  sentence: string;
}

export interface PlayerEvents {
  /** A sentence started playing. */
  onSentence?: (line: Line) => void;
  /** Nothing is playing or queued any more. */
  onIdle?: () => void;
  onError?: (message: string) => void;
}

export class Player {
  private queue = new SeqQueue<{ line: Line; buffer: AudioBuffer | null }>();
  private ready: { line: Line; buffer: AudioBuffer | null }[] = [];
  private current: AudioBufferSourceNode | null = null;
  private epoch = 0;
  private decoding = 0;
  readonly analyser: AnalyserNode;
  private data: Uint8Array<ArrayBuffer>;

  constructor(
    readonly ctx: AudioContext,
    readonly on: PlayerEvents = {},
  ) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(ctx.destination);
    this.data = new Uint8Array(this.analyser.fftSize);
  }

  /** Playing, or with sentences still to come out of the decoder. */
  get busy(): boolean {
    return this.current !== null || this.ready.length > 0 || this.decoding > 0;
  }

  /** One sentence's WAV, as the host sent it. */
  add(line: Line, wav: ArrayBuffer): void {
    // Replies are told apart in arrival order (the host numbers each from
    // 0), not decode order: a reply's seq 1 may decode before its seq 0.
    if (line.seq === 0) {
      this.epoch++;
      this.queue.reset();
      this.ready = [];
    }
    const epoch = this.epoch;
    this.decoding++;
    const done = (buffer: AudioBuffer | null) => {
      this.decoding--;
      // Hushed (or a newer reply began) while it decoded: drop it.
      if (epoch !== this.epoch) return this.settle();
      this.ready.push(...this.queue.put(line.seq, { line, buffer }));
      this.pump();
    };
    this.ctx.decodeAudioData(wav.slice(0)).then(done, () => {
      this.on.onError?.("A sentence of the reply could not be played");
      done(null);
    });
  }

  /** Stop at once (he spoke over it); the text keeps streaming on screen. */
  hush(): void {
    this.epoch++;
    this.queue.hush();
    this.ready = [];
    const c = this.current;
    this.current = null;
    try {
      c?.stop();
    } catch {
      // Not started, or already over.
    }
    this.settle();
  }

  /** 0–1: the speaking voice's level, for the orb. */
  level(): number {
    if (!this.current) return 0;
    this.analyser.getByteTimeDomainData(this.data);
    let s = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      s += v * v;
    }
    return Math.min(1, Math.sqrt(s / this.data.length) * 4);
  }

  private pump(): void {
    if (this.current) return;
    const next = this.ready.shift();
    if (!next) return this.settle();
    if (!next.buffer) return this.pump();
    const src = this.ctx.createBufferSource();
    src.buffer = next.buffer;
    src.connect(this.analyser);
    src.onended = () => {
      if (this.current !== src) return;
      this.current = null;
      this.pump();
    };
    this.current = src;
    src.start();
    this.on.onSentence?.(next.line);
  }

  private settle(): void {
    if (!this.busy) this.on.onIdle?.();
  }
}

/** A short soft "sent" tone (design §2.5's earcon), made, not fetched. */
export function earcon(ctx: AudioContext): void {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(660, t);
  osc.frequency.exponentialRampToValueAtTime(990, t + 0.12);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.2);
}
