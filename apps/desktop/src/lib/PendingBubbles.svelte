<script lang="ts">
  import MidTurnBubble from "./MidTurnBubble.svelte";
  import { readDraft } from "./drafts.svelte";
  import { pendingRows } from "./pendingBubble.svelte";
  import { app, openChatKey } from "./state.svelte";

  /** The open chat's messages sent while its turn runs and not yet taken
   *  (item 465), as greyed bubbles under the live reply. */
  const key = $derived(openChatKey());
  const rows = $derived(pendingRows(readDraft(key).queue, app.busy && !app.parked));
</script>

{#each rows as row (row.id)}
  <MidTurnBubble {row} chatKey={key} />
{/each}
