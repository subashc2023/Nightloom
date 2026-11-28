<script lang="ts">
  // "Left it?" in the window's corner (nightshift item 771, his pick C on blocker 2362: "opens for a couple
  // seconds each day in the bottom right corner of the screen"). Once a day, the first of today's "left behind"
  // chats arrives with the question card's lock-on (AskLock: brackets close in, the scanline, the corners
  // breathe; Classic gets its calm rise), stays `CARD_OPEN_MS`, then tucks itself away with no click. Hovering
  // keeps it open; leaving gives it `CARD_LINGER_MS` more. It never opens while a reply streams in the chat in
  // front of him, while a toast or notice holds the corner, nor with the window in the background — it waits for the next quiet moment that day — and
  // a reply starting there while it is open tucks it away at once. The same answers as Home's block, which
  // keeps the chat until tomorrow.
  import { onDestroy, onMount } from "svelte";
  import { fly } from "svelte/transition";
  import AskLock from "./AskLock.svelte";
  import { tip } from "./tip";
  import { reducedMotion } from "./sendMotion";
  import { app, liveChats } from "./state.svelte";
  import { CARD_DELAY_MS, CARD_LINGER_MS, CARD_OPEN_MS, chatName, whyLine, type Row } from "./leftBehind";
  import { cardDue, markCardShown, openLeft, refreshLeftBehind, rowsNow, settleLeft, snoozeLeft } from "./leftBehind.svelte";

  let shown = $state<Row | null>(null);
  let hovered = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let tryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRead = 0;

  const readingLive = $derived(liveChats().some((c) => c.onScreen));
  /** The toasts and waiting notices share this corner: the card waits for it to be empty. */
  const cornerBusy = $derived(app.toasts.length > 0 || app.pendingApprovals.length > 0 || Object.keys(app.background).length > 0);
  const quiet = () => !readingLive && !cornerBusy && typeof document !== "undefined" && !document.hidden && document.hasFocus();

  /** Try to open today's card; else try again in 30 s (the listing is re-read at most every 10 minutes). */
  async function attempt(): Promise<void> {
    clearTimeout(tryTimer);
    if (cardDue() && quiet()) {
      if (Date.now() - lastRead > 600_000) {
        lastRead = Date.now();
        await refreshLeftBehind();
      }
      const first = rowsNow().find((r) => !r.done) ?? null;
      if (first && cardDue() && quiet()) {
        shown = first;
        markCardShown();
        arm(CARD_OPEN_MS);
      }
    }
    tryTimer = setTimeout(() => void attempt(), 30_000);
  }
  function arm(ms: number): void {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!hovered) shown = null;
    }, ms);
  }
  function enter(): void {
    hovered = true;
    clearTimeout(closeTimer);
  }
  function leave(): void {
    hovered = false;
    if (shown) arm(CARD_LINGER_MS);
  }
  function done(fn: () => void): void {
    fn();
    shown = null;
  }
  // A reply starting in the chat in front, or a toast or notice taking the corner, tucks it away at once.
  $effect(() => {
    if ((readingLive || cornerBusy) && shown) shown = null;
  });
  onMount(() => {
    tryTimer = setTimeout(() => void attempt(), CARD_DELAY_MS);
  });
  onDestroy(() => {
    clearTimeout(closeTimer);
    clearTimeout(tryTimer);
  });
  const out = () => (reducedMotion() ? { duration: 0 } : { x: 24, duration: 220, opacity: 0 });
</script>

{#if shown}
  {@const r = shown}
  {@const name = chatName(r.chat)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="lc hud-m lk-shell" role="group" aria-label="Left it?" data-left-card onpointerenter={enter} onpointerleave={leave} onfocusin={enter} onfocusout={leave} out:fly={out()}>
    <AskLock header=".lc-head" />
    <div class="hud-head lc-head">Left it?</div>
    <p class="lc-name" use:tip={r.chat.project ? `In ${r.chat.project.name}` : "Not in a project"}>{name}</p>
    <p class="lc-why">{whyLine(r)} · {r.days} day{r.days === 1 ? "" : "s"}</p>
    <div class="lc-acts">
      <button class="ns-btn accent" use:tip={r.level === "high" ? "Open it at the reply" : "Open it where you stopped reading"} onclick={() => done(() => void openLeft(r))}>{r.level === "high" ? "Open" : "Open where I stopped"}</button>
      <button class="ns-btn" use:tip={"Move it to Settled in the sidebar\nWrite in it and it comes back"} onclick={() => done(() => settleLeft(r.chat.id, name))}>Left it</button>
      <button class="ns-btn ghost" use:tip={"Not asked about again for 7 days"} onclick={() => done(() => snoozeLeft(r.chat.id))}>Not now</button>
    </div>
  </div>
{/if}

<style>
  /* Classic: the toasts' own panel. Jarvis: the shared HUD card (hudMenu.css `.hud-m`) over this. */
  .lc {
    pointer-events: auto;
    width: min(300px, calc(100vw - 2rem));
    padding: 10px 12px;
    border: 1px solid var(--border, var(--line2));
    border-radius: 8px;
    background: var(--panel, var(--raised));
    color: var(--text, var(--ink));
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .lc-head {
    font: 500 10px var(--mono, ui-monospace, monospace);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2, var(--dim));
  }
  .lc-name {
    margin: 6px 0 0;
    font-size: 13.5px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .lc-why {
    margin: 1px 0 0;
    font-size: 12px;
    color: var(--ink2, var(--dim));
  }
  .lc-acts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  /* Jarvis's card Open: the HUD menu's terminal-glass accent (as the mock copied it). */
  :global(:root:not([data-layout="classic"])) .lc .ns-btn.accent {
    background: var(--term);
    border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--line2));
    color: var(--accent-ink);
    box-shadow: inset 0 0 10px color-mix(in srgb, var(--accent) 14%, transparent), var(--glow-main, none);
  }
</style>
