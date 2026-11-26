<script lang="ts">
  /*
   * Items 1005 + 1007: the running toast's sign of life — a pulsing dot and the time since it started
   * ("· 1:42"), ticking each second, so a memory pass that takes minutes reads as working, not stuck.
   */
  import { onDestroy } from "svelte";
  import { elapsedText } from "./passFeedback";

  let { since }: { since: number } = $props();
  let now = $state(Date.now());
  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));
</script>

<span class="toast-clock" role="timer" aria-label="running for {elapsedText(now - since)}"><i aria-hidden="true"></i>{elapsedText(now - since)}</span>

<style>
  .toast-clock {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-left: 0.4rem;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
  .toast-clock i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: toast-pulse 1.2s ease-in-out infinite;
  }
  @keyframes toast-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast-clock i {
      animation: none;
    }
  }
</style>
