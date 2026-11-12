<script lang="ts">
  // Item 610 (his ask 2026-11-10: "why aren't there like animation visuals
  // to accompany it"): one Thinking motion running, for its card in
  // Settings → Appearance → Animations. Not a drawing of the motion — the
  // real reply component (AssistantMessage), streaming, its trace one
  // Thinking step running, with this card's motion stamped on its
  // trace, so what loops here is exactly what a reply shows. The loop is the
  // trace's own CSS: still under Reduce motion, paused while the window is
  // hidden. `run` changing remounts it (Preview: the loop from its start).
  import AssistantMessage from "./AssistantMessage.svelte";
  import type { Segment } from "./state.svelte";
  import type { StepMotion } from "./stepMotion.svelte";

  // Item 667: the step's motion eases in over its first 5 s here too (the
  // reply's own stepRamp); `rampStart` overrides the start rate (the
  // comparison page only; none = the app's RAMP_START).
  let { motion, run = 0, rampStart = null }: { motion: StepMotion; run?: number; rampStart?: number | null } = $props();

  // One step, running: the Thinking step, the one the motion is chosen for
  // (the trace keys its clock by tool id, so a thinking-only sample stays
  // apart from any real reply's).
  function sample(): Segment[] {
    return [{ kind: "thinking", text: "The cache key hashes the lockfile and the toolchain file…", done: false, at: Date.now() }];
  }
</script>

{#key run}
  <div class="motion-sample" data-motion-sample={motion} data-ramp-start={rampStart ?? undefined}>
    <AssistantMessage segs={sample()} streaming={true} headed={false} since={Date.now()} {motion} />
  </div>
{/key}

<style>
  /* The reply drawn at its own size, clipped to the card's stage; nothing in
     it takes a click (the card's pick sits over the stage). */
  .motion-sample {
    pointer-events: none;
    overflow: hidden;
    font-size: 13px;
  }
</style>
