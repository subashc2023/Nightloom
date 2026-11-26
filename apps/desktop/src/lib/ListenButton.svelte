<script lang="ts">
  /**
   * Item 801: Listen and Brief under a reply, on a note, on a morning page —
   * the Mac's window and the phone's page alike (`source` says how this
   * host is asked). Listen reads it aloud in the host's Piper voice; Brief
   * first has the model rewrite it for the ear in under two minutes, ending
   * with what it left out. The player: play/pause, a scrub bar, the time,
   * the speed. The place (per thing) and the speed are kept; the audio is
   * kept for the session, so closing and opening again resumes at once.
   *
   * Item 862: the audio comes in parts (`listen.svelte.ts`) — playback
   * starts on the first, a few seconds after the press, and each next part
   * plays on from the one before in the same `<audio>`. The time is the
   * whole reading's; the total shows once every part has landed, and a
   * seek goes to the right part and place in it.
   */
  import { onDestroy } from "svelte";
  import { before, clock, listenKey, loadPlace, loadRate, nextSpeed, partAt, savePlace, saveRate, speedWords, textId, type Source } from "./listen";
  import { readingFor, type Reading } from "./listen.svelte";
  import { tip } from "./tip";

  let {
    kind,
    id,
    text,
    source,
  }: {
    kind: "reply" | "note" | "morning";
    id: string;
    /** The words to read, asked for when pressed (a note may have changed). */
    text: () => string;
    source: Source;
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
  let reading = $state<Reading | null>(null);
  let audio = $state<HTMLAudioElement | null>(null);
  /** The part in the `<audio>` now. */
  let cur = $state(0);
  /** Where to start in `cur` once it has loaded (a resume or a seek). */
  let startOffset = 0;
  /** Where the kept place says to start, seconds of the whole reading. */
  let resumeAt = 0;
  /** He wants it playing: a part that ends plays on into the next. */
  let wantPlay = false;
  /** The part that ended was the last one landed; the next is on its way. */
  let waiting = $state(false);
  let playing = $state(false);
  let within = $state(0);
  let rate = $state(loadRate(store()));
  let showWords = $state(false);
  const key = $derived(listenKey(kind, id, brief));
  const lengths = $derived(reading?.lengths ?? []);
  const known = $derived(before(lengths, lengths.length));
  const done = $derived(reading?.done ?? false);
  const at = $derived(before(lengths, cur) + within);
  const url = $derived(reading?.urls[cur]);

  function start(asBrief: boolean) {
    brief = asBrief;
    const words = text().trim();
    if (!words) {
      phase = "failed";
      why = "There is nothing to read aloud here";
      return;
    }
    why = "";
    const k = listenKey(kind, id, asBrief);
    // Cached by the words too, so a note edited since (or a morning page
    // rewritten) is read as it is now, not as it was.
    reading = readingFor(`${k}#${textId(words)}`, words, asBrief, source);
    resumeAt = loadPlace(store(), k);
    cur = 0;
    within = 0;
    waiting = false;
    wantPlay = true;
    phase = "making";
  }

  // Making → ready once the part holding the kept place has landed (the
  // first, for a fresh start); a failure before any audio is the failure.
  $effect(() => {
    if (phase !== "making" || !reading) return;
    const r = reading;
    const landed = r.urls.length;
    if (r.failed && landed === 0) {
      phase = "failed";
      why = r.failed;
      return;
    }
    const p = partAt(r.lengths, resumeAt);
    if (p.i < landed) {
      cur = p.i;
      startOffset = p.offset;
    } else if (r.done || r.failed) {
      cur = 0;
      startOffset = 0;
    } else return;
    phase = "ready";
  });

  // The part that ended was the last landed: play on when the next lands.
  $effect(() => {
    if (!waiting || !reading) return;
    if (reading.urls.length > cur + 1) {
      waiting = false;
      startOffset = 0;
      within = 0;
      cur = cur + 1;
    } else if (reading.failed) waiting = false;
  });

  function loaded() {
    if (!audio) return;
    audio.playbackRate = rate;
    if (startOffset > 0 && startOffset < audio.duration) audio.currentTime = startOffset;
    within = audio.currentTime;
    startOffset = 0;
    if (wantPlay) void audio.play().catch(() => (wantPlay = false));
  }
  let lastSave = 0;
  function timed() {
    if (!audio) return;
    within = audio.currentTime;
    const now = Date.now();
    if (now - lastSave > 2000) {
      lastSave = now;
      keep();
    }
  }
  /** Keep the place; near the end only counts once the total is known. */
  function keep() {
    if (phase === "ready" && reading) savePlace(store(), key, at, done ? known : 0);
  }
  function ended() {
    playing = false;
    if (!reading) return;
    if (cur + 1 < reading.urls.length) {
      startOffset = 0;
      within = 0;
      cur = cur + 1;
    } else if (!reading.done && !reading.failed) {
      waiting = true;
    } else {
      wantPlay = false;
      savePlace(store(), key, 0, known);
    }
  }
  function toggle() {
    if (!audio) return;
    if (audio.paused) {
      wantPlay = true;
      if (audio.ended && reading?.done && cur === reading.urls.length - 1) {
        // Played to the end: Play starts it over.
        if (cur === 0) audio.currentTime = 0;
        else {
          startOffset = 0;
          within = 0;
          cur = 0;
          return;
        }
      }
      void audio.play().catch(() => (wantPlay = false));
    } else {
      wantPlay = false;
      audio.pause();
    }
  }
  function speed() {
    rate = nextSpeed(rate);
    saveRate(store(), rate);
    if (audio) audio.playbackRate = rate;
  }
  function seek(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (!audio || !reading || !Number.isFinite(v)) return;
    const p = partAt(lengths, v);
    if (p.i >= reading.urls.length) return;
    waiting = false;
    if (p.i === cur) {
      audio.currentTime = p.offset;
      within = p.offset;
    } else {
      startOffset = p.offset;
      within = p.offset;
      cur = p.i;
    }
  }
  function close() {
    keep();
    audio?.pause();
    wantPlay = false;
    waiting = false;
    phase = "idle";
    reading = null;
    showWords = false;
  }
  onDestroy(keep);
</script>

<span class="listen" class:open={phase !== "idle"}>
  {#if phase === "idle"}
    <button class="lb" use:tip={"Read this aloud in the host's voice"} aria-label="Listen" onclick={() => start(false)}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h2.4L9 3v10L5.4 10H3Z" fill="currentColor" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.6 3.8a6 6 0 0 1 0 8.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
      Listen
    </button>
    <button class="lb" use:tip={"The model rewrites it for the ear in under two minutes, and says what it left out; then it is read aloud"} aria-label="Brief" onclick={() => start(true)}>Brief</button>
  {:else if phase === "making"}
    <span class="lstate" role="status"><span class="lspin" aria-hidden="true"></span>{brief && !reading?.words ? "Writing the Brief…" : "Preparing audio…"}</span>
    <button class="lx" aria-label="Close" use:tip={"Close"} onclick={close}>×</button>
  {:else if phase === "failed"}
    <span class="lstate lfail" role="alert">{why}</span>
    <button class="lx" aria-label="Close" use:tip={"Close"} onclick={close}>×</button>
  {:else if reading && url}
    <audio
      bind:this={audio}
      src={url}
      preload="auto"
      onloadedmetadata={loaded}
      ontimeupdate={timed}
      onplay={() => (playing = true)}
      onpause={() => {
        playing = false;
        keep();
      }}
      onended={ended}
    ></audio>
    <button class="lb lplay" aria-label={playing || waiting ? "Pause" : "Play"} use:tip={playing || waiting ? "Pause" : "Play"} onclick={toggle}>
      {#if playing || waiting}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3h2.4v10H4.5ZM9.1 3h2.4v10H9.1Z" fill="currentColor" /></svg>
      {:else}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3l8 5-8 5Z" fill="currentColor" /></svg>
      {/if}
    </button>
    <input class="lseek" type="range" min="0" max={known || 0} step="0.1" value={at} oninput={seek} aria-label="Position" />
    <span class="ltime" use:tip={done ? "" : "The rest is still being made"}>{clock(at)} / {done ? clock(known) : "…"}</span>
    {#if waiting}<span class="lstate" role="status"><span class="lspin" aria-hidden="true"></span></span>{/if}
    <button class="lb" use:tip={"Speed"} aria-label="Speed {speedWords(rate)}" onclick={speed}>{speedWords(rate)}</button>
    {#if brief && reading.words}
      <button class="lb" class:on={showWords} use:tip={"The Brief's words"} aria-expanded={showWords} onclick={() => (showWords = !showWords)}>Words</button>
    {/if}
    <button class="lx" aria-label="Close the player" use:tip={"Close (the place is kept)"} onclick={close}>×</button>
  {/if}
</span>
{#if phase === "ready" && showWords && reading?.words}
  <p class="lwords">{reading.words}</p>
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
  /* Item 1010: idle, Listen and Brief keep their own width (a flex item with
     min-width 0 was squeezed into the Redo beside it). */
  .listen:not(.open) {
    flex: none;
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
