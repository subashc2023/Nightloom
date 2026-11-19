<script lang="ts">
  /**
   * Item 801: Listen and Brief under a reply, on a note, on a morning page —
   * the Mac's window and the phone's page alike (`make` says how this host
   * is asked). Listen reads it aloud in the host's Piper voice; Brief first
   * has the model rewrite it for the ear in under two minutes, ending with
   * what it left out. The player: play/pause, a scrub bar, the time, the
   * speed. The place (per thing) and the speed are kept; the audio is kept
   * for the session, so closing and opening again resumes without waiting.
   */
  import { onDestroy } from "svelte";
  import { clock, failWords, listenKey, loadPlace, loadRate, nextSpeed, savePlace, saveRate, speedWords } from "./listen";
  import { audioFor, type Made } from "./listen.svelte";
  import { tip } from "./tip";

  let {
    kind,
    id,
    text,
    make,
  }: {
    kind: "reply" | "note" | "morning";
    id: string;
    /** The words to read, asked for when pressed (a note may have changed). */
    text: () => string;
    make: (text: string, brief: boolean) => Promise<{ blob: Blob; words?: string }>;
  } = $props();

  const store = (): Storage | null => {
    try {
      return localStorage;
    } catch {
      return null;
    }
  };

  let brief = $state(false);
  let phase = $state<"idle" | "making" | "ready" | "failed">("idle");
  let why = $state("");
  let got = $state<Made | null>(null);
  let audio = $state<HTMLAudioElement | null>(null);
  let playing = $state(false);
  let at = $state(0);
  let length = $state(0);
  let rate = $state(loadRate(store()));
  let showWords = $state(false);
  const key = $derived(listenKey(kind, id, brief));

  async function start(asBrief: boolean) {
    brief = asBrief;
    const words = text().trim();
    if (!words) {
      phase = "failed";
      why = "There is nothing to read aloud here";
      return;
    }
    phase = "making";
    why = "";
    try {
      const k = listenKey(kind, id, asBrief);
      got = await audioFor(k, () => make(words, asBrief));
      if (k !== key) return;
      phase = "ready";
    } catch (e) {
      phase = "failed";
      why = failWords(e);
    }
  }

  function loaded() {
    if (!audio) return;
    length = audio.duration;
    audio.playbackRate = rate;
    const t = loadPlace(store(), key);
    if (t > 0 && t < audio.duration) audio.currentTime = t;
    void audio.play().catch(() => {});
  }
  let lastSave = 0;
  function timed() {
    if (!audio) return;
    at = audio.currentTime;
    const now = Date.now();
    if (now - lastSave > 2000) {
      lastSave = now;
      savePlace(store(), key, at, length);
    }
  }
  function keep() {
    if (audio) savePlace(store(), key, audio.currentTime, length);
  }
  function toggle() {
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  }
  function speed() {
    rate = nextSpeed(rate);
    saveRate(store(), rate);
    if (audio) audio.playbackRate = rate;
  }
  function seek(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (audio && Number.isFinite(v)) audio.currentTime = v;
  }
  function close() {
    keep();
    audio?.pause();
    phase = "idle";
    got = null;
    showWords = false;
  }
  onDestroy(keep);
</script>

<span class="listen" class:open={phase !== "idle"}>
  {#if phase === "idle"}
    <button class="lb" use:tip={"Read this aloud in the host's voice"} aria-label="Listen" onclick={() => void start(false)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h2.4L9 3v10L5.4 10H3Z" fill="currentColor" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.6 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
      Listen
    </button>
    <button class="lb" use:tip={"The model rewrites it for the ear in under two minutes, and says what it left out; then it is read aloud"} aria-label="Brief" onclick={() => void start(true)}>Brief</button>
  {:else if phase === "making"}
    <span class="lstate" role="status"><span class="lspin" aria-hidden="true"></span>{brief ? "Writing the Brief, then the audio…" : "Preparing audio…"}</span>
    <button class="lx" aria-label="Close" use:tip={"Close"} onclick={close}>×</button>
  {:else if phase === "failed"}
    <span class="lstate lfail" role="alert">{why}</span>
    <button class="lx" aria-label="Close" use:tip={"Close"} onclick={close}>×</button>
  {:else if got}
    <audio
      bind:this={audio}
      src={got.url}
      preload="auto"
      onloadedmetadata={loaded}
      ontimeupdate={timed}
      onplay={() => (playing = true)}
      onpause={() => {
        playing = false;
        keep();
      }}
      onended={() => {
        playing = false;
        savePlace(store(), key, 0, length);
      }}
    ></audio>
    <button class="lb lplay" aria-label={playing ? "Pause" : "Play"} use:tip={playing ? "Pause" : "Play"} onclick={toggle}>
      {#if playing}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3h2.4v10H4.5ZM9.1 3h2.4v10H9.1Z" fill="currentColor" /></svg>
      {:else}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3l8 5-8 5Z" fill="currentColor" /></svg>
      {/if}
    </button>
    <input class="lseek" type="range" min="0" max={length || 0} step="0.1" value={at} oninput={seek} aria-label="Position" />
    <span class="ltime">{clock(at)} / {clock(length)}</span>
    <button class="lb" use:tip={"Speed"} aria-label="Speed {speedWords(rate)}" onclick={speed}>{speedWords(rate)}</button>
    {#if brief && got.words}
      <button class="lb" class:on={showWords} use:tip={"The Brief's words"} aria-expanded={showWords} onclick={() => (showWords = !showWords)}>Words</button>
    {/if}
    <button class="lx" aria-label="Close the player" use:tip={"Close (the place is kept)"} onclick={close}>×</button>
  {/if}
</span>
{#if phase === "ready" && showWords && got?.words}
  <p class="lwords">{got.words}</p>
{/if}

<style>
  .listen {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
    font-size: 0.72rem;
    color: var(--dim);
  }
  .listen.open {
    flex: 1 1 14rem;
  }
  .lb,
  .lx {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--dim);
    font: inherit;
    padding: 0.15rem 0.4rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .lb:hover,
  .lx:hover,
  .lb.on {
    color: var(--text, var(--ink));
    border-color: var(--border, var(--line));
  }
  .lb svg {
    width: 12px;
    height: 12px;
  }
  .lseek {
    flex: 1;
    min-width: 4rem;
    accent-color: var(--accent);
  }
  .ltime {
    font-family: var(--mono, monospace);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .lstate {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }
  .lfail {
    color: var(--error);
  }
  .lspin {
    width: 11px;
    height: 11px;
    box-sizing: border-box;
    border: 1.5px solid color-mix(in srgb, var(--dim) 45%, transparent);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: lspin 0.8s linear infinite;
  }
  @keyframes lspin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .lspin {
      animation: none;
    }
  }
  .lwords {
    margin: 0.35rem 0 0;
    font-size: 0.8rem;
    line-height: 1.45;
    color: var(--text, var(--ink));
    white-space: pre-wrap;
  }
</style>
