<script lang="ts" module>
  let maskSeq = 0;
</script>

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
   *
   * Item 574 (optional, the new-chat page only): `parts` draws the used
   * arc as named parts — each a muted shade of the accent or the dim ink,
   * each naming itself on hover or focus — and the caller drives their
   * lengths (the sweep and the re-flow are tweened there, so the CSS
   * transitions stand down); `pulse` breathes the ticks and the notch
   * slowly while the page is at rest. Neither moves under reduced motion.
   * Every other use passes neither and draws as before.
   *
   * Item 574b ("is there no movement on this dial"): `ring` draws the same
   * parts again on an inner ring of their own scale (100k, or a hand-off
   * mark under 200k), so 38k fills ~38% of it instead of 14° of the 1M
   * ring; and `pulse` now also sends one faint light round the track every
   * 8 s and breathes a glow on the inner arc's leading end.
   *
   * Item 578 ("doesnt really look so good especially when its small"):
   * under 40 px (the top bar's 13 px, the phone's 30 px) the ticks, the
   * notch and the head are dropped — at that size they read as a stray dot
   * and a dash — and the dial is a clean thin ring with a round-capped arc.
   *
   * Item 654 (his pick B3, blocker 1962): `drive` — the right column's dial,
   * drawn frame by frame from `dialDrive.ts` while a reply runs and as it
   * lands: the estimate's tail marches, the used ticks tint and the next one
   * fills, the head beats, the track breathes, and at the end a light runs
   * the arc to the real figure, lighting the ticks it passes, the head
   * ripples, the notch flares and the cache ring swells. The caller passes
   * the drive's `solid` as `share`; the CSS transitions stand down (the
   * drive eases). Every other use passes none and draws as before.
   */
  import { dialGeometry } from "./contextDial";
  import type { DialView } from "./dialDrive";
  import { tip } from "./tip";
  import type { StartArc } from "./startDial";

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
    /** The used arc as named parts (item 574); null draws the one arc. */
    parts?: StartArc[] | null;
    /** A slow, faint breath on the ticks and the notch (item 574). */
    pulse?: boolean;
    /** The parts again on an inner ring of their own scale (574b); shares of that scale. */
    ring?: StartArc[] | null;
    /**
     * Item 590: the used arc's estimated tail, as a share of the limit (the
     * last `estimate` of `share`), drawn in a lighter tone that breathes
     * while a reply streams; null (the default) draws none.
     */
    estimate?: number | null;
    /** Item 654: the frame-by-frame layer (the right column's dial); null draws none. */
    drive?: DialView | null;
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
    parts = null,
    pulse = false,
    ring = null,
    estimate = null,
    drive = null,
  }: Props = $props();

  /** Item 578: the small form, below this size. */
  const SMALL = 40;
  const small = $derived(size < SMALL);
  const g = $derived(
    dialGeometry({ size, share, mark, inner, stroke, pad, minor: small ? 0 : minor, major: small ? 0 : major }),
  );
  const driven = $derived(!!parts && parts.length > 0);
  /** A hair of ground between two parts, so each reads as its own. */
  const GAP = 1.2;
  const drawn = $derived(
    (parts ?? []).map((p, i, all) => {
      const len = Math.max(0, p.share * g.track.c - (i < all.length - 1 ? GAP : 0));
      return { ...p, len, off: -p.from * g.track.c };
    }),
  );
  /** Hit bands: at least 12 px along the track, centred on the part, so a
   *  thin part can still be pointed at; later (smaller) parts on top. */
  const hits = $derived(
    drawn.map((p) => {
      const need = 12;
      const len = Math.max(p.len, need);
      return { ...p, hitLen: len, hitOff: p.off + (len - p.len) / 2 };
    }),
  );
  let hover = $state<number | null>(null);
  /** Item 590: the estimated tail's length and where it starts along the track. */
  const est = $derived.by(() => {
    if (estimate == null || estimate <= 0 || driven) return null;
    const s = Math.max(0, Math.min(1, share));
    const e = Math.min(estimate, s);
    return { len: e * g.track.c, off: -(s - e) * g.track.c };
  });
  /** Item 654: the drive's layer, never on the small form. */
  const dv = $derived(drive && !small ? drive : null);
  const maskId = `dial-tail-${++maskSeq}`;
  /** One radial line per minor tick, lit by the drive; majors reach further. */
  const litLines = $derived.by(() => {
    if (!dv || !g.minorDash || minor <= 0) return [];
    const per = major > 0 ? Math.max(1, Math.round(minor / major)) : 0;
    const out: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    for (let i = 0; i < minor; i++) {
      const a = (i / minor) * 2 * Math.PI;
      const isMajor = per > 0 && i % per === 0;
      const r1 = g.minorRing.r - 1.5;
      const r2 = isMajor ? g.majorRing.r + 2.5 : g.minorRing.r + 1.5;
      out.push({ x1: g.mid + r1 * Math.sin(a), y1: g.mid - r1 * Math.cos(a), x2: g.mid + r2 * Math.sin(a), y2: g.mid - r2 * Math.cos(a), major: isMajor });
    }
    return out;
  });
  const tail = $derived.by(() => {
    if (!dv) return null;
    const from = Math.max(0, Math.min(1, dv.tailFrom));
    const len = Math.max(0, (Math.min(1, dv.tailTo) - from) * g.track.c);
    return len > 0.05 ? { len, off: -from * g.track.c } : null;
  });
  /** The light's segment: a tenth of the track, at most 32 px, ending at its angle. */
  const seg = $derived(Math.min(g.track.c * 0.1, 32));
  /** The inner ring (574b): inside the track by the ticks' depth, bolder than it. */
  const ringR = $derived(Math.max(8, g.track.r - Math.max(10, g.stroke * 4)));
  const ringW = $derived(Math.max(3, Math.round(g.stroke * 1.8)));
  const ringC = $derived(2 * Math.PI * ringR);
  const ringDrawn = $derived(
    (ring ?? []).map((p, i, all) => {
      const len = Math.max(0, p.share * ringC - (i < all.length - 1 ? GAP : 0));
      const need = 12;
      const hitLen = Math.max(len, need);
      return { ...p, len, off: -p.from * ringC, hitLen, hitOff: -p.from * ringC + (hitLen - len) / 2 };
    }),
  );
  /** The inner arc's leading end, where its glow breathes. */
  const ringEnd = $derived.by(() => {
    if (!ring || ring.length === 0) return null;
    const last = ring[ring.length - 1];
    const t = (last.from + last.share) * 2 * Math.PI;
    return { x: g.mid + ringR * Math.sin(t), y: g.mid - ringR * Math.cos(t) };
  });
