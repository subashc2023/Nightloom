<script lang="ts">
  import MidTurnBubble from "./MidTurnBubble.svelte";
  import { readDraft } from "./drafts.svelte";
  import { pendingRows } from "./pendingBubble.svelte";
  import { app, openChatKey } from "./state.svelte";
  import { pendingFor } from "./askReply";

  /** The open chat's messages sent while its turn runs and not yet taken
   *  (item 465), as greyed bubbles under the live reply. */
  const key = $derived(openChatKey());
  const rows = $derived(pendingRows(readDraft(key).queue, app.busy && !app.parked));
  /** Item 522: a prompt waits on him, so no process runs — a row here can
   *  go now, in place of an answer. */
  const waiting = $derived(app.busy && !app.parked && pendingFor(app.pendingApprovals, app.connection?.engine) !== null);
</script>

{#each rows as row (row.id)}
  <MidTurnBubble {row} chatKey={key} {waiting} />
{/each}
