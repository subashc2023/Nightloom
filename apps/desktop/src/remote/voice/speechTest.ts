/**
 * Item 334: speech on the phone itself — a measurement bench, not voice
 * mode. Three engines, each timed the same way (supported, time to first
 * word, total, transcript, bytes downloaded), so he can read off his own
 * iPhone whether voice could run with no Mac and no Fly machine doing the
 * speech. Nothing here is wired into `Voice.svelte`.
 *
 * Libraries load from jsDelivr at a pinned version on first use (never in
 * the bundle — the page stays as small as it was for everyone who never
 * opens the panel):
 * - transformers.js 4.2.0 (`transformers.min.js`, self-contained; its ONNX
 *   runtime fetches the matching wasm from jsDelivr and caches it), whisper
 *   weights from Hugging Face into the Cache API (`transformers-cache`).
 * - piper-tts-web 1.0.5 (`+esm`, which pins onnxruntime-web 1.27.0), its
 *   voice from Hugging Face into the origin private file system.
 */

export const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js";
export const PIPER_URL = "https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/+esm";
/** The onnxruntime-web that jsDelivr's `+esm` build of piper-tts-web 1.0.5 imports; its wasm must match. */
export const PIPER_ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/";
/** The transformers.js docs' own sample (11 s, JFK) — a fixed clip, so runs compare. */
export const SAMPLE_CLIP = "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav";
export const SAMPLE_TEXT = "And so, my fellow Americans, ask not what your country can do for you; ask what you can do for your country.";

export const WHISPER_MODELS = [
  { id: "onnx-community/whisper-tiny.en", label: "tiny.en (≈41 MB)" },
  { id: "onnx-community/whisper-base.en", label: "base.en (≈77 MB)" },
] as const;
export const PIPER_VOICE = "en_US-hfc_female-medium";

/** One measured run, as the panel shows it. Times in ms from the tap. */
export interface Run {
  engine: string;
  supported: boolean;
  firstMs: number | null;
  totalMs: number | null;
  /** Load (download or cache read + compile), apart from the work itself. */
  loadMs?: number | null;
  /** Bytes fetched over the network this run; 0 = all from the cache. */
  downloaded?: number | null;
  text: string;
  note: string;
}

export function blankRun(engine: string, supported: boolean, note = ""): Run {
  return { engine, supported, firstMs: null, totalMs: null, text: "", note };
}

