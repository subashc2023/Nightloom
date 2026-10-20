<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  /**
   * The wait between Send and a turn's first event (backlog 049), one
   * piece for the chat and its asides since item 403 (2026-10-20 — an
   * aside had its own copy: a smaller moon spinning in place beside dots
   * that always blinked). Moved here from `Transcript.svelte` unchanged.
   *
   * Between send and the first streamed event there is nothing to render,
   * and a blank row read as "nothing happened" (his words, backlog 049).
   * So something moves: the moon rolls a short way and back until the
   * first delta or tool call replaces it; with the OS asked for less
   * motion it is three still dots. It says nothing about progress,
   * because it can see none. `children` is a note after it (an aside's
   * "waiting for the chat's turn", item 404).
   */
  let { label = "Waiting for the reply", children }: { label?: string; children?: Snippet } = $props();
</script>

<div class="waiting" role="status" aria-label={label}>
  <span class="roll" aria-hidden="true"><Icon name="moon" size={22} /></span>
  <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
  {#if children}<span class="note">{@render children()}</span>{/if}
</div>

<style>
  .waiting {
    display: flex;
    align-items: center;
    min-height: 20px;
    color: var(--dim);
    /* A beat after the bubble (backlog 095); `backwards` keeps it unseen
       through the delay, and leaves no fill behind to fight `.superseded`. */
    animation: enter 180ms ease-out 300ms backwards;
  }
  /* The sent message's entrance (backlog 095) moved to `sendMotion.ts`
     (backlog 194): a flight from the composer, or the same 180 ms rise
     when nothing launched. The moon above waits 300 ms now, so it comes
     in as the flight lands rather than under it. */
  @keyframes enter {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .waiting {
      animation: none;
    }
  }
  .roll {
    display: inline-flex;
    animation: roll 1.5s ease-in-out infinite alternate;
  }
  /* Two feet, not the width of the pane: a roll that crosses the transcript
     competes with the reply it is waiting for. */
  @keyframes roll {
    from {
      transform: translateX(0) rotate(0deg);
    }
    to {
      transform: translateX(32px) rotate(360deg);
    }
  }
  .dots {
    display: none;
    gap: 5px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.55;
  }
  @media (prefers-reduced-motion: reduce) {
    .roll {
      display: none;
    }
    .dots {
      display: inline-flex;
    }
  }
  /* Past the moon's roll, so the roll never runs over the words. */
  .note {
    margin-left: 44px;
    font-size: 12px;
  }
  @media (prefers-reduced-motion: reduce) {
    .note {
      margin-left: 10px;
    }
  }
</style>
