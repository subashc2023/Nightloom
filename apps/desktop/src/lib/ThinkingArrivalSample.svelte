<script lang="ts">
  // Item 716 part 5: the sample block on a Thinking block arrival card (Settings → Animations).
  // Not a drawing — the real reply component (AssistantMessage; AssistantMessageClassic under
  // Classic, as TranscriptClassic uses), streaming one Thinking step, so the block Settings plays
  // its arrival on (its `.activity`, the node a reply's own arrival plays on) is the real block.
  // The step began just past FRESH_MS ago, so the reply's own arrival (the chosen look) does not
  // also play on it at mount; the card plays its own look (SettingsModal's previewArrival).
  import AssistantMessage from "./AssistantMessage.svelte";
  import AssistantMessageClassic from "./AssistantMessageClassic.svelte";
  import { classic } from "./layout.svelte";
  import type { Segment } from "./state.svelte";
  import { FRESH_MS } from "./thinkingArrival";

  const segs: Segment[] = [{ kind: "thinking", text: "The cache key hashes the lockfile and the toolchain file…", done: false, at: Date.now() - FRESH_MS - 300 }];
</script>

<div class="arrival-sample" data-arrival-sample>
  {#if classic()}
    <AssistantMessageClassic {segs} streaming={true} />
  {:else}
    <AssistantMessage {segs} streaming={true} headed={false} since={Date.now()} />
  {/if}
</div>

<style>
  /* The reply at its own size, clipped to the stage; nothing in it takes a click (the card picks). */
  .arrival-sample {
    pointer-events: none;
    overflow: hidden;
    font-size: 13px;
  }
</style>
