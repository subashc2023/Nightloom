<script lang="ts">
  import { hudIn, hudOut } from "./hudMenu";
  /**
   * The ▾ half of Send (nightshift backlog 224, blocker 465): send this
   * message at the five-hour reset, at the weekly reset, or at a time he
   * types. The sidebar's *New chat ▾* split button is the look: Send keeps
   * its left corners, this carries the right ones. A row is greyed with its
   * reason when it cannot be used; the whole menu when `blocked` says so.
   * From a New chat a pick makes the chat first (backlog 527), so the
   * message has an id to wait under. The box's files and images go with
   * it (backlog 531), copied to disk first (`stashChips`). The chat's
   * project is stored with the message (backlog 535).
   */
  import { app, chatMode, refreshSessions, startPendingChat } from "./state.svelte";
  import type { Attachment } from "./types";
  import { NEW_DRAFT_PREFIX } from "./drafts.svelte";
  import { floatMenu } from "./floatMenu";
  import { tip } from "./tip";
  import { atTime, clockText, dayClockText, resetTime, type ScheduleKind } from "./schedule";
  import { scheduleSend, scheduledFor, stashChips } from "./scheduled.svelte";
  import { scheduledHere } from "./scheduleRuntime";

  let {
    key,
    text,
    attachments = [],
    blocked = null,
    disabled = false,
    onscheduled,
  }: {
    key: string;
    text: string;
    /** The box's chips, which go with the message (backlog 531). */
    attachments?: Attachment[];
    /** Why nothing can be scheduled here (a chip still converting). */
    blocked?: string | null;
    disabled?: boolean;
    /** With the key it was held under: a New chat's is its new id. */
    onscheduled: (key: string) => void;
  } = $props();

  let open = $state(false);
  let btn = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLElement | null>(null);
  let when = $state("");
  let now = $state(Date.now());

  const five = $derived(resetTime(app.planUsage?.five_hour_resets_at, now));
  const week = $derived(resetTime(app.planUsage?.seven_day_resets_at, now));
  const typed = $derived(atTime(when, now));
  const empty = $derived(!text.trim() && attachments.length === 0);
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

  let starting = $state(false);

  async function pick(kind: ScheduleKind, at: number | null): Promise<void> {
    if (at === null || allOff || starting) return;
    const words = text;
    const chips = $state.snapshot(attachments) as Attachment[];
    let to = key;
    starting = true;
    let kept: Attachment[];
    try {
      // Copies first: nothing is made or cleared until the files are safe.
      kept = await stashChips(chips);
      if (key.startsWith(NEW_DRAFT_PREFIX)) {
        const id = await startPendingChat();
        if (id === null) return; // refused, toasted; the words stay in the box
        to = id;
      }
    } finally {
      starting = false;
    }
    const persist = chatMode(app.events) === "normal";
    // Its own project goes with it (backlog 535): it is delivered into
    // this project's chat whatever is open at its time. Only when that
    // chat is the one on screen is the open project surely its own; else
    // the first tick finds it from the chat's log.
    const here = app.activeSessionId === to;
    const project = here ? { id: app.project?.id ?? null, name: app.project?.name ?? null } : undefined;
    if (scheduleSend(to, words, kind, at, persist, kept, project)) {
      // The backend keeps this chat's agent spec for that send.
      if (here) scheduledHere(to);
      open = false;
      onscheduled(to);
      // The row is named by the scheduled message now (backlog 532).
      void refreshSessions();
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
    class="sched-menu hud-m"
    role="menu"
    tabindex="-1"
    aria-label="Schedule send"
    bind:this={menuEl}
    use:floatMenu={{ anchor: btn, align: "right" }}
    in:hudIn|global={{ anchor: btn }}
    out:hudOut|global
    onkeydown={onKey}
  >
    <div class="sched-head hud-head">Send later</div>
    {#if allOff}<div class="sched-why">{allOff}</div>{/if}
    <button
      type="button"
      class="sched-row"
      role="menuitem"
      disabled={!!allOff || five === null}
      onclick={() => void pick("five_hour", five)}
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
      onclick={() => void pick("seven_day", week)}
    >
      <span class="sched-label">At the weekly reset{week !== null ? ` (${dayClockText(week)})` : ""}</span>
      <span class="sched-line"
        >{week === null ? "reset time unknown — no usage reading with one yet" : "sends a minute after the reset"}</span
      >
    </button>
    <div class="sched-sep hud-rule"></div>
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
            if (e.key === "Enter") void pick("time", typed?.at ?? null);
          }}
        />
        <button
          type="button"
          class="ns-btn accent small"
          disabled={!!allOff || typed === null}
          onclick={() => void pick("time", typed?.at ?? null)}>Schedule</button
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

  /* Filament IV stage 6 (item 570, f4-menus.png's Send menu): a card in
     front, the ruled mono title, two-line rows whose name reads in the
     ink and whose line is grey, the time field a well. Behind
     `:where(:root:not([data-layout="classic"]))`; Classic's rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .sched-menu {
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.6);
  }
  :global(:where(:root:not([data-layout="classic"]))) .sched-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    color: var(--ink2);
    padding: 6px 8px 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .sched-head::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .sched-row {
    border-radius: var(--r1);
    padding: 7px 10px;
    font-size: 13px;
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) button.sched-row:hover:not(:disabled),
  :global(:where(:root:not([data-layout="classic"]))) button.sched-row:focus-visible {
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .sched-line {
    font-size: 11.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .sched-sep {
    margin: 4px 4px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .sched-time {
    background: var(--term);
    border-radius: var(--r1);
    font-family: var(--mono);
  }
  :global(:where(:root:not([data-layout="classic"]))) .sched-time:focus {
    outline: none;
    border-color: var(--accent);
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .sched-menu {
      animation: menu-rise 90ms ease-out;
    }
  }
  @keyframes menu-rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
</style>
