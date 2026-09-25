<script lang="ts">
  import { tip } from "./tip";
  import Icon from "./Icon.svelte";
  import type { Tick } from "./navigator";

  /**
   * The message navigator (nightshift backlog 065, 2026-09-15): a thin
   * strip at the transcript's right edge, a chevron at each end — top of
   * the chat, bottom of the chat (which re-pins) — and between them one
   * short tick per message, wider for a longer one, the one being read
   * bright and full width. Click a tick and the transcript scrolls to that
   * message; rest on one and a bubble to the left says how it starts.
   *
   * A view and nothing else: `Transcript.svelte` owns the viewport, works
   * out which tick is being read, and scrolls. This draws what it is told
   * and reports clicks. Hidden by the parent under four messages or when
   * the viewport does not scroll — a map of three rows is clutter.
   *
   * The picture is LibreChat's rail (their `MessageNav.tsx`), from the
   * screenshot he sent; the drawing is this app's tokens.
   */
  let {
    ticks,
    active,
    onjump,
    ontop,
    onbottom,
  }: {
    ticks: Tick[];
    /** Index into `ticks` of the message being read, or null. */
    active: number | null;
    onjump: (i: number) => void;
    ontop: () => void;
    onbottom: () => void;
  } = $props();

  let root = $state<HTMLDivElement | null>(null);
  /** The tick under the pointer and its centre line, in the strip's own space. */
  let hover = $state<{ i: number; y: number } | null>(null);

  function enter(e: PointerEvent, i: number) {
    if (!root) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const top = root.getBoundingClientRect().top;
    hover = { i, y: r.top + r.height / 2 - top };
  }
</script>

<div class="nav" bind:this={root} role="navigation" aria-label="Messages" onpointerleave={() => (hover = null)}>
  <button class="chev" use:tip={"Top of the chat"} aria-label="Scroll to the top" onclick={ontop}>
    <span class="up"><Icon name="chev" size={12} /></span>
  </button>
  <div class="ticks" style:--n={ticks.length}>
    {#each ticks as t, i (t.index)}
      <button
        class="tick"
        class:user={t.role === "user"}
        class:active={i === active}
        aria-label={`${t.role === "user" ? "You" : "Reply"}: ${t.first_line || "(no text)"}`}
        aria-current={i === active ? "true" : undefined}
        onpointerenter={(e) => enter(e, i)}
        onclick={() => onjump(i)}
      >
        <i style:width="{Math.round(t.weight * 100)}%"></i>
      </button>
    {/each}
  </div>
  <button class="chev" use:tip={"Bottom of the chat — and follow the reply again"} aria-label="Scroll to the bottom" onclick={onbottom}>
    <Icon name="chev" size={12} />
  </button>
  {#if hover && ticks[hover.i]}
    <div class="bubble" class:user={ticks[hover.i].role === "user"} style:top="{hover.y}px" role="tooltip">
      <span class="who">{ticks[hover.i].role === "user" ? "You" : "Reply"}</span>
      <span class="line">{ticks[hover.i].first_line || "(no text)"}</span>
    </div>
  {/if}
</div>

<style>
  /* Positioned by the parent's `.content`, which is exactly the transcript's
     area: below the top bar, above the composer. */
  .nav {
    position: absolute;
    top: 10px;
    bottom: 10px;
    right: 3px;
    width: 16px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    z-index: 4;
    color: var(--dim);
  }
  .chev {
    flex: none;
    height: 16px;
    padding: 0;
    background: none;
    border: none;
    color: var(--dim);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }
  .chev:hover {
    color: var(--ink);
    background: var(--well);
  }
  .up {
    display: inline-flex;
    transform: rotate(180deg);
  }
  /* One grid row per tick, at most 7px each; when the chat has more rows
     than the strip has height the rows share it evenly, down to 1px, so a
     long chat is a denser strip and not a clipped one. */
  .ticks {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-rows: repeat(var(--n), minmax(1px, 7px));
    align-content: center;
    padding: 4px 0;
  }
  .tick {
    width: 100%;
    height: 100%;
    min-height: 1px;
    padding: 0;
    background: none;
    border: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    cursor: pointer;
    color: var(--accent);
    opacity: 0.55;
  }
  .tick.user {
    color: var(--ink2);
    opacity: 0.4;
  }
  .tick i {
    display: block;
    height: 2px;
    max-height: 100%;
    border-radius: 1px;
    background: currentColor;
    transition:
      width 0.12s,
      height 0.12s;
  }
  .tick:hover {
    opacity: 1;
  }
  .tick:hover i {
    width: 100% !important;
  }
  .tick.active {
    opacity: 1;
    color: var(--ink);
  }
  .tick.active i {
    width: 100% !important;
    height: 3px;
  }
  /* The bubble: to the left of the strip, on the tick's line, two lines of
     the message at most. */
  .bubble {
    position: absolute;
    right: calc(100% + 6px);
    transform: translateY(-50%);
    width: max-content;
    max-width: 280px;
    padding: 6px 10px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 8px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    font-family: var(--sans);
    font-size: 12px;
    line-height: 1.35;
    color: var(--ink2);
    pointer-events: none;
  }
  .who {
    display: block;
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 2px;
  }
  .bubble.user .who {
    color: var(--dim);
  }
  .line {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
</style>
