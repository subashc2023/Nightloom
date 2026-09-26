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
  <!-- The rolling moon (nightshift item 234, 2026-09-26, his words: "the
       rolling moon to replace the stationary moon"): the one a reply shows
       while it streams (`AssistantMessage.svelte`'s `.working .roll`), at
       its size when alone (backlog 212: 28), in the same 60 px track, with
       the same three still dots under reduced motion. -->
  <span class="roll" aria-hidden="true"><Icon name="moon" size={28} /></span>
  <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
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
  /* The streaming moon's roll, as `AssistantMessage.svelte` draws it: a
     60 px track (the 32 px roll plus the 28 px moon), so the roll is
     centred over the line; the moon in the accent. */
  .roll {
    display: inline-flex;
    flex: none;
    width: 60px;
    color: var(--accent);
  }
  .roll :global(svg) {
    animation: roll 1.5s ease-in-out infinite alternate;
  }
  .line {
    margin: 0;
    font-family: var(--serif);
    font-size: 17px;
    color: var(--ink2);
  }
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
    color: var(--accent);
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
</style>
