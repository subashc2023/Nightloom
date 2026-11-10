<script lang="ts">
  /**
   * The scheduled message waiting in this chat (nightshift backlog 224,
   * blockers 466–468): above the composer, joined to it like the queue
   * tray. It says when it goes and what it waits for; Edit and Cancel put
   * the words back in the box, so nothing is lost. A message missed while
   * the app was closed asks — *Send now*, *Keep*, *Cancel* — and is never
   * sent by itself. Its files and images are named beside the words, and
   * Edit and Cancel put them back in the box too (backlog 531).
   */
  import { tip } from "./tip";
  import { scheduleHead } from "./schedule";
  import { cancelScheduled, keepScheduled, scheduledFor, sendScheduledNow } from "./scheduled.svelte";
  import { trackPending } from "./attachFiles.svelte";
  import { refreshSessions } from "./state.svelte";
  import { scheduleWhen, chipNames } from "./waitingChat";

  let { key, onedit }: { key: string; onedit: () => void } = $props();

  const s = $derived(scheduledFor(key));

  function firstLine(t: string): string {
    const l = t.trim().split("\n")[0] ?? "";
    return l.length > 90 ? `${l.slice(0, 90)}…` : l;
  }

  const head = $derived(s ? scheduleHead(s, scheduleWhen) : "");
  const files = $derived(s ? chipNames(s.attachments ?? []) : null);
</script>

{#if s}
  <div class="sched-chip" class:warn={s.state === "missed" || s.state === "limited"} role="status" aria-label="scheduled message">
    <span class="ns-chip mono sched-state">{head}</span>
    {#if !s.persist}
      <span
        class="ns-chip mono"
        use:tip={"An incognito or ephemeral chat writes nothing to disk, this included: quitting the app forgets this message."}
        >kept until you quit</span
      >
    {/if}
    <span class="sched-text" use:tip={s.text}>{firstLine(s.text)}</span>
    {#if files}<span class="ns-chip mono sched-files" data-sched-files use:tip={files.all}>{files.short}</span>{/if}
    <span class="sched-acts">
      {#if s.state !== "waiting" || s.note}
        <!-- Greyed while a delivery of it is in flight (backlog 535): one message, one send. -->
        <button class="ns-btn ghost small" disabled={!!s.claimed} onclick={() => void sendScheduledNow(key)}>Send now</button>
      {/if}
      {#if s.state === "missed"}
        <button class="ns-btn ghost small" use:tip={"Keep it here, unscheduled"} onclick={() => keepScheduled(key)}
          >Keep</button
        >
      {:else}
        <button
          class="ns-btn ghost small"
          use:tip={"Unschedule and put the words back in the box"}
          onclick={() => {
            cancelScheduled(key, trackPending);
            onedit();
            void refreshSessions();
          }}>Edit</button
        >
      {/if}
      <button
        class="ns-btn ghost small"
        use:tip={"Unschedule; the words go back in the box"}
        onclick={() => {
          cancelScheduled(key, trackPending);
          onedit();
          void refreshSessions();
        }}>Cancel</button
      >
    </span>
  </div>
{/if}

<style>
  .sched-chip {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0.4rem 0.6rem;
    border: 1px dashed var(--line2);
    border-radius: 8px;
    font-size: 13px;
    color: var(--ink);
    min-width: 0;
  }
  .sched-chip.warn .sched-state {
    color: var(--warn, var(--accent));
  }
  .sched-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--dim);
  }
  .sched-files {
    flex: none;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sched-acts {
    display: flex;
    gap: 4px;
    flex: none;
  }
</style>
