<script lang="ts">
  /*
   * Item 1013: the phone's Dream / Capture, start to end — a pulsing dot and a clock while the Mac works, then
   * the Mac's result line, held until he closes it (item 1005's rule on the Mac). Fixed above Home too: the
   * dock's toast sits under Home's screen, which is where the drawer's Dream and Capture are usually pressed.
   */
  import { onDestroy } from "svelte";
  import { clockText, type PassStatus } from "./passStatus";

  let { status, onclose }: { status: PassStatus; onclose: () => void } = $props();
  let now = $state(Date.now());
  const timer = setInterval(() => (now = Date.now()), 1000);
  onDestroy(() => clearInterval(timer));
  const ran = $derived((status.ended ?? now) - status.since);
</script>

<div class="pass-status" class:failed={status.phase === "failed"} role="status" aria-live="polite" data-pass-status={status.phase}>
  {#if status.phase === "working"}<i class="ps-dot" aria-hidden="true"></i>{/if}
  <span class="ps-text">{status.text}</span>
  <span class="ps-clock" role="timer" aria-label={status.phase === "working" ? `running for ${clockText(ran)}` : `took ${clockText(ran)}`}>{status.phase === "working" ? clockText(ran) : `· ${clockText(ran)}`}</span>
  <button class="ps-x" onclick={onclose} aria-label={status.phase === "working" ? "Hide — the result still shows when it ends" : "Close"}>×</button>
</div>

<style>
  .pass-status {
    position: fixed;
    left: 50%;
    bottom: calc(120px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    z-index: 9;
    display: flex;
    align-items: center;
    gap: 8px;
    width: max-content;
    max-width: calc(100vw - 24px);
    box-sizing: border-box;
    padding: 8px 6px 8px 14px;
    border-radius: var(--r1, 14px);
    background: var(--ink);
    color: var(--paper);
    font-size: 13px;
    line-height: 1.35;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  }
  .pass-status.failed {
    box-shadow:
      inset 3px 0 0 var(--bad, #c0392b),
      0 6px 20px rgba(0, 0, 0, 0.3);
  }
  .ps-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .ps-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: ps-pulse 1.2s ease-in-out infinite;
  }
  .ps-clock {
    flex: none;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  .ps-x {
    all: unset;
    flex: none;
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 18px;
    cursor: pointer;
    opacity: 0.8;
  }
  .ps-x:active {
    background: rgba(255, 255, 255, 0.15);
  }
  @keyframes ps-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ps-dot {
      animation: none;
    }
  }
</style>
