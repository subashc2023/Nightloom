<script lang="ts">
  /**
   * The message scheduled in a chat that already has turns, drawn as his
   * message at the transcript's foot (nightshift item 548, 2026-11-10,
   * Filament IV): his greyed bubble — the words as they will go, folded past
   * six lines with "more", its images and files — under a state line
   * ("scheduled · 6:30 AM · at the time you picked"), with the waiting
   * page's actions (item 532's card, the "actual message" he prefers) as
   * icons (item 549): Send now, Edit (Keep when it was missed while the app
   * was closed), Cancel. Edit and Cancel put the words and files back in the
   * box, as the chip's did (backlog 224/531), so nothing is lost. Before 548
   * this was `ScheduledChip`'s one-line row over the box with the whole text
   * as its hover tip; Classic (item 542) keeps that row.
   */
  import { tick } from "svelte";
  import UserBubble from "./UserBubble.svelte";
  import WaitAct from "./WaitAct.svelte";
  import FoldText from "./FoldText.svelte";
  import { tip } from "./tip";
  import { scheduleHead } from "./schedule";
  import { cancelScheduled, keepScheduled, scheduledFor, sendScheduledNow } from "./scheduled.svelte";
  import { trackPending } from "./attachFiles.svelte";
  import { summonComposer } from "./composerSummon.svelte";
  import { refreshSessions } from "./state.svelte";
  import { scheduleWhen } from "./waitingChat";
  import { launch, reducedMotion } from "./sendMotion";

  let { key }: { key: string } = $props();

  const s = $derived(scheduledFor(key));
  const head = $derived(s ? scheduleHead(s, scheduleWhen) : "");
  const warn = $derived(!!s && (s.state === "missed" || s.state === "limited" || s.state === "held"));
  const images = $derived((s?.attachments ?? []).filter((a) => a.kind === "image" && a.data).map((a) => ({ media_type: a.media_type, data: a.data! })));
  const documents = $derived(
    (s?.attachments ?? []).filter((a) => a.kind === "document" && a.data).map((a) => ({ media_type: a.media_type, name: a.name, data: a.data! })),
  );
  const sending = $derived((s?.attachments ?? []).filter((a) => a.kind === "file" || ((a.kind === "image" || a.kind === "document") && !a.data)).map((a) => a.name));

  let bubbleEl = $state<HTMLElement | null>(null);

  async function giveBack(): Promise<void> {
    cancelScheduled(key, trackPending);
    void refreshSessions();
    await tick();
    summonComposer();
  }

  /** Item 547: the message leaves from here into its turn (backlog 194's flight). */
  function sendNow(): void {
    if (!reducedMotion()) launch("chat", bubbleEl?.querySelector(".user-bubble") ?? bubbleEl);
    void sendScheduledNow(key);
  }
</script>

{#if s}
  <div class="sched-bubble" class:warn data-scheduled-bubble role="status" aria-label="scheduled message, not sent yet">
    <div class="sb-key">
      <span class="sb-clock" aria-hidden="true"></span>
      <span class="sb-state" data-sched-head>{head}</span>
      {#if !s.persist}
        <span class="ns-chip mono" use:tip={"An incognito or ephemeral chat writes nothing to disk, this included: quitting the app forgets this message."}>kept until you quit</span>
      {/if}
      <span class="ns-k">You</span>
    </div>
    <div class="sb-bubble" bind:this={bubbleEl}>
      <FoldText foldKey={`s:${key}`}>
        <UserBubble text={s.text} {images} {documents} {sending} />
      </FoldText>
    </div>
    <div class="sb-actions" role="group" aria-label="this message is scheduled, not sent">
      <!-- Greyed while a delivery of it is in flight (backlog 535): one message, one send. -->
      <WaitAct icon="send" accent label="Send now" hint="send it now, without waiting" data-sb="send-now" disabled={!!s.claimed} onclick={sendNow} />
      {#if s.state === "missed"}
        <WaitAct icon="check" label="Keep" hint="keep it here, unscheduled" data-sb="keep" onclick={() => keepScheduled(key)} />
      {:else}
        <WaitAct icon="pencil" label="Edit" hint="unschedule it and put the words and files back in the box" data-sb="edit" onclick={() => void giveBack()} />
      {/if}
      <WaitAct icon="x" label="Cancel" hint="unschedule it; the words and files go back in the box" data-sb="cancel" onclick={() => void giveBack()} />
    </div>
  </div>
{/if}

<style>
  .sched-bubble {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    margin: 14px 0;
  }
  .sb-key {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sb-state {
    font-size: 11.5px;
    color: var(--dim);
  }
  .warn .sb-state {
    color: var(--warn, var(--accent));
  }
  /* A clock face: it waits for a time, not for a turn. */
  .sb-clock {
    position: relative;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--dim);
    box-sizing: border-box;
  }
  .sb-clock::after {
    content: "";
    position: absolute;
    left: 3px;
    top: 1px;
    width: 1.5px;
    height: 3px;
    background: var(--dim);
    box-shadow: 1px 2px 0 -0.25px var(--dim);
  }
  .sb-bubble {
    max-width: 100%;
    min-width: 0;
  }
  .sb-bubble :global(.user-bubble) {
    opacity: 0.55;
    filter: saturate(0.5);
    border: 1px dashed var(--line2, var(--line));
  }
  .sb-actions {
    display: flex;
    justify-content: flex-end;
    gap: 2px;
  }
</style>
