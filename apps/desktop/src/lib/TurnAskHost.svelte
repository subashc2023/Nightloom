<script lang="ts">
  /**
   * The chat on screen's turn-end question (nightshift item 753), under its transcript where a waiting
   * call's card sits: drawn while the chat's last word is a reply holding an `<ask>` block and no turn runs
   * in it; gone once he answers (the card, the Needs-you view, the phone, or simply writing in the chat).
   */
  import TurnAsk from "./TurnAsk.svelte";
  import { app } from "./state.svelte";
  import { answerAsk, hereAsk, hereTarget, queuedAnswerOf } from "./needsBoard.svelte";
  // Item 983: files on the answer, kept in the drafts store per card; they go with the answer's message.
  import { readDraft, removeAttachment, setDraftAttachments } from "./drafts.svelte";
  import { acceptFiles } from "./attachFiles.svelte";
  import { addToast } from "./state/toasts.svelte";
  import { chipsReady, turnAskFilesKey } from "./answerFiles";

  // Item 922: an answer queued while the chat runs keeps its card (the pick shown, "queued") until the row goes.
  const queued = $derived(queuedAnswerOf(app.activeSessionId));
  const pending = $derived(hereAsk() ?? (queued ? { ask: queued.ask, index: queued.index } : null));
  let sending = $state(false);
  const idBase = $derived(pending && app.activeSessionId ? `ta-${app.activeSessionId}-${pending.index}` : "");
  const filesKey = $derived(turnAskFilesKey(idBase));
  const chips = $derived(idBase ? readDraft(filesKey).attachments : []);
  const note = $derived(
    app.project ? "Your answer is sent as your next message, and filed as an answered blocker where this project keeps them." : "Your answer is sent as your next message.",
  );
</script>

{#if pending && app.activeSessionId}
  {#key `${app.activeSessionId}:${pending.index}`}
    <TurnAsk
      ask={pending.ask}
      {idBase}
      {sending}
      queued={queued?.answer ?? null}
      {note}
      files={chips}
      onfiles={(list) => void acceptFiles(filesKey, list)}
      onunfile={(id) => removeAttachment(filesKey, id)}
      onsend={async (answer) => {
        const ask = pending.ask;
        const key = filesKey;
        const files = readDraft(key).attachments;
        if (!chipsReady(files)) {
          addToast("A file is still converting — answer when it is ready");
          return;
        }
        sending = true;
        try {
          if (await answerAsk(hereTarget(), ask, answer, [...files])) setDraftAttachments(key, []);
        } finally {
          sending = false;
        }
      }}
    />
  {/key}
{/if}