/** "41.2 MB", "880 KB", "0 B" — sizes for the panel. */
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "1.24 s", "380 ms". */
export function fmtMs(n: number | null | undefined): string {
  if (n == null) return "—";
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`;
}

/**
 * Bytes fetched, from transformers.js progress events: the largest `total`
 * seen per file among `progress` events. Files read from the cache report
 * no download, so a second run says 0.
 */
export class DownloadTally {
  private files = new Map<string, number>();
  private fromNet = new Set<string>();
  on(e: { status?: string; file?: string; name?: string; total?: number; loaded?: number }): void {
    const key = `${e.name ?? ""}/${e.file ?? ""}`;
    if (e.status === "download") this.fromNet.add(key);
    if (e.status === "progress" && typeof e.total === "number") {
      this.files.set(key, Math.max(this.files.get(key) ?? 0, e.total));
    }
  }
  /** Bytes of the files that came over the network this run. */
  get downloaded(): number {
    let n = 0;
    for (const [k, v] of this.files) if (this.fromNet.has(k)) n += v;
    return n;
  }
  /** Bytes of every file the model needed, cached or not. */
  get size(): number {
    let n = 0;
    for (const v of this.files.values()) n += v;
    return n;
  }
}

// ---- the browser's own engines (Web Speech API) ----

type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechend: (() => void) | null;
  start(): void;
  stop(): void;
};

function recCtor(): (new () => Rec) | null {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function dictationSupported(): boolean {
  return recCtor() !== null;
}

export function synthesisSupported(): boolean {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

/**
 * Safari's dictation: one utterance, interim results on. First word = the
 * first result after the tap (includes how long he waits to speak); total =
 * the tap to the final result. `afterSpeechMs` = his stopping to the final
 * text, the number voice mode would feel.
 */
export function runDictation(onUpdate: (r: Run) => void): { stop(): void; done: Promise<Run> } {
  const C = recCtor();
  const run = blankRun("Safari dictation", !!C);
  if (!C) {
    run.note = "This browser has no SpeechRecognition.";
    return { stop() {}, done: Promise.resolve(run) };
  }
  const rec = new C();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  const t0 = performance.now();
  let speechEnd: number | null = null;
  const done = new Promise<Run>((resolve) => {
    rec.onresult = (e) => {
      const now = performance.now() - t0;
      if (run.firstMs == null) run.firstMs = now;
      let text = "";
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        final = e.results[i].isFinal;
      }
      run.text = text;
      if (final) {
        run.totalMs = now;
        if (speechEnd != null) run.note = `final text ${fmtMs(now - speechEnd)} after he stopped speaking`;
      }
      onUpdate({ ...run });
    };
    rec.onspeechend = () => {
      speechEnd = performance.now() - t0;
    };
    rec.onerror = (e) => {
      run.note = `error: ${e.error}`;
      onUpdate({ ...run });
    };
    rec.onend = () => {
      if (run.totalMs == null) run.totalMs = performance.now() - t0;
      resolve({ ...run });
    };
  });
  try {
    rec.start();
  } catch (e) {
    run.note = `could not start: ${String(e)}`;
    return { stop() {}, done: Promise.resolve(run) };
  }
  return { stop: () => rec.stop(), done };
}

/** Safari's reading aloud: first word = `onstart`, total = `onend`. */
export function runSynthesis(text: string): Promise<Run> {
  const run = blankRun("Safari speechSynthesis", synthesisSupported());
  if (!run.supported) return Promise.resolve({ ...run, note: "This browser has no speechSynthesis." });
  run.text = text;
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    const t0 = performance.now();
    // Safari can drop an utterance silently (no gesture, audio session
    // taken): say so rather than wait forever.
    const guard = setTimeout(() => {
      if (run.firstMs != null) return;
      clearTimeout(cap);
      speechSynthesis.cancel();
      run.supported = false;
      run.note = "no speech started within 10 s";
      resolve({ ...run });
    }, 10_000);
    // …and an end that never comes (WebKit in a window off screen never
    // fires `onend`, measured 2026-10-09): give up after a minute.
    const cap = setTimeout(() => {
      speechSynthesis.cancel();
      run.note = "started, but no end event within 60 s";
      resolve({ ...run });
    }, 60_000);
    u.onstart = () => {
      run.firstMs = performance.now() - t0;
    };
    u.onend = () => {
      clearTimeout(guard);
      clearTimeout(cap);
      run.totalMs = performance.now() - t0;
      run.note = `${voices.length} English voices on this device`;
      resolve({ ...run });
    };
    u.onerror = (e) => {
      clearTimeout(guard);
      clearTimeout(cap);
      run.note = `error: ${(e as SpeechSynthesisErrorEvent).error}`;
      run.totalMs = performance.now() - t0;
      resolve({ ...run });
    };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

// ---- whisper in the page (transformers.js) ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let tjs: Promise<Any> | null = null;
const asr = new Map<string, Promise<Any>>();
/** Each model's file total, kept from its first load (a memoized pipeline reports none). */
const modelBytes = new Map<string, number>();

function transformers(): Promise<Any> {
  tjs ??= import(/* @vite-ignore */ TRANSFORMERS_URL);
  return tjs;
}

/** Whether the model's files are already in the Cache API (a second visit). */
export async function whisperCached(model: string): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const c = await caches.open("transformers-cache");
    const keys = await c.keys();
    return keys.some((k) => k.url.includes(model) && k.url.endsWith(".onnx"));
  } catch {
    return false;
  }
}

/**
 * Load (download once, then cache) and run whisper on 16 kHz mono samples.
 * First word = the first streamed text piece after the audio is handed
 * over; total = the whole transcript. Load time is reported apart.
 */
export async function runWhisper(
  model: string,
  audio: Float32Array,
  onUpdate: (r: Run, status: string) => void,
  // WebGPU is not offered: on Safari transformers.js 4.2 loads onnxruntime's
  // plain wasm (no WebGPU in it) and a WebGPU attempt fails with
  // "webgpuInit is not a function" — then poisons wasm in the same page
  // too (WebKit on the Mac, 2026-10-09).
  device: "wasm" | "webgpu" = "wasm",
): Promise<Run> {
  const run = blankRun(`whisper ${model.split("/")[1]} (${device})`, true);
  const tally = new DownloadTally();
  const tLoad = performance.now();
  let lastPct = -1;
  try {
    const wasCached = await whisperCached(model);
    const T = await transformers();
    let p = asr.get(model + device);
    if (!p) {
      const made: Promise<Any> = T.pipeline("automatic-speech-recognition", model, {
        dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q8" } : "q8",
        device,
        // The q8 decoder fails to build a session under onnxruntime's graph
        // optimizer ("TransposeDQWeightsForMatMulNBits Missing required
        // scale", WebKit on the Mac, 2026-10-09); unoptimized it loads and
        // transcribes correctly.
        session_options: { graphOptimizationLevel: "disabled" },
        progress_callback: (e: Any) => {
          tally.on(e);
          if (e.status === "progress" && typeof e.progress === "number") {
            const pct = Math.floor(e.progress);
            if (pct !== lastPct) {
              lastPct = pct;
              onUpdate({ ...run }, `loading ${e.file} ${pct}%`);
            }
          }
        },
      });
      asr.set(model + device, made);
      made.catch(() => asr.delete(model + device));
      p = made;
    }
    const pipe = await p;
    run.loadMs = performance.now() - tLoad;
    // transformers.js reports "download" for cache reads too: the cache's
    // own state before the load is what says whether bytes came over the air.
    if (tally.size) modelBytes.set(model, tally.size);
    const size = modelBytes.get(model) ?? tally.size;
    run.downloaded = wasCached ? 0 : tally.size;
    run.note = `${device}; model files ${fmtBytes(size)}${wasCached ? " (from cache)" : ""}`;
    onUpdate({ ...run }, "transcribing");
    const t0 = performance.now();
    const streamer = new T.WhisperTextStreamer(pipe.tokenizer, {
      skip_prompt: true,
      callback_function: (piece: string) => {
        if (run.firstMs == null && piece.trim()) run.firstMs = performance.now() - t0;
        run.text += piece;
        onUpdate({ ...run }, "transcribing");
      },
    });
    const out = await pipe(audio, { streamer, chunk_length_s: 30 });
    run.totalMs = performance.now() - t0;
    run.text = (Array.isArray(out) ? out[0]?.text : out?.text) ?? run.text;
    run.note += `; ${(audio.length / 16000).toFixed(1)} s of audio`;
    return { ...run };
  } catch (e) {
    run.supported = false;
    run.note = `failed: ${String((e as Error)?.message ?? e)}`;
    run.downloaded = tally.downloaded;
    return { ...run };
  }
}

/** A clip (any format the browser decodes) as 16 kHz mono samples. */
export async function decode16k(bytes: ArrayBuffer): Promise<Float32Array> {
  const Ctx = (globalThis as Any).AudioContext ?? (globalThis as Any).webkitAudioContext;
  const ctx: AudioContext = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(bytes);
    const len = Math.ceil(buf.duration * 16000);
    const off = new OfflineAudioContext(1, len, 16000);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0).slice();
  } finally {
    void ctx.close();
  }
}

export async function sampleClip(): Promise<Float32Array> {
  const r = await fetch(SAMPLE_CLIP);
  if (!r.ok) throw new Error(`sample clip: HTTP ${r.status}`);
  return decode16k(await r.arrayBuffer());
}

/** 16 kHz Int16 frames (the voice mic's) → one Float32 clip for whisper. */
export function framesToFloat(frames: Int16Array[]): Float32Array {
  let n = 0;
  for (const f of frames) n += f.length;
  const out = new Float32Array(n);
  let i = 0;
  for (const f of frames) for (let j = 0; j < f.length; j++) out[i++] = f[j] / 32768;
  return out;
}

// ---- Piper in the page (piper-tts-web) ----

let piperMod: Promise<Any> | null = null;
let piperSession: Promise<Any> | null = null;
/** The voice's size, kept from the download for later runs' notes. */
let piperBytes = 0;

/**
 * Piper: synthesize the whole text (it does not stream), then play it.
 * First word = synthesis done and playback started; total = playback ended.
 */
export async function runPiper(text: string, onUpdate: (r: Run, status: string) => void, play = true): Promise<Run> {
  const run = blankRun(`Piper ${PIPER_VOICE}`, true);
  run.text = text;
  let bytes = 0;
  const t0 = performance.now();
  try {
    piperMod ??= import(/* @vite-ignore */ PIPER_URL);
    const tts = await piperMod;
    const stored: string[] = await tts.stored().catch(() => []);
    const cached = stored.includes(PIPER_VOICE);
    if (!piperSession) {
      piperSession = tts.TtsSession.create({
        voiceId: PIPER_VOICE,
        wasmPaths: { ...tts.TtsSession.WASM_LOCATIONS, onnxWasm: PIPER_ORT_WASM },
        progress: (p: { url: string; loaded: number; total: number }) => {
          if (p.total > 1) {
            bytes = Math.max(bytes, p.total);
            piperBytes = bytes;
            onUpdate({ ...run }, `loading voice ${Math.round((p.loaded * 100) / p.total)}%`);
          }
        },
      });
      piperSession!.catch(() => (piperSession = null));
    }
    const session = await piperSession;
    run.loadMs = performance.now() - t0;
    run.downloaded = cached ? 0 : bytes;
    onUpdate({ ...run }, "synthesizing");
    const tSyn = performance.now();
    const wav: Blob = await session.predict(text);
    const synMs = performance.now() - tSyn;
    run.note = `voice ${fmtBytes(bytes || piperBytes || null)}${cached ? " (from storage)" : ""}; synthesis ${fmtMs(synMs)}; wav ${fmtBytes(wav.size)}`;
    if (!play) {
      run.firstMs = synMs;
      run.totalMs = synMs;
      return { ...run };
    }
    const audio = new Audio(URL.createObjectURL(wav));
    await new Promise<void>((resolve, reject) => {
      audio.onplaying = () => {
        run.firstMs = performance.now() - tSyn;
        onUpdate({ ...run }, "playing");
      };
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("playback failed"));
      audio.play().catch(reject);
    });
    run.totalMs = performance.now() - tSyn;
    URL.revokeObjectURL(audio.src);
    return { ...run };
  } catch (e) {
    run.supported = false;
    run.note = `failed: ${String((e as Error)?.message ?? e)}`;
    return { ...run };
  }
}

/** The page's facts that decide what can work at all. */
export function environment(): Record<string, string> {
  const n = navigator as Any;
  return {
    "secure context": String(globalThis.isSecureContext === true),
    "cross-origin isolated": String((globalThis as Any).crossOriginIsolated === true),
    WebGPU: n.gpu ? "yes" : "no",
    cores: String(n.hardwareConcurrency ?? "?"),
    "Home Screen app": String(
      n.standalone === true || (typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches),
    ),
  };
}
