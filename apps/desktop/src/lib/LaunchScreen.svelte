<script lang="ts">
  /**
   * The launch screen (nightshift item 220, 2026-09-26): the moon and
   * "Opening <project>…" over the app until the project list is read and
   * the last project has reopened, so a slow start reads as starting — not
   * as an empty app saying "not connected" (his 2026-09-25 report).
   * `launch.svelte.ts` decides when it comes down.
   */
  import Icon from "./Icon.svelte";
  import { launch, launchMessage } from "./launch.svelte";
</script>

<div class="launch" role="status" aria-live="polite">
  <span class="moon" aria-hidden="true"><Icon name="moon" size={30} /></span>
  <p class="line">{launchMessage(launch.project)}</p>
</div>

<style>
  .launch {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    background: var(--paper);
    color: var(--dim);
  }
  .moon {
    color: var(--accent);
    display: inline-flex;
    animation: rock 2.4s ease-in-out infinite;
  }
  .line {
    margin: 0;
    font-family: var(--serif);
    font-size: 17px;
    color: var(--ink2);
  }
  /* The moon rocks a little while it waits, as the transcript's does, so
     the window visibly has not frozen. */
  @keyframes rock {
    0%,
    100% {
      transform: rotate(-8deg);
    }
    50% {
      transform: rotate(8deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .moon {
      animation: none;
    }
  }
</style>
