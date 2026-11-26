<script lang="ts">
  // Round 5, point 2: what an item shows when he clicks it — label and value rows in plain words, then its actions.
  import type { Snippet } from "svelte";
  import { reveal } from "./stageState.svelte";
  import InlineMd from "../InlineMd.svelte"; // Item 991: model-written lines draw their markdown
  let { rows, children }: { rows: [string, string][]; children?: Snippet } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dl class="h9-detail" use:reveal onclick={(e) => e.stopPropagation()}>
  {#each rows as [k, v], i (k)}<dt style:--i={i}>{k}</dt><dd style:--i={i}><InlineMd text={v} /></dd>{/each}
  {#if children}<div class="h9-detail-acts">{@render children()}</div>{/if}
</dl>
