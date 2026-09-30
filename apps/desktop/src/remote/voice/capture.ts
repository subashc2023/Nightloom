/**
 * The microphone (item 246 wave 3, design §2.3): `getUserMedia` into an
 * AudioWorklet that hands the main thread ~20 ms float blocks, which
 * `pcm.ts` turns into 16 kHz frames. `getUserMedia` exists only in a secure
 * context — over the Mac's plain `http://100.x…:8642` it is undefined, and
 * the page offers keyboard dictation instead (`canCapture`).
 *
 * The harness's `?fakeMic=<path>` (dev builds only — `import.meta.env.DEV`,
 * so the shipped page has no such door): an `AudioBufferSourceNode` playing
 * that same-origin WAV stands in for the microphone, followed by silence.
 */
import { Framer, MIC_RATE, Resampler } from "./pcm";

// The worklet's code, as a Blob so the build needs no second entry. It only
// gathers the render thread's 128-sample blocks into ~20 ms and posts them;
// a missing input (a source that ended) counts as silence.
const WORKLET = `
class NightloomMic extends AudioWorkletProcessor {
  constructor() { super(); this.size = Math.round(sampleRate / 50); this.buf = new Float32Array(this.size); this.fill = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const n = ch ? ch.length : 128;
    for (let i = 0; i < n; i++) {
      this.buf[this.fill++] = ch ? ch[i] : 0;
      if (this.fill === this.size) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(this.size); this.fill = 0; }
    }
    return true;
  }
}
registerProcessor("nightloom-mic", NightloomMic);
`;

/** Whether this page can hear at all (secure context + mediaDevices). */
export function canCapture(): boolean {
  if (fakeMicPath()) return typeof AudioWorkletNode !== "undefined";
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioWorkletNode !== "undefined"
  );
}

/** `?fakeMic=` in a dev build: a same-origin path, nothing else. */
export function fakeMicPath(): string | null {
  if (!import.meta.env.DEV || typeof location === "undefined") return null;
  const p = new URLSearchParams(location.search).get("fakeMic");
  return p && p.startsWith("/") && !p.startsWith("//") ? p : null;
}

export interface Capture {
  stop(): void;
}

/**
 * Start hearing. `onFrame` gets each 20 ms frame of 16 kHz PCM. Resolves
 * once audio flows; rejects with a sentence he can read (permission
 * refused, no microphone).
 */
export async function startCapture(ctx: AudioContext, onFrame: (frame: Int16Array) => void): Promise<Capture> {
  const fake = fakeMicPath();
  let stream: MediaStream | null = null;
  let source: AudioNode;
  let fakeNode: AudioBufferSourceNode | null = null;
  if (fake) {
    const bytes = await (await fetch(fake)).arrayBuffer();
    const audio = await ctx.decodeAudioData(bytes);
    fakeNode = ctx.createBufferSource();
    fakeNode.buffer = audio;
    source = fakeNode;
  } else {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          // Gain control would chase his voice up and the room's floor
          // with it; the VAD adapts to the room on its own.
          autoGainControl: false,
        },
      });
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      throw new Error(
        name === "NotAllowedError"
          ? "The microphone is off for this page — allow it in Settings → Safari → Microphone, then try again"
          : name === "NotFoundError"
            ? "No microphone was found"
            : `The microphone could not start (${name || String(e)})`,
      );
    }
    source = ctx.createMediaStreamSource(stream);
  }

  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(ctx, "nightloom-mic", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  const resampler = new Resampler(ctx.sampleRate, MIC_RATE);
  const framer = new Framer();
  node.port.onmessage = (e: MessageEvent<Float32Array>) => framer.push(resampler.push(e.data), onFrame);
  source.connect(node);
  // A worklet runs only while pulled: a muted gain to the output keeps it
  // pulled without the microphone reaching the speaker.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  fakeNode?.start();

  return {
    stop() {
      try {
        fakeNode?.stop();
      } catch {
        // Already ended.
      }
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      sink.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
    },
  };
}
