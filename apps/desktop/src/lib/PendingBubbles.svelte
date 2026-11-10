<script lang="ts">
  import MidTurnBubble from "./MidTurnBubble.svelte";
  import ScheduledBubble from "./ScheduledBubble.svelte";
  import { readDraft } from "./drafts.svelte";
  import { bubbledRows, type HeldWhy } from "./pendingBubble.svelte";
  import { app, openChatKey, turnWasStopped } from "./state.svelte";
  import { pendingFor } from "./askReply";
  import { classic } from "./layout.svelte";
  import { handoff, queueHold } from "./handoff.svelte";
  import { scheduledFor } from "./scheduled.svelte";

  /** The open chat's messages sent while its turn runs and not yet taken
   *  (item 465), as greyed bubbles under the live reply. Item 548: under
   *  Filament IV also the ones waiting with no turn running (held after a
   *  Stop or the wrap-up's turn; the wrap-up queued while he was away), and
   *  the message scheduled in this chat — every waiting message drawn as
   *  a message, none as a row over the box. */
  const key = $derived(openChatKey());
  const busyHere = $derived(app.busy && !app.parked);
  const rows = $derived(bubbledRows(readDraft(key).queue, busyHere, !classic(), app.busy && !!app.parked));
  /** Item 522: a prompt waits on him, so no process runs — a row here can
   *  go now, in place of an answer. */
  const waiting = $derived(app.busy && !app.parked && pendingFor(app.pendingApprovals, app.connection?.engine) !== null);
  /** Why a row waits with no turn running (item 548), as the box's head said. */
  const held = $derived<HeldWhy | null>(
    busyHere ? null : (queueHold(handoff.chat !== null && handoff.chat === app.activeSessionId ? handoff.stage : "idle", turnWasStopped()) ?? "idle"),
  );
  const sched = $derived(!classic() && app.activeSessionId !== null && scheduledFor(key) !== null);
</script>

{#each rows as row (row.id)}
  <MidTurnBubble {row} chatKey={key} {waiting} {held} />
{/each}
{#if sched}
  <ScheduledBubble {key} />
{/if}
