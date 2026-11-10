<script lang="ts">
  /**
   * The context dial (item 533, Filament IV stage 2; 521 report §2): one
   * SVG — a tick scale, the track, the used arc (amber, orange past the
   * notch), the notch at the hand-off line, a round head, a thin blue
   * inner arc for the prompt cache's time left — and a figure in the
   * middle. A share of a limit, sizes as props, so the new-chat page
   * (stage 4), Settings → Usage and Nightshift (stage 9) reuse it.
   *
   * Motion: the arc eases to a new length in 300 ms and the head turns
   * with it; nothing loops, so an idle dial is still. Under
   * `prefers-reduced-motion: reduce` every change is instant. The lit
   * level's glow on the arc and head is `--glow-accent` read as a
   * drop-shadow: `none` in calm and the Classic palettes makes the filter
   * invalid, so it draws no filter at all there.
   */
  import { dialGeometry } from "./contextDial";

  interface Props {
    /** Track diameter, px. */
    size?: number;
    /** Share of the limit used, 0..1. */
    share: number;
    /** The notch, 0..1; null for none. */
    mark?: number | null;
    /** The inner arc's share, 0..1; null draws no inner ring. */
    inner?: number | null;
    /** The figure in the middle and the line under it; empty draws none. */
    value?: string;
    unit?: string;
    stroke?: number;
    pad?: number;
    minor?: number;
    major?: number;
    /** Read aloud in place of the drawing. */
    label: string;
  }

  let {
    size = 104,
    share,
    mark = null,
    inner = null,
    value = "",
    unit = "",
    stroke = 5,
    pad = 14,
    minor = 50,
    major = 10,
    label,
  }: Props = $props();

  const g = $derived(dialGeometry({ size, share, mark, inner, stroke, pad, minor, major }));
</script>

<div class="dial" style:width="{g.box}px" style:height="{g.box}px" role="img" aria-label={label}>
  <svg width={g.box} height={g.box} viewBox="0 0 {g.box} {g.box}" aria-hidden="true">
    <g transform="rotate(-90 {g.mid} {g.mid})" fill="none">
      {#if g.minorDash}
        <circle class="tick" cx={g.mid} cy={g.mid} r={g.minorRing.r} stroke-width="3" stroke-dasharray={g.minorDash} stroke-dashoffset="0.5" />
      {/if}
      {#if g.majorDash}
        <circle class="tick major" cx={g.mid} cy={g.mid} r={g.majorRing.r} stroke-width="5" stroke-dasharray={g.majorDash} stroke-dashoffset="0.7" />
      {/if}
      <circle class="track" cx={g.mid} cy={g.mid} r={g.track.r} stroke-width={g.stroke} />
      <circle
        class="arc cool"
        cx={g.mid}
        cy={g.mid}
        r={g.track.r}
        stroke-width={g.stroke}
        style:stroke-dasharray="{g.cool} {g.track.c}"
        style:opacity={g.cool > 0 ? 1 : 0}
      />
      <circle
        class="arc hot"
        cx={g.mid}
        cy={g.mid}
        r={g.track.r}
        stroke-width={g.stroke}
        style:stroke-dasharray="{g.hot} {g.track.c}"
        stroke-dashoffset={g.hotOffset}
        style:opacity={g.hot > 0 ? 1 : 0}
      />
      {#if g.inner != null}
        <circle class="inner-track" cx={g.mid} cy={g.mid} r={g.innerRing.r} stroke-width="2" />
        {#if g.inner > 0}
          <circle class="inner" cx={g.mid} cy={g.mid} r={g.innerRing.r} stroke-width="2" stroke-dasharray="{g.inner} {g.innerRing.c}" />
        {/if}
      {/if}
    </g>
    {#if g.notch}
      <line class="notch" x1={g.notch.x1} y1={g.notch.y1} x2={g.notch.x2} y2={g.notch.y2} stroke-width="1.5" />
    {/if}
    <g class="turn" style:transform="rotate({g.headDeg}deg)" style:transform-origin="{g.mid}px {g.mid}px">
      <circle class="head" class:past={g.past} cx={g.mid} cy={g.mid - g.track.r} r={g.headR} />
    </g>
  </svg>
  {#if value || unit}
    <div class="c">
      {#if value}<span class="n">{value}</span>{/if}
      {#if unit}<span class="u">{unit}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .dial {
    position: relative;
    flex: none;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .tick {
    stroke: var(--line2);
  }
  .tick.major {
    stroke: var(--dim);
  }
  .track {
    stroke: var(--well);
  }
  .arc.cool {
    stroke: var(--accent);
    filter: drop-shadow(var(--glow-accent));
  }
  .arc.hot {
    stroke: var(--hot);
  }
  .inner-track {
    stroke: var(--line);
  }
  .inner {
    stroke: var(--signal);
  }
  .notch {
    stroke: var(--ink);
  }
  .head {
    fill: var(--accent-ink);
    filter: drop-shadow(var(--glow-accent));
  }
  .head.past {
    fill: var(--hot);
  }
  .c {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    pointer-events: none;
  }
  .n {
    font: 500 23px var(--sans);
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    color: var(--ink);
  }
  .u {
    font: 10.5px var(--mono);
    color: var(--dim);
    margin-top: 4px;
  }
  /* The one motion: a reading's change, eased once. Nothing here loops. */
  @media (prefers-reduced-motion: no-preference) {
    .arc {
      transition:
        stroke-dasharray 300ms ease,
        opacity 300ms ease;
    }
    .turn {
      transition: transform 300ms ease;
    }
  }
</style>
