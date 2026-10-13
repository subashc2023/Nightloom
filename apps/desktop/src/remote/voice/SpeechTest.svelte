<script lang="ts">
  // Item 334: the speech test panel — measurements only, off his normal
  // flow (reached from the Hosts sheet's "Speech test" link). See
  // speechTest.ts for what each number means.
  import { onDestroy } from "svelte";
  import { startCapture, canCapture, type Capture } from "./capture";
  import {
    PIPER_VOICE,
    SAMPLE_TEXT,
    WHISPER_MODELS,
    dictationSupported,
    environment,
    fmtBytes,
    fmtMs,
    framesToFloat,
    runDictation,
    runPiper,
    runSynthesis,
    runWhisper,
    sampleClip,
    synthesisSupported,
    whisperCached,
    type Run,
  } from "./speechTest";

  let { onclose }: { onclose?: () => void } = $props();

  const env = environment();
  let runs = $state<Run[]>([]);
  let live = $state<Run | null>(null);
  let status = $state("");
  let busy = $state(false);
  let model = $state<string>(WHISPER_MODELS[0].id);
  let cached = $state<boolean | null>(null);
  let text = $state(SAMPLE_TEXT);
  let dict: { stop(): void } | null = $state(null);
  let rec: { cap: Capture; ctx: AudioContext; frames: Int16Array[]; timer: ReturnType<typeof setTimeout> } | null = $state(null);

  $effect(() => {
    void whisperCached(model).then((c) => (cached = c));
  });

  // Closing the sheet mid-test lets go of the microphone and the voice.
  onDestroy(() => {
    dict?.stop();
    if (rec) {
      clearTimeout(rec.timer);
      rec.cap.stop();
      void rec.ctx.close();
    }
    if (synthesisSupported()) speechSynthesis.cancel();
  });

  function done(r: Run) {
    runs = [r, ...runs];
    live = null;
    status = "";
    busy = false;
  }

  async function dictation() {
    busy = true;
    status = "Speak now — one sentence";
    const d = runDictation((r) => (live = r));
    dict = d;
    const r = await d.done;
    dict = null;
    done(r);
  }

  async function synth() {
    busy = true;
    status = "Reading aloud";
    done(await runSynthesis(text));
  }

  async function whisperOn(audio: Float32Array) {
    const r = await runWhisper(model, audio, (r, s) => ((live = r), (status = s)));
    done(r);
    cached = await whisperCached(model);
  }

  async function whisperSample() {
    busy = true;
    status = "Fetching the sample clip";
    try {
      await whisperOn(await sampleClip());
    } catch (e) {
      done({ engine: "whisper", supported: false, firstMs: null, totalMs: null, text: "", note: String(e) });
    }
  }

  async function whisperRecord() {
    if (rec) return stopRecord();
    busy = true;
    status = "Recording — tap Stop when done (8 s at most)";
    const Ctx = (globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext;
    const ctx = new Ctx();
    const frames: Int16Array[] = [];
    try {
      const cap = await startCapture(ctx, (f) => frames.push(f));
      rec = { cap, ctx, frames, timer: setTimeout(stopRecord, 8000) };
      busy = false;
    } catch (e) {
      void ctx.close();
      done({ engine: "whisper (mic)", supported: false, firstMs: null, totalMs: null, text: "", note: String((e as Error).message ?? e) });
    }
  }

  async function stopRecord() {
    const r = rec;
    if (!r) return;
    rec = null;
    clearTimeout(r.timer);
    r.cap.stop();
    void r.ctx.close();
    busy = true;
    status = "Loading whisper";
    await whisperOn(framesToFloat(r.frames));
  }

  async function piper() {
    busy = true;
    status = "Loading the Piper voice";
    done(await runPiper(text, (r, s) => ((live = r), (status = s))));
  }

  function copyAll() {
    const lines = [
      Object.entries(env).map(([k, v]) => `${k}: ${v}`).join(", "),
      navigator.userAgent,
      ...runs.map(
        (r) =>
          `${r.engine} | supported ${r.supported ? "yes" : "no"} | first ${fmtMs(r.firstMs)} | total ${fmtMs(r.totalMs)} | load ${fmtMs(r.loadMs)} | downloaded ${fmtBytes(r.downloaded)} | ${r.note} | "${r.text.trim()}"`,
      ),
    ];
    void navigator.clipboard?.writeText(lines.join("\n"));
    status = "Copied — paste it into a chat";
  }
</script>

<div class="st" data-speech-test>
  <div class="st-head">
    <div class="st-title">Speech test</div>
    {#if onclose}<button class="st-btn small" onclick={onclose}>Close</button>{/if}
  </div>
  <p class="st-note">Measures speech that runs on this phone alone. Nothing here touches voice mode.</p>
  <p class="st-env">
    {#each Object.entries(env) as [k, v] (k)}<span>{k}: <b>{v}</b></span>{/each}
  </p>

  <section>
    <h4>1 · Safari's own speech</h4>
    <div class="row">
      {#if dict}
        <button class="st-btn accent" onclick={() => dict?.stop()}>Stop dictation</button>
      {:else}
        <button class="st-btn" data-act="dictation" disabled={busy || !dictationSupported()} onclick={dictation}>Dictate</button>
      {/if}
      <button class="st-btn" data-act="synth" disabled={busy || !synthesisSupported()} onclick={synth}>Read aloud</button>
    </div>
    <div class="st-sub">Dictation: {dictationSupported() ? "supported" : "not supported"} · Reading aloud: {synthesisSupported() ? "supported" : "not supported"}</div>
  </section>

  <section>
    <h4>2 · whisper in the page</h4>
    <div class="row">
      <select bind:value={model} disabled={busy || !!rec}>
        {#each WHISPER_MODELS as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
      </select>
    </div>
    <div class="row">
      <button class="st-btn" data-act="whisper-sample" disabled={busy || !!rec} onclick={whisperSample}>Sample clip</button>
      <button class="st-btn {rec ? 'accent' : ''}" data-act="whisper-mic" disabled={(busy && !rec) || !canCapture()} onclick={whisperRecord}>{rec ? "Stop" : "Record"}</button>
    </div>
    <div class="st-sub">Model {cached === null ? "…" : cached ? "cached on this phone" : "not downloaded yet — the first run fetches it"}</div>
  </section>

  <section>
    <h4>3 · Piper in the page</h4>
    <div class="row">
      <button class="st-btn" data-act="piper" disabled={busy} onclick={piper}>Read aloud with Piper</button>
    </div>
    <div class="st-sub">Voice {PIPER_VOICE}, ≈63 MB on first use</div>
  </section>

  <textarea bind:value={text} rows="3" aria-label="Text to read aloud"></textarea>

  {#if status}<div class="st-status" data-status>{status}</div>{/if}
  {#if live}
    <div class="run live">
      <div class="run-head">{live.engine}</div>
      <div class="run-text">{live.text || "…"}</div>
    </div>
  {/if}

  {#each runs as r, i (i + r.engine + (r.totalMs ?? 0))}
    <div class="run" data-run={r.engine}>
      <div class="run-head">{r.engine} <span class={r.supported ? "ok" : "bad"}>{r.supported ? "works" : "not supported"}</span></div>
      <table>
        <tbody>
          <tr><td>First word</td><td>{fmtMs(r.firstMs)}</td><td>Total</td><td>{fmtMs(r.totalMs)}</td></tr>
          <tr><td>Load</td><td>{fmtMs(r.loadMs)}</td><td>Downloaded</td><td>{fmtBytes(r.downloaded)}</td></tr>
        </tbody>
      </table>
      {#if r.text}<div class="run-text">{r.text.trim()}</div>{/if}
      {#if r.note}<div class="st-sub">{r.note}</div>{/if}
    </div>
  {/each}
  {#if runs.length}<button class="st-btn wide" onclick={copyAll}>Copy results</button>{/if}
</div>

<style>
  .st {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 14px;
    color: var(--ink);
  }
  .st-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .st-title {
    font-weight: 600;
    font-size: 17px;
  }
  .st-note,
  .st-sub {
    font-size: 13px;
    color: var(--dim);
    margin: 0;
  }
  .st-env {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 12px;
    color: var(--dim);
    margin: 0;
  }
  .st-env b {
    color: var(--ink2);
    font-weight: 500;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--well);
  }
  h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .st-btn {
    all: unset;
    cursor: pointer;
    min-height: 40px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    border: 1px solid var(--line2);
    font-size: 14px;
    box-sizing: border-box;
  }
  .st-btn.small {
    min-height: 32px;
    padding: 0 10px;
  }
  .st-btn.wide {
    width: 100%;
  }
  .st-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .st-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  select,
  textarea {
    font: inherit;
    font-size: 16px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 10px;
    padding: 6px 10px;
  }
  textarea {
    resize: vertical;
  }
  .st-status {
    font-size: 13px;
    color: var(--live);
  }
  .run {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .run.live {
    border-color: var(--live);
  }
  .run-head {
    font-weight: 600;
  }
  .run-head .ok {
    color: var(--done);
    font-weight: 500;
    margin-left: 6px;
  }
  .run-head .bad {
    color: var(--failed);
    font-weight: 500;
    margin-left: 6px;
  }
  .run-text {
    font-family: var(--mono);
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  table {
    border-collapse: collapse;
    font-size: 13px;
  }
  td {
    padding: 2px 10px 2px 0;
  }
  td:nth-child(odd) {
    color: var(--dim);
  }
</style>
