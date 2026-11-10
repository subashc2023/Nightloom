<script lang="ts">
  /**
   * A chat whose only content is its scheduled first message (nightshift
   * backlog 532): what a chat made by Send later from a New chat shows
   * until the message goes — a card saying when it sends, the words and
   * files as they will go, and Send now / Edit / Cancel (Keep when it was
   * missed while the app was closed). Before 532 the page stayed the New
   * chat screen with the scheduled row floating over it. Edit and Cancel put
   * the words and files back in the box (the chip's rule, backlog 224/531);
   * the chat then has nothing in it and is a New chat page again, its box
   * holding them. The message landing makes the page the normal chat.
   */
  import { tick } from "svelte";
  import { tip } from "./tip";
  import { dueAt, kindText, scheduleHead } from "./schedule";
  import { cancelScheduled, keepScheduled, scheduledFor, sendScheduledNow } from "./scheduled.svelte";
  import { trackPending } from "./attachFiles.svelte";
  import { summonComposer } from "./composerSummon.svelte";
  import { refreshSessions } from "./state.svelte";
  import { scheduleWhen } from "./waitingChat";
  import { classic } from "./layout.svelte";
  import WaitAct from "./WaitAct.svelte";
  import FoldText from "./FoldText.svelte";
  import { launch, reducedMotion } from "./sendMotion";

  let { key }: { key: string } = $props();

  const s = $derived(scheduledFor(key));
  const plain = $derived(!!s && s.state === "waiting" && !s.note);
  const head = $derived(
    s ? (plain ? `Waiting to send at ${scheduleWhen(dueAt(s))} · ${kindText(s.kind)}` : scheduleHead(s, scheduleWhen)) : "",
  );

  async function giveBack(): Promise<void> {
    cancelScheduled(key, trackPending);
    void refreshSessions();
    await tick();
    summonComposer();
  }

  /** Items 548/549/547 (Filament IV): the words fold past ten lines, the
   *  actions are icons, and Send now flies the words into the first turn. */
  const filament = $derived(!classic());
  let textEl = $state<HTMLElement | null>(null);
  function sendNow(): void {
    if (filament && !reducedMotion()) launch("chat", textEl);
    void sendScheduledNow(key);
  }

  function thumb(a: { kind: string; media_type: string; data: string }): string | null {
    return a.kind === "image" && a.data ? `data:${a.media_type};base64,${a.data}` : null;
  }
</script>

{#if s}
  <div class="waiting-page">
    <div
      class="waiting-card"
      class:warn={s.state === "missed" || s.state === "limited" || s.state === "held"}
      role="status"
      aria-label="scheduled message"
      data-waiting-chat
    >
      <div class="waiting-head">
        <span class="waiting-dot" aria-hidden="true"></span>
        <span class="waiting-when" data-waiting-head>{head}</span>
        {#if !s.persist}
          <span
            class="ns-chip mono"
            use:tip={"An incognito or ephemeral chat writes nothing to disk, this included: quitting the app forgets this message."}
            >kept until you quit</span
          >
        {/if}
      </div>
      {#if s.text && filament}
        <FoldText lines={10} foldKey={`w:${key}`}>
          <div class="waiting-text fil" data-find-text={s.text} bind:this={textEl}>{s.text}</div>
        </FoldText>
      {:else if s.text}
        <div class="waiting-text" data-find-text={s.text}>{s.text}</div>
      {/if}
      {#if (s.attachments ?? []).length > 0}
        <div class="waiting-files" data-waiting-files>
          {#each s.attachments ?? [] as a (a.id)}
            {@const src = thumb(a)}
            <span class="waiting-file" use:tip={a.name}>
              {#if src}<img src={src} alt={a.name} />{/if}
              <span class="waiting-file-name">{a.pending ? `${a.name} — reading back` : a.name}</span>
            </span>
          {/each}
        </div>
      {/if}
      {#if filament}
        <div class="waiting-acts fil" role="group" aria-label="this message is scheduled, not sent">
          <!-- Greyed while a delivery of it is in flight (backlog 535): one message, one send. -->
          <WaitAct icon="send" accent label="Send now" hint="send it now, without waiting" data-wc="send-now" disabled={!!s.claimed} onclick={sendNow} />
          {#if s.state === "missed"}
            <WaitAct icon="check" label="Keep" hint="keep it here, unscheduled" data-wc="keep" onclick={() => keepScheduled(key)} />
          {:else}
            <WaitAct icon="pencil" label="Edit" hint="unschedule it and put the words and files back in the box" data-wc="edit" onclick={() => void giveBack()} />
          {/if}
          <WaitAct icon="x" label="Cancel" hint="unschedule it; the words and files go back in the box" data-wc="cancel" onclick={() => void giveBack()} />
        </div>
      {:else}
        <div class="waiting-acts">
          <!-- Greyed while a delivery of it is in flight (backlog 535): one message, one send. -->
          <button
            class="ns-btn accent small"
            use:tip={"Send it now, without waiting"}
            disabled={!!s.claimed}
            onclick={() => void sendScheduledNow(key)}>Send now</button
          >
          {#if s.state === "missed"}
            <button class="ns-btn ghost small" use:tip={"Keep it here, unscheduled"} onclick={() => keepScheduled(key)}>Keep</button>
          {:else}
            <button class="ns-btn ghost small" use:tip={"Unschedule and put the words and files back in the box"} onclick={() => void giveBack()}
              >Edit</button
            >
          {/if}
          <button class="ns-btn ghost small" use:tip={"Unschedule; the words and files go back in the box"} onclick={() => void giveBack()}
            >Cancel</button
          >
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .waiting-page {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem 1.25rem 1rem;
  }
  .waiting-card {
    width: 100%;
    max-width: 760px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.85rem 1rem;
    border: 1px dashed var(--line2);
    border-radius: 10px;
    background: var(--well);
    color: var(--ink);
    font-size: 14px;
  }
  .waiting-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--dim);
  }
  .waiting-card.warn .waiting-when {
    color: var(--warn, var(--accent));
  }
  .waiting-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .waiting-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 50vh;
    overflow-y: auto;
    line-height: 1.5;
  }
  .waiting-files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .waiting-file {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    padding: 3px 8px 3px 3px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--sheet);
    font-size: 12px;
    color: var(--dim);
  }
  .waiting-file img {
    width: 28px;
    height: 28px;
    object-fit: cover;
    border-radius: 4px;
  }
  .waiting-file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .waiting-acts {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .waiting-acts.fil {
    gap: 2px;
  }
  /* The fold measures and clips (FoldText); the text does not scroll inside it. */
  .waiting-text.fil {
    max-height: none;
    overflow: visible;
  }
  .waiting-card :global(.fold) {
    align-items: stretch;
  }
  .waiting-card :global(.fold-more) {
    align-self: flex-start;
  }
</style>
