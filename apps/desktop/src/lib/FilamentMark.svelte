<script lang="ts">
  /**
   * Item 606 (his pick, blocker 1827): the Filament marks for the
   * composer's three actions — one coil for Send, a coil with a side lead
   * for Ask aside, three coils for Council. Filament IV only: under Classic
   * the mark is `display: none`, so Classic renders as before (0 px).
   *
   * States come from the button it sits in (the composer gives it the
   * `fil-btn` class, and `sending` on Send while a send starts): idle is a
   * steady glow and nothing moves; hover powers the coil up (a pulse runs
   * it once); press sparks it once, quick; sending runs a white-hot pulse
   * along it, a 1 s loop. Reduce motion: static glows only.
   * Glyphs from notes/runner-design/606-harness/glyphs.ts (nightshift-code).
   */
  let { kind }: { kind: "send" | "aside" | "council" } = $props();

  const SEND =
    "M0.5 9 H3 C3.6 4.4 5.4 4.4 6 9 C6.6 13.6 8.4 13.6 9 9 C9.6 4.4 11.4 4.4 12 9 C12.6 13.6 14.4 13.6 15 9 C15.6 4.4 17 4.4 17.5 9 H19.5";
  const ASIDE_COIL = "M0.5 10 H2.5 C3 6 4.6 6 5.1 10 C5.6 14 7.2 14 7.7 10 C8.2 6 9.8 6 10.3 10 H12";
  const ASIDE_LEAD = "M10.3 10 C12 10 13 7 13.2 2.5";
  const ASIDE_RUN = "M0.5 10 H2.5 C3 6 4.6 6 5.1 10 C5.6 14 7.2 14 7.7 10 C8.2 6 9.8 6 10.3 10 C12 10 13 7 13.2 2.5";
  const coil = (y: number) =>
    `M1 ${y} H3 C3.5 ${y - 2.4} 4.7 ${y - 2.4} 5.2 ${y} C5.7 ${y + 2.4} 6.9 ${y + 2.4} 7.4 ${y} C7.9 ${y - 2.4} 9.1 ${y - 2.4} 9.6 ${y} C10.1 ${y + 2.4} 11.3 ${y + 2.4} 11.8 ${y} H15`;
  const COUNCIL = [3.5, 8, 12.5].map(coil);
</script>

{#if kind === "send"}
  <svg class="fil-svg fil-wide" viewBox="0 0 20 18" aria-hidden="true">
    <path class="fil-base" d={SEND} />
    <path class="fil-pulse" pathLength="100" d={SEND} />
  </svg>
{:else if kind === "aside"}
  <svg class="fil-svg" viewBox="0 0 16 16" aria-hidden="true">
    <path class="fil-base" d={ASIDE_COIL} />
    <path class="fil-base" d={ASIDE_LEAD} />
    <path class="fil-pulse" pathLength="100" d={ASIDE_RUN} />
  </svg>
{:else}
  <svg class="fil-svg" viewBox="0 0 16 16" aria-hidden="true">
    {#each COUNCIL as d, i (i)}
      <path class="fil-base" {d} />
      <path class="fil-pulse fil-p{i}" pathLength="100" {d} />
    {/each}
  </svg>
{/if}

<style>
  .fil-svg {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .fil-svg {
    display: block;
    flex: none;
    width: 14px;
    height: 14px;
    overflow: visible;
    color: var(--dim);
    position: relative;
    z-index: 1;
  }
  :global(:where(:root:not([data-layout="classic"]))) .fil-wide {
    width: 19px;
    height: 17px;
  }
  .fil-base {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: stroke 140ms ease;
  }
  .fil-pulse {
    fill: none;
    stroke: #fffaf0;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-dasharray: 22 78;
    stroke-dashoffset: 100;
    stroke-opacity: 0;
  }
  .fil-p1 {
    animation-delay: -0.33s;
  }
  .fil-p2 {
    animation-delay: -0.66s;
  }

  /* Send: the coil is lit amber at rest (a steady glow, no motion). */
  :global(.fil-send) .fil-svg {
    color: var(--accent);
    filter: drop-shadow(0 0 1.5px var(--accent));
  }
  :global(.fil-send:is(:hover:not(:disabled), :active:not(:disabled), .sending)) .fil-svg {
    color: var(--accent-ink);
    filter: drop-shadow(0 0 2.5px var(--accent));
  }
  :global(.fil-send:disabled) .fil-svg {
    color: var(--dim);
    filter: none;
  }
  /* Ask aside and Council: the mark is dim ink at rest and lights amber on
     hover, press, or while the council's popover is open. */
  :global(.fil-ghost:is(:hover:not(:disabled), :active:not(:disabled), .on)) .fil-svg {
    color: var(--accent);
    filter: drop-shadow(0 0 1.5px var(--accent));
  }
  :global(.fil-ghost:disabled) .fil-svg {
    opacity: 0.6;
  }
  /* Calm (IV): no light — the coil stays lit, without its halo. */
  :global(:where([data-light="calm"])) .fil-svg {
    filter: none !important;
  }

  @media (prefers-reduced-motion: no-preference) {
    /* Hover: the coil powers up — one pulse runs it, then it holds lit. */
    :global(.fil-btn:hover:not(:disabled)) .fil-pulse {
      animation: fil-run 0.55s ease-out 1 both;
    }
    :global(.fil-btn:hover:not(:disabled)) .fil-p1 {
      animation-delay: 0.08s;
    }
    :global(.fil-btn:hover:not(:disabled)) .fil-p2 {
      animation-delay: 0.16s;
    }
    /* Press: a spark runs the coil once, quick. */
    :global(.fil-btn:active:not(:disabled)) .fil-pulse {
      animation: fil-spark 0.3s ease-in 1 both;
    }
    /* Sending: a white-hot pulse along the coil, a 1 s loop. */
    :global(.fil-btn.sending) .fil-pulse {
      animation: fil-loop 1s linear infinite;
    }
    :global(.fil-btn.sending) .fil-p1 {
      animation-delay: -0.33s;
    }
    :global(.fil-btn.sending) .fil-p2 {
      animation-delay: -0.66s;
    }
  }
  @keyframes fil-run {
    0% {
      stroke-dashoffset: 100;
      stroke-opacity: 1;
    }
    100% {
      stroke-dashoffset: -22;
      stroke-opacity: 1;
    }
  }
  @keyframes fil-spark {
    0% {
      stroke-dashoffset: 100;
      stroke-opacity: 1;
    }
    100% {
      stroke-dashoffset: -22;
      stroke-opacity: 1;
    }
  }
  @keyframes fil-loop {
    0% {
      stroke-dashoffset: 100;
      stroke-opacity: 1;
    }
    100% {
      stroke-dashoffset: -22;
      stroke-opacity: 1;
    }
  }
</style>
