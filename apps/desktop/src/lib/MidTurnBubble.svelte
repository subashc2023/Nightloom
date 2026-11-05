<script lang="ts">
  import UserBubble from "./UserBubble.svelte";
  import { tip } from "./tip";
  import type { Attachment } from "./types";
  import {
    cancelPending,
    editPending,
    letArrive,
    offersChoice,
    pendingLabel,
    pendingState,
    sendNow,
  } from "./pendingBubble.svelte";
  import type { QueuedMessage } from "./drafts.svelte";

  /**
   * His message sent while a turn runs (nightshift item 465), drawn as his
   * bubble: `row` (still queued) greyed with its pending mark and choices,
   * or `delivered` (the turn took it) as an ordinary bubble in the reply.
   * Its own component so the transcript renderer only places it.
   */
  let {
    row = null,
    chatKey = "",
    delivered = null,
  }: {
    row?: QueuedMessage | null;
    chatKey?: string;
    delivered?: { text: string; after: string } | null;
  } = $props();

  const pending = $derived(row !== null);
  const st = $derived(row ? pendingState(row) : null);
  const arrive = $derived(row ? letArrive[row.id] === true : false);
  let confirming = $state(false);
  let working = $state(false);

  const images = $derived((row?.attachments ?? []).filter((a: Attachment) => a.kind === "image" && a.data).map((a) => ({ media_type: a.media_type, data: a.data! })));
  const documents = $derived(
    (row?.attachments ?? []).filter((a: Attachment) => a.kind === "document" && a.data).map((a) => ({ media_type: a.media_type, name: a.name, data: a.data! })),
  );

  async function run(f: () => Promise<unknown>): Promise<void> {
    if (working) return;
    working = true;
    try {
      await f();
    } finally {
      working = false;
    }
  }
</script>

<div class="midturn" class:pending data-midturn={pending ? "pending" : "delivered"} data-queue-id={row?.id}>
  <div class="mt-key">
    {#if pending && st}
      <span class="mt-mark" aria-hidden="true"></span>
      <span class="mt-state" data-state={st}>{pendingLabel(st, arrive)}</span>
    {:else if delivered}
      <span class="mt-state" use:tip={`The running turn took it ${delivered.after}.`}>sent mid-reply · {delivered.after}</span>
    {/if}
    <span class="ns-k">You</span>
  </div>
  <div class="mt-bubble">
    <UserBubble text={row?.text ?? delivered?.text ?? ""} {images} {documents} />
  </div>
  {#if pending && row && st}
    <div class="mt-actions" role="group" aria-label="this message is not sent yet">
      {#if confirming}
        <span class="mt-ask">Cancel this message? It is not sent; its words go to the box's history.</span>
        <button class="ns-btn small danger" disabled={working} onclick={() => void run(() => cancelPending(chatKey, row!.id))}>Cancel message</button>
        <button class="ns-btn ghost small" onclick={() => (confirming = false)}>Keep it</button>
      {:else}
        {#if offersChoice(st, arrive)}
          <button
            class="ns-btn small"
            data-mt="send-now"
            disabled={working}
            use:tip={"Stop the step Claude is in (a long command, say) and give it this message at once — Claude Code's own send now. The reply so far stays and the turn goes on."}
            onclick={() => void run(() => sendNow(chatKey, row!.id))}>Send now</button
          >
          <button
            class="ns-btn ghost small"
            data-mt="arrive"
            use:tip={"Leave it: Claude reads it at its next step, as it would anyway."}
            onclick={() => (letArrive[row!.id] = true)}>Let it arrive</button
          >
        {/if}
        <button class="ns-btn ghost small" data-mt="edit" disabled={working} use:tip={"Take it back into the message box to change it"} onclick={() => void run(() => editPending(chatKey, row!.id))}>Edit</button>
        <button class="ns-btn ghost small" data-mt="cancel" disabled={working} use:tip={"Do not send it"} onclick={() => (confirming = true)}>Cancel</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .midturn {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    margin: 14px 0;
  }
  /* Item 478: taken by the turn, it is drawn inside the reply (640 px at
     most), but sits where his own messages sit — the right edge of the
     turns' column (`.inner`, the transcript's `turns` container), not the
     reply's. Only where that container is; elsewhere it keeps the reply's. */
  @container turns (min-width: 0px) {
    .midturn:not(.pending) {
      width: 100cqw;
    }
  }
  .mt-key {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .mt-state {
    font-size: 11.5px;
    color: var(--dim);
  }
  .pending .mt-bubble {
    opacity: 0.55;
    filter: saturate(0.5);
  }
  .pending .mt-bubble :global(.user-bubble) {
    border: 1px dashed var(--line2, var(--line));
  }
  .mt-mark {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--dim);
    border-top-color: transparent;
    animation: mt-spin 900ms linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .mt-mark {
      animation: none;
      border-top-color: var(--dim);
      border-style: dotted;
    }
  }
  @keyframes mt-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .mt-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
  }
  .mt-ask {
    font-size: 12px;
    color: var(--ink);
  }
</style>
