/**
 * The microphone's samples on their way to the host (item 246 wave 3,
 * design §2.3): the AudioWorklet hands the main thread float blocks at the
 * device's rate (48 kHz on an iPhone, usually); these pure pieces turn them
 * into 20 ms frames of 16 kHz mono 16-bit little-endian PCM — what
 * `voice/session.rs` reads — each with its level for the VAD and the orb.
 */

export const MIC_RATE = 16_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (MIC_RATE * FRAME_MS) / 1000; // 320

/**
 * A streaming downsampler: each output sample is the mean of the input
 * samples its interval covers (a box filter — enough anti-aliasing for
 * speech going to whisper, and cheap on a phone during a walk).
 */
export class Resampler {
  private step: number;
  private acc = 0;
  private n = 0;
  private pos = 0;

  constructor(
    readonly inRate: number,
    readonly outRate = MIC_RATE,
  ) {
    this.step = inRate / outRate;
  }

  push(input: Float32Array): Float32Array {
    const out = new Float32Array(Math.ceil((input.length + this.pos + 1) / this.step));
    let k = 0;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.step) {
        out[k++] = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        this.pos -= this.step;
      }
    }
    return out.subarray(0, k);
  }
}

/** Float in −1…1 → 16-bit. */
export function toInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

/** A frame's level in dBFS (−120 for digital silence). */
export function rmsDb(frame: Int16Array): number {
  if (frame.length === 0) return -120;
  let s = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] / 32768;
    s += v * v;
  }
  const rms = Math.sqrt(s / frame.length);
  return rms > 1e-6 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
}

/** Little-endian bytes of 16-bit samples, whatever the host's byte order. */
export function leBytes(frame: Int16Array): ArrayBuffer {
  const buf = new ArrayBuffer(frame.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < frame.length; i++) view.setInt16(i * 2, frame[i], true);
  return buf;
}

/** Cuts a stream of 16 kHz floats into whole 20 ms frames. */
export class Framer {
  private buf = new Int16Array(FRAME_SAMPLES);
  private fill = 0;

  push(samples: Float32Array, onFrame: (frame: Int16Array) => void): void {
    const pcm = toInt16(samples);
    let i = 0;
    while (i < pcm.length) {
      const take = Math.min(FRAME_SAMPLES - this.fill, pcm.length - i);
      this.buf.set(pcm.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === FRAME_SAMPLES) {
        onFrame(this.buf);
        this.buf = new Int16Array(FRAME_SAMPLES);
        this.fill = 0;
      }
    }
  }
}

/**
 * What goes up the socket, frame by frame (design §2.3). Nothing is sent
 * until he starts talking, then the onset window plus a little before it
 * (the first syllable), every frame while he talks, and at most `trailMs`
 * of each silence — a longer pause that he then breaks resumes sending with
 * the pre-roll again. So whisper hears his words without the two seconds
 * of silence it would hear "Thank you." in.
 */
export class Uplink {
  private ring: Int16Array[] = [];
  private live = false;

  constructor(
    readonly prerollMs = 300,
    readonly trailMs = 600,
  ) {}

  /** One frame, with what the VAD said of it. Returns the frames to send. */
  push(frame: Int16Array, speaking: boolean, quietMs: number, started: boolean): Int16Array[] {
    const keep = Math.ceil(this.prerollMs / FRAME_MS) + 8;
    if (!speaking && !started) {
      this.live = false;
      this.ring.push(frame);
      if (this.ring.length > keep) this.ring.shift();
      return [];
    }
    if (started || (!this.live && quietMs === 0)) {
      // Onset (or speech again after a trimmed pause): the pre-roll first.
      this.ring.push(frame);
      const out = this.ring.slice(-keep);
      this.ring = [];
      this.live = true;
      return out;
    }
    if (quietMs > this.trailMs) {
      this.live = false;
      this.ring.push(frame);
      if (this.ring.length > keep) this.ring.shift();
      return [];
    }
    return [frame];
  }

  reset(): void {
    this.ring = [];
    this.live = false;
  }
}
