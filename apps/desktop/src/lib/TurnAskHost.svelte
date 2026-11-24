<script lang="ts">
  /**
   * The chat on screen's turn-end question (nightshift item 753), under its transcript where a waiting
   * call's card sits: drawn while the chat's last word is a reply holding an `<ask>` block and no turn runs
   * in it; gone once he answers (the card, the Needs-you view, the phone, or simply writing in the chat).
   */
  import TurnAsk from "./TurnAsk.svelte";
  import { app } from "./state.svelte";
  import { answerAsk, hereAsk, hereTarget, queuedAnswerOf } from "./needsBoard.svelte";

  // Item 922: an answer queued while the chat runs keeps its card (the pick shown, "queued") until the row goes.
  const queued = $derived(queuedAnswerOf(app.activeSessionId));
  const pending = $derived(hereAsk() ?? (queued ? { ask: queued.ask, index: queued.index } : null));
  let sending = $state(false);
  const note = $derived(
    app.project ? "Your answer is sent as your next message, and filed as an answered blocker where this project keeps them." : "Your answer is sent as your next message.",
  );
</script>

{#if pending && app.activeSessionId}
  {#key `${app.activeSessionId}:${pending.index}`}
    <TurnAsk
      ask={pending.ask}
      idBase={`ta-${app.activeSessionId}-${pending.index}`}
      {sending}
      queued={queued?.answer ?? null}
      {note}
      onsend={async (answer) => {
        const ask = pending.ask;
        sending = true;
        try {
          await answerAsk(hereTarget(), ask, answer);
        } finally {
          sending = false;
        }
      }}
    />
  {/key}
{/if}
