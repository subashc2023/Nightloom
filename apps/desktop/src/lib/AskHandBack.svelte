<script lang="ts">
  import { app, cancelTurn } from "./state.svelte";
  import { handBack, handBackLine } from "./handBack.svelte";

  /**
   * The line in a prompt's place between his answer and the turn showing it (nightshift item 522): "Skipped —
   * handing the turn back to Claude…", and past 20 s how long it has been, with Stop — never a card that left
   * and a call that silently stays "running". Shown in the chat the answer was given in, while its turn runs.
   */
  const h = $derived(
    handBack.current && app.busy && !app.parked && (handBack.current.chat === null || handBack.current.chat === app.activeSessionId) ? handBack.current : null,
  );
  let now = $state(Date.now());
  $effect(() => {
    if (!h) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const line = $derived(h ? handBackLine(h, now) : null);
</script>

{#if h && line}
  <div class="handback" class:slow={line.slow} role="status" aria-live="polite" data-ask-handback={h.how}>
    <span class="dot" aria-hidden="true"></span>
    <span class="text">{line.text}</span>
    {#if line.slow}
      <button class="ns-btn ghost small" onclick={() => void cancelTurn()}>Stop the turn</button>
    {/if}
  </div>
{/if}

<style>
  .handback {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--dim);
    font-size: 0.8rem;
  }
  .handback.slow {
    color: var(--ink);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: handback-pulse 1.2s ease-in-out infinite;
  }
  @keyframes handback-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