</script>

<div
  class="dial"
  class:driven
  class:pulse
  class:pointing={hover != null}
  class:small
  class:framed={!!dv}
  style:width="{g.box}px"
  style:height="{g.box}px"
  role={driven ? "group" : "img"}
  aria-label={label}
>
  <svg width={g.box} height={g.box} viewBox="0 0 {g.box} {g.box}" aria-hidden="true">
    <g transform="rotate(-90 {g.mid} {g.mid})" fill="none">
      {#if g.minorDash}
        <circle class="tick" cx={g.mid} cy={g.mid} r={g.minorRing.r} stroke-width="3" stroke-dasharray={g.minorDash} stroke-dashoffset="0.5" />
      {/if}
      {#if g.majorDash}
        <circle class="tick major" cx={g.mid} cy={g.mid} r={g.majorRing.r} stroke-width="5" stroke-dasharray={g.majorDash} stroke-dashoffset="0.7" />
      {/if}
      <circle class="track" cx={g.mid} cy={g.mid} r={g.track.r} stroke-width={g.stroke} />
      {#if dv && dv.wash > 0}
        <circle class="wash" cx={g.mid} cy={g.mid} r={g.track.r} stroke-width={g.stroke} opacity={dv.wash} />
      {/if}
      {#if driven}
        {#each drawn as p, i (p.tone)}
          <circle
            class="part {p.tone}"
            class:lit={hover === i}
            cx={g.mid}
            cy={g.mid}
            r={g.track.r}
            stroke-width={g.stroke + (hover === i ? 2 : 0)}
            stroke-dasharray="{p.len} {g.track.c}"
            stroke-dashoffset={p.off}
          />
        {/each}
        {#if ring && ring.length > 0}
          <circle class="ring-track" cx={g.mid} cy={g.mid} r={ringR} stroke-width={ringW} />
          {#each ringDrawn as p (p.tone)}
            <circle
              class="part {p.tone}"
              class:lit={hover === drawn.findIndex((d) => d.tone === p.tone)}
              cx={g.mid}
              cy={g.mid}
              r={ringR}
              stroke-width={ringW + (hover === drawn.findIndex((d) => d.tone === p.tone) ? 2 : 0)}
              stroke-dasharray="{p.len} {ringC}"
              stroke-dashoffset={p.off}
            />
          {/each}
        {/if}
      {:else}
      <circle
        class="arc cool"
        cx={g.mid}
        cy={g.mid}
        r={g.track.r}
        stroke-width={g.stroke}
        style:stroke-dasharray="{g.cool} {g.track.c}"
        style:opacity={g.cool > 0 ? 1 : 0}
      />
      {/if}
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
      {#if est}
        <circle
          class="arc est"
          cx={g.mid}
          cy={g.mid}
          r={g.track.r}
          stroke-width={g.stroke}
          style:stroke-dasharray="{est.len} {g.track.c}"
          style:stroke-dashoffset={est.off}
        />
      {/if}
      {#if dv && tail}
        {#if dv.march}
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={g.box} height={g.box}>
            <circle
              cx={g.mid}
              cy={g.mid}
              r={g.track.r}
              stroke="#fff"
              stroke-width={g.stroke + 2}
              stroke-dasharray="{tail.len} {g.track.c}"
              stroke-dashoffset={tail.off}
            />
          </mask>
          <circle
            class="arc march"
            cx={g.mid}
            cy={g.mid}
            r={g.track.r}
            stroke-width={g.stroke}
            stroke-dasharray="3 2.6"
            stroke-dashoffset={-dv.marchOff}
            mask="url(#{maskId})"
            opacity={dv.tailAlpha}
          />
        {:else}
          <circle
            class="arc est"
            cx={g.mid}
            cy={g.mid}
            r={g.track.r}
            stroke-width={g.stroke}
            stroke-dasharray="{tail.len} {g.track.c}"
            stroke-dashoffset={tail.off}
            opacity={dv.tailAlpha}
          />
        {/if}
      {/if}
      {#if g.inner != null}
        <circle class="inner-track" cx={g.mid} cy={g.mid} r={g.innerRing.r} stroke-width="2" />
        {#if g.inner > 0}
          <circle class="inner" cx={g.mid} cy={g.mid} r={g.innerRing.r} stroke-width={2 + (dv?.innerSwell ?? 0)} stroke-dasharray="{g.inner} {g.innerRing.c}" />
        {/if}
      {/if}
    </g>
    {#if pulse && driven}
      <!-- 574b: one faint light round the track every 8 s, at rest. -->
      <g class="light" style:transform-origin="{g.mid}px {g.mid}px">
        <circle
          cx={g.mid}
          cy={g.mid}
          r={g.track.r}
          stroke-width={g.stroke + 1}
          fill="none"
          stroke-linecap="round"
          stroke-dasharray="{g.track.c * 0.06} {g.track.c}"
          transform="rotate(-90 {g.mid} {g.mid})"
        />
      </g>
    {/if}
    {#if ringEnd}
      <circle class="ring-end" class:pulse cx={ringEnd.x} cy={ringEnd.y} r={ringW * 0.9} />
    {/if}
    {#if dv}
      <!-- Item 654: the lit scale, one line per minor tick (opacity from the drive). -->
      {#each litLines as l, i (i)}
        <line class="lit" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke-width={l.major ? 1.6 : 1.2} opacity={dv.ticks[i] ?? 0} />
      {/each}
      {#if dv.lightAlpha > 0}
        <!-- Item 654: the landing's light, its segment ending at its angle. -->
        <g class="run" style:transform="rotate({dv.light * 360}deg)" style:transform-origin="{g.mid}px {g.mid}px" style:opacity={dv.lightAlpha}>
          <circle
            cx={g.mid}
            cy={g.mid}
            r={g.track.r}
            stroke-width={g.stroke + 2}
            fill="none"
            stroke-linecap="round"
            stroke-dasharray="{seg} {g.track.c - seg}"
            stroke-dashoffset={seg}
            transform="rotate(-90 {g.mid} {g.mid})"
          />
        </g>
      {/if}
    {/if}
    {#if g.notch && !small}
      <line
        class="notch"
        class:flare={(dv?.notchFlare ?? 0) > 0.05}
        x1={g.notch.x1}
        y1={g.notch.y1}
        x2={g.notch.x2}
        y2={g.notch.y2}
        stroke-width={1.5 + 1.5 * (dv?.notchFlare ?? 0)}
      />
    {/if}
    {#if dv && dv.ripple > 0}
      <g class="turn" style:transform="rotate({dv.rippleAt * 360}deg)" style:transform-origin="{g.mid}px {g.mid}px">
        <circle class="ripple" cx={g.mid} cy={g.mid - g.track.r} r={g.headR} style:opacity={dv.ripple} style:transform="scale({dv.rippleScale})" />
      </g>
    {/if}
    {#if !small}
    <g class="turn" style:transform="rotate({dv ? dv.head * 360 : g.headDeg}deg)" style:transform-origin="{g.mid}px {g.mid}px">
      <circle
        class="head"
        class:past={dv ? mark != null && dv.head > mark : g.past}
        cx={g.mid}
        cy={g.mid - g.track.r}
        r={g.headR}
        style:transform={dv && dv.headScale > 1.005 ? `scale(${dv.headScale})` : null}
      />
    </g>
    {/if}
    {#if driven}
      <!-- Hit bands for the parts: wide, clear strokes over the track. -->
      <g transform="rotate(-90 {g.mid} {g.mid})" fill="none">
        {#each hits as p, i (p.tone)}
          <circle
            class="hit"
            role="button"
            tabindex="0"
            aria-label={p.tip}
            cx={g.mid}
            cy={g.mid}
            r={g.track.r}
            stroke-width={Math.max(18, g.stroke * 4)}
            stroke-dasharray="{p.hitLen} {g.track.c}"
            stroke-dashoffset={p.hitOff}
            use:tip={p.tip}
            onpointerenter={() => (hover = i)}
            onpointerleave={() => (hover = null)}
            onfocus={() => (hover = i)}
            onblur={() => (hover = null)}
          />
        {/each}
        {#each ringDrawn as p (p.tone)}
          <circle
            class="hit"
            role="button"
            tabindex="0"
            aria-label={p.tip}
            cx={g.mid}
            cy={g.mid}
            r={ringR}
            stroke-width={Math.max(12, ringW * 3)}
            stroke-dasharray="{p.hitLen} {ringC}"
            stroke-dashoffset={p.hitOff}
            use:tip={p.tip}
            onpointerenter={() => (hover = drawn.findIndex((d) => d.tone === p.tone))}
            onpointerleave={() => (hover = null)}
            onfocus={() => (hover = drawn.findIndex((d) => d.tone === p.tone))}
            onblur={() => (hover = null)}
          />
        {/each}
      </g>
    {/if}
  </svg>
  {#if value || unit}
    <div class="c">
      {#if value}<span class="n" class:dimmed={!!dv?.estimating}>{value}</span>{/if}
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
  /* Item 590: the estimate since the last exact step — the accent, lighter. */
  .arc.est {
    stroke: color-mix(in srgb, var(--accent) 45%, var(--well));
  }
  .inner-track {
    stroke: var(--line);
  }
  /* Item 654: the drive's layer — the marching tail, the lit ticks, the
     track's breath, the landing's light and ripple. */
  .arc.march {
    stroke: var(--accent);
  }
  .wash {
    stroke: var(--accent);
  }
  .lit {
    stroke: var(--accent-ink);
  }
  .run circle {
    stroke: var(--accent-ink);
    filter: drop-shadow(var(--glow-accent));
  }
  .ripple {
    fill: none;
    stroke: var(--accent-ink);
    stroke-width: 1.4;
    transform-box: fill-box;
    transform-origin: center;
  }
  .framed .head {
    transform-box: fill-box;
    transform-origin: center;
  }
  .notch.flare {
    stroke: var(--accent-ink);
  }
  .n.dimmed {
    color: var(--ink2);
  }
  /* Item 574's parts: muted shades of the tokens already in the palette —
     amber is his (Nightloom's layers, his instruction files and memory),
     the dim ink is Claude Code's own. */
  .part.claude_code {
    stroke: color-mix(in srgb, var(--dim) 72%, var(--well));
  }
  .part.layer {
    stroke: var(--accent);
    filter: drop-shadow(var(--glow-accent));
  }
  .part.instructions {
    stroke: color-mix(in srgb, var(--accent) 62%, var(--well));
  }
  .part.memory {
    stroke: color-mix(in srgb, var(--accent) 40%, var(--ink));
  }
  .ring-track {
    stroke: color-mix(in srgb, var(--well) 70%, transparent);
  }
  .ring-end {
    fill: var(--accent-ink);
    filter: drop-shadow(var(--glow-accent));
  }
  /* The travelling light shows only where motion is allowed (below). */
  .light {
    display: none;
  }
  .light circle {
    stroke: var(--accent);
    opacity: 0.3;
  }
  /* 578: the small form — a thin quiet track and a round-capped arc. */
  .small .track {
    stroke: color-mix(in srgb, var(--dim) 45%, transparent);
  }
  .small .arc {
    stroke-linecap: round;
  }
  .pointing .part:not(.lit) {
    opacity: 0.45;
  }
  .hit {
    stroke: transparent;
    pointer-events: stroke;
    cursor: default;
    outline: none;
  }
  .hit:focus-visible {
    stroke: color-mix(in srgb, var(--accent) 22%, transparent);
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
    /* At rest (item 574): the scale and the notch breathe, once every
       5.6 s, between full and three-quarters — calm, not busy. */
    .pulse .tick,
    .pulse .notch {
      animation: dial-breathe 5.6s ease-in-out infinite;
    }
    .pulse .tick.major {
      animation-delay: -2.8s;
    }
    /* 574b: a faint light travels the ring once every 8 s, and the inner
       arc's leading end breathes its glow — at rest, never busy. */
    .pulse .light {
      display: inline;
      animation: dial-travel 8s linear infinite;
    }
    .ring-end.pulse {
      animation: dial-glow 2.8s ease-in-out infinite;
    }
    .arc {
      transition:
        stroke-dasharray 300ms ease,
        opacity 300ms ease;
    }
    .turn {
      transition: transform 300ms ease;
    }
    /* Item 590: the estimated tail breathes while it is an estimate. */
    .arc.est {
      transition:
        stroke-dasharray 300ms ease,
        stroke-dashoffset 300ms ease;
      animation: dial-est 1.6s ease-in-out infinite;
    }
    /* The caller tweens a driven dial frame by frame; easing again here
       would drag the head behind the arc. */
    .driven .turn {
      transition: none;
    }
    /* Item 654: the drive eases the column's dial itself. */
    .framed .arc,
    .framed .turn {
      transition: none;
    }
    .framed .arc.est {
      animation-name: none;
    }
    .part {
      transition: stroke-width 120ms ease;
    }
  }
  @keyframes dial-travel {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes dial-est {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  @keyframes dial-glow {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }
  @keyframes dial-breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.72;
    }
  }
</style>
