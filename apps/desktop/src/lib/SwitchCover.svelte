<script lang="ts">
  /**
   * Item 598: what covers the new-chat page while a project switch is in
   * flight (`projectSwitch.svelte.ts`): the page's own ground at once, and
   * the dial's gears turning as the loading state if the gap outlasts
   * `SWITCH_GEAR_AFTER_MS` — a gear that flashed would be a flash too.
   * Classic has no dial, so it gets the ground only (blocker 1824).
   */
  import DialMotion from "./DialMotion.svelte";
  import { SWITCH_GEAR_AFTER_MS } from "./projectSwitch.svelte";

  let { classic = false }: { classic?: boolean } = $props();

  let gear = $state(false);
  $effect(() => {
    const t = setTimeout(() => (gear = true), SWITCH_GEAR_AFTER_MS);
    return () => clearTimeout(t);
  });
</script>

<div class="switching" class:classic role="status" aria-label="Opening the project">
  {#if gear && !classic}
    <div class="switch-gear">
      <DialMotion size={160} pad={8} layers={["gearA", "gearB", "gearC", "wave"]} streaming />
    </div>
  {/if}
</div>

<style>
  .switching {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: var(--paper);
    /* Item 682: no dot tile, to match the new chat page. */
  }
  .switching.classic {
    background-image: none;
  }
  .switch-gear {
    position: relative;
    width: 176px;
    height: 176px;
  }
</style>
