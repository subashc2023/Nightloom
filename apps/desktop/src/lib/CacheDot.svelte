<script lang="ts">
  /**
   * Item 1022: the cache dot before a chat's name (the rule and the words
   * are `cacheDot.ts`, the clock and the pick of timer `cacheDotState.svelte.ts`).
   * Solid amber while keep-warm pings run, with a ring that flashes once
   * when a ping lands; an amber ring drained by the time spent while warm;
   * a hollow blue ring once cold — the moment it goes cold plays once
   * (a 1 s cool-down) and never loops. Nothing drawn before a chat has a
   * cache. Jarvis glows; Classic draws the same shapes flat. Under Reduce
   * motion nothing animates: the ring steps with the clock.
   */
  import { tip } from "./tip";
  import { keepWarm } from "./keepWarm.svelte";
  import { asideDot, chatDot, dotClock, useDotClock } from "./cacheDotState.svelte";

  let { session, thread = undefined, aside = false }: { session: string | null | undefined; thread?: number | null; aside?: boolean } = $props();

  $effect(() => useDotClock());

  const dot = $derived(session ? (aside ? asideDot(session, thread, dotClock.now) : chatDot(session, dotClock.now)) : null);
  /** A ping's read: the ring's flash replays on each new one. */
  const pinged = $derived(session && !aside ? (keepWarm.byChat[session]?.touched_ms ?? null) : null);

  // The cool-down plays when the face turns cold under his eyes, not when
  // a cold chat is drawn.
  let prev: string | null = null;
  let cooling = $state(false);
  $effect(() => {
    const f = dot?.face ?? null;
    if (prev !== null && prev !== "cold" && f === "cold") {
      cooling = true;
      const t = setTimeout(() => (cooling = false), 1100);
      prev = f;
      return () => clearTimeout(t);
    }
    prev = f;
  });
</script>

{#if dot}
  <span
    class="cache-dot {dot.face}"
    class:cooling
    role="img"
    aria-label={dot.tip.replace("\n", " — ")}
    data-cache-dot={dot.face}
    style:--dot-share="{Math.round(dot.share * 360)}deg"
    use:tip={dot.tip}
    >{#if dot.face === "kept"}{#key pinged}<i class="ping"></i>{/key}{/if}</span
  >
{/if}

<style>
  .cache-dot {
    position: relative;
    display: inline-block;
    flex: none;
    width: 9px;
    height: 9px;
    margin-right: 5px;
    border-radius: 50%;
    vertical-align: -0.5px;
    transition: background 0.8s ease, box-shadow 0.8s ease;
  }
  .cache-dot.kept {
    background: var(--accent);
  }
  .cache-dot.kept::after {
    content: "";
    position: absolute;
    inset: -2.5px;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .cache-dot.warm {
    background: conic-gradient(var(--accent) var(--dot-share), color-mix(in srgb, var(--signal) 30%, transparent) 0);
    -webkit-mask: radial-gradient(circle, transparent 2px, #000 2.4px);
    mask: radial-gradient(circle, transparent 2px, #000 2.4px);
  }
  .cache-dot.cold {
    border: 1.5px solid color-mix(in srgb, var(--signal) 70%, transparent);
  }
  .ping {
    position: absolute;
    inset: -2.5px;
    border-radius: 50%;
    border: 1px solid var(--accent);
    opacity: 0;
    animation: cache-dot-ping 0.9s ease-out;
  }
  @keyframes cache-dot-ping {
    0% {
      opacity: 0.9;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(2.2);
    }
  }
  .cache-dot.cold.cooling {
    animation: cache-dot-cool 1s ease-out;
  }
  @keyframes cache-dot-cool {
    0% {
      background: var(--accent);
      border-color: transparent;
    }
    60% {
      box-shadow: 0 0 6px var(--signal);
    }
    100% {
      background: transparent;
    }
  }
  /* Jarvis lights the kept dot and the cool-down's blue; Classic draws flat. */
  :global(:root:not([data-layout="classic"])) .cache-dot.kept {
    box-shadow: 0 0 5px var(--accent);
  }
  :global([data-layout="classic"]) .cache-dot {
    width: 8px;
    height: 8px;
  }
  :global([data-layout="classic"]) .cache-dot.cold {
    border-color: var(--dim);
  }
  :global([data-layout="classic"]) .cache-dot.kept::after {
    display: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .cache-dot,
    .ping,
    .cache-dot.cold.cooling {
      animation: none;
      transition: none;
    }
  }
</style>
