<script lang="ts">
  /**
   * The ▾ half of Send (nightshift backlog 224, blocker 465): send this
   * message at the five-hour reset, at the weekly reset, or at a time he
   * types. The sidebar's *New chat ▾* split button is the look: Send keeps
   * its left corners, this carries the right ones. A row is greyed with its
   * reason when it cannot be used; the whole menu when `blocked` says so.
   */
  import { app, chatMode } from "./state.svelte";
  import { floatMenu } from "./floatMenu";
  import { tip } from "./tip";
  import { atTime, clockText, dayClockText, resetTime, type ScheduleKind } from "./schedule";
  import { scheduleSend, scheduledFor } from "./scheduled.svelte";

  let {
    key,
    text,
    blocked = null,
    disabled = false,
    onscheduled,
  }: {
    key: string;
    text: string;
    /** Why nothing can be scheduled here (a new chat, attachments). */
    blocked?: string | null;
    disabled?: boolean;
    onscheduled: () => void;
  } = $props();

  let open = $state(false);
  let btn = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLElement | null>(null);
  let when = $state("");
  let now = $state(Date.now());

  const five = $derived(resetTime(app.planUsage?.five_hour_resets_at, now));
  const week = $derived(resetTime(app.planUsage?.seven_day_resets_at, now));
  const typed = $derived(atTime(when, now));
  const empty = $derived(!text.trim());
  const already = $derived(scheduledFor(key) !== null);
  /** Why every row is greyed, if one reason covers them all. */
  const allOff = $derived(
    blocked ??
      (already
        ? "this chat already has a scheduled message — Edit or Cancel it first"
        : empty
          ? "type a message first"
          : null),
  );

  function toggle(): void {
    now = Date.now();
    if (!when) {
      // A suggestion: the next whole hour.
      const d = new Date(now);
      d.setHours(d.getHours() + 1, 0, 0, 0);
      when = `${String(d.getHours()).padStart(2, "0")}:00`;
    }
    open = !open;
  }

  function pick(kind: ScheduleKind, at: number | null): void {
    if (at === null || allOff) return;
    const persist = chatMode(app.events) === "normal";
    if (scheduleSend(key, text, kind, at, persist)) {
      open = false;
      onscheduled();
    }
  }

  function onDoc(e: MouseEvent): void {
    const t = e.target as Node;
    if (btn?.contains(t) || menuEl?.contains(t)) return;
    open = false;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      open = false;
      btn?.focus();
    }
  }
  $effect(() => {
    if (!open) return;
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  });
</script>

<button
  class="ns-btn accent sched-caret"
  bind:this={btn}
  use:tip={"Schedule this message: at the 5-hour reset, the weekly reset, or a time"}
  aria-label="Schedule send"
  aria-haspopup="menu"
  aria-expanded={open}
  {disabled}
  onclick={toggle}>▾</button
>
{#if open}
  <div
    class="sched-menu"
    role="menu"
    tabindex="-1"
    aria-label="Schedule send"
    bind:this={menuEl}
    use:floatMenu={{ anchor: btn, align: "right" }}
    onkeydown={onKey}
  >
    <div class="sched-head">Send later</div>
    {#if allOff}<div class="sched-why">{allOff}</div>{/if}
    <button
      type="button"
      class="sched-row"
      role="menuitem"
      disabled={!!allOff || five === null}
      onclick={() => pick("five_hour", five)}
    >
      <span class="sched-label">At the 5-hour reset{five !== null ? ` (${clockText(five)})` : ""}</span>
      <span class="sched-line"
        >{five === null ? "reset time unknown — no usage reading with one yet" : "sends a minute after the reset"}</span
      >
    </button>
    <button
      type="button"
      class="sched-row"
      role="menuitem"
      disabled={!!allOff || week === null}
      onclick={() => pick("seven_day", week)}
    >
      <span class="sched-label">At the weekly reset{week !== null ? ` (${dayClockText(week)})` : ""}</span>
      <span class="sched-line"
        >{week === null ? "reset time unknown — no usage reading with one yet" : "sends a minute after the reset"}</span
      >
    </button>
    <div class="sched-sep"></div>
    <div class="sched-row at" role="group" aria-label="At a time">
      <span class="sched-label">At a time…</span>
      <span class="sched-at">
        <input
          class="sched-time"
          type="time"
          aria-label="Send at"
          bind:value={when}
          disabled={!!allOff}
          onkeydown={(e) => {
            if (e.key === "Enter") pick("time", typed?.at ?? null);
          }}
        />
        <button
          type="button"
          class="ns-btn accent small"
          disabled={!!allOff || typed === null}
          onclick={() => pick("time", typed?.at ?? null)}>Schedule</button
        >
      </span>
      <span class="sched-line">{typed === null ? "type a time" : `${typed.tomorrow ? "tomorrow" : "today"} ${clockText(typed.at)}`}</span>
    </div>
  </div>
{/if}

<style>
  /* The split's narrow half: joined to Send, as New chat ▾ is in the
     sidebar. Send's right corners are squared by the composer. */
  .sched-caret {
    padding: 6px 7px;
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid rgba(0, 0, 0, 0.18);
    margin-left: -1px;
  }
  .sched-menu {
    position: fixed;
    z-index: 80;
    min-width: 260px;
    max-width: 340px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-family: var(--sans);
  }
  .sched-head {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    padding: 5px 8px 3px;
  }
  .sched-why {
    font-size: 11.5px;
    color: var(--dim);
    padding: 0 8px 4px;
  }
  .sched-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 6px 8px;
    border-radius: 6px;
    border: none;
    background: transparent;
    font-family: var(--sans);
    font-size: 12.5px;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }
  button.sched-row:hover:not(:disabled),
  button.sched-row:focus-visible {
    background: var(--well);
    outline: none;
  }
  .sched-row:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .sched-row.at {
    cursor: default;
  }
  .sched-line {
    font-size: 11px;
    color: var(--dim);
  }
  .sched-sep {
    height: 1px;
    background: var(--line2);
    margin: 4px 2px;
  }
  .sched-at {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 2px 0;
  }
  .sched-time {
    font: inherit;
    font-size: 12.5px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 3px 6px;
  }
</style>
