<script lang="ts">
  /**
   * The scheduled message waiting in this chat (nightshift backlog 224,
   * blockers 466–468): above the composer, joined to it like the queue
   * tray. It says when it goes and what it waits for; Edit and Cancel put
   * the words back in the box, so nothing is lost. A message missed while
   * the app was closed asks — *Send now*, *Keep*, *Cancel* — and is never
   * sent by itself.
   */
  import { tip } from "./tip";
  import { clockText, dueAt, kindText } from "./schedule";
  import { cancelScheduled, keepScheduled, scheduledFor, sendScheduledNow } from "./scheduled.svelte";

  let { key, onedit }: { key: string; onedit: () => void } = $props();

  const s = $derived(scheduledFor(key));

  function when(ms: number): string {
    const d = new Date(ms);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay ? clockText(ms) : `${d.toLocaleDateString([], { weekday: "short" })} ${clockText(ms)}`;
  }

  function firstLine(t: string): string {
    const l = t.trim().split("\n")[0] ?? "";
    return l.length > 90 ? `${l.slice(0, 90)}…` : l;
  }

  const head = $derived.by(() => {
    if (!s) return "";
    const at = when(dueAt(s));
    switch (s.state) {
      case "missed":
        return `was due ${at} — the app was closed`;
      case "held":
        return "held — not scheduled";
      case "limited":
        return "not sent — still limited";
      case "retrying":
        return s.note ?? "still limited";
      default:
        return s.note ? `scheduled · ${at} · ${s.note}` : `scheduled · ${at} · ${kindText(s.kind)}`;
    }
  });
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
    <span class="sched-acts">
      {#if s.state !== "waiting" || s.note}
        <button class="ns-btn ghost small" onclick={() => void sendScheduledNow(key)}>Send now</button>
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
            cancelScheduled(key);
            onedit();
          }}>Edit</button
        >
      {/if}
      <button
        class="ns-btn ghost small"
        use:tip={"Unschedule; the words go back in the box"}
        onclick={() => {
          cancelScheduled(key);
          onedit();
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
  .sched-acts {
    display: flex;
    gap: 4px;
    flex: none;
  }
</style>
