<script lang="ts">
  import { tip } from "./tip";
  import { isConnectionFailure, retryText, type RetrySegment } from "./retryLine";

  /**
   * The live reply's retry line (nightshift items 440 + 441): the CLI is
   * retrying a failed call, said in words in one line that each try
   * updates in place — never a toast per try. Gone at the reply's first
   * word; "stopping" once he pressed Stop (`retryLine.ts`).
   */
  let { seg }: { seg: RetrySegment } = $props();

  const offline = $derived(isConnectionFailure(seg));
  const detail = $derived(
    [
      `Claude Code is retrying the call to Anthropic (try ${seg.attempt} of ${seg.max}).`,
      seg.error ? `It reports: ${seg.error}${seg.status !== null ? `, HTTP ${seg.status}` : ", no HTTP status"}.` : null,
      seg.delayMs !== null ? `Next try after ${Math.max(1, Math.round(seg.delayMs / 1000))} s.` : null,
      offline ? "Check the Wi-Fi; the turn goes on by itself once the connection is back, or Stop ends it." : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
</script>

<div class="retry" class:offline class:stopping={seg.stopping} role="status" aria-live="polite" use:tip={detail}>
  <span class="dot" aria-hidden="true"></span>
  <span class="words">{retryText(seg)}</span>
</div>

<style>
  .retry {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--sans);
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--partial);
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--partial);
    transform: translateY(-1px);
    animation: retry-pulse 1.4s ease-in-out infinite;
  }
  .retry.stopping {
    color: var(--dim);
  }
  .retry.stopping .dot {
    background: var(--dim);
    animation: none;
  }
  @keyframes retry-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
  .words {
    flex: 1;
    min-width: 0;
  }
</style>
