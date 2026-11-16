<script lang="ts">
  // Item 716 (his "why no pictures for this bro", 2026-11-16, on Cache on the
  // box): one look of the cache on the message box, live — a small real box
  // (the composer's own `.composer .card` with `data-cache` / `data-cache-look`
  // and the warmth vars, drawn by src/cacheLook.css, as Composer stamps it)
  // running a sped-up hour: just sent → aging → cold, then again. The clock
  // under it says where in the hour it is. One still pose, half spent, under
  // Reduce motion.
  import type { CacheState } from "./cache";
  import { cacheFrame, type CacheLook } from "./cacheLook.svelte";
  import { reducedMotion } from "./sendMotion";

  let { look }: { look: CacheLook } = $props();

  const HOUR = 60 * 60_000;
  /** One loop: the hour in 9 s, then 3 s cold. */
  const LOOP_MS = 12_000;
  const WARM_MS = 9_000;

  let t = $state<number>(reducedMotion() ? WARM_MS / 2 : 0);
  const sim = $derived<CacheState>({
    sentAt: 0,
    ttl: "1h",
    warmUntil: HOUR,
    remainingMs: t < WARM_MS ? HOUR * (1 - t / WARM_MS) : 0,
    warm: t < WARM_MS,
  });
  const frame = $derived(cacheFrame(sim));
  const label = $derived(sim.warm ? `${Math.max(1, Math.ceil(sim.remainingMs / 60_000))} min left` : "cold");

  $effect(() => {
    if (reducedMotion()) return;
    // One step a second (about 7 minutes of the hour): cacheLook.css eases each change over 0.8 s, and a change
    // sooner than that restarts the ease before a part that does not blend (the Edge line's length) flips.
    const start = performance.now();
    const id = setInterval(() => {
      t = (performance.now() - start) % LOOP_MS;
    }, 1000);
    return () => clearInterval(id);
  });
</script>

<span class="composer cl-pv" aria-hidden="true">
  <span class="card" data-cache={frame?.cache} data-cache-look={look} style={frame?.style}>
    <span class="cl-text">Ask anything…</span>
  </span>
  <span class="cl-clock" class:cold={!sim.warm}>{label}</span>
</span>

<style>
  .cl-pv {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 8px;
    pointer-events: none;
  }
  .cl-pv .card {
    position: relative;
    display: block;
    height: 46px;
    padding: 9px 12px;
    border: 1px solid var(--line2);
    border-radius: var(--r2, 10px);
    background: var(--sheet);
    box-sizing: border-box;
  }
  .cl-text {
    font-size: 12px;
    color: var(--dim);
  }
  .cl-clock {
    font: 10.5px var(--mono, monospace);
    color: var(--dim);
    text-align: right;
  }
  .cl-clock.cold {
    color: var(--signal);
  }
</style>
