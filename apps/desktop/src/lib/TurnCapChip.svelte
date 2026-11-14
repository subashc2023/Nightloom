<script lang="ts">
  import { hudIn, hudOut } from "./hudMenu";
  /**
   * The cap chip (nightshift item 538, part 2): above the message box while
   * the chat's message runs under a declared usage cap — its percent, its
   * mode, who set it, and how far through it the message is. A click opens
   * a small popover: change the percent, flip the mode in one click, or
   * remove the cap, through `set_turn_cap` (`turnCap.ts`). No cap: nothing
   * is drawn, so nothing else moves.
   *
   * Filament IV: a card like the browser chip beside it, with a small ring
   * in the context dial's colours — amber arc, its glow, the hot colour
   * near the cap — eased once on each new reading. Classic (`plain`): the
   * same words and controls in the Classic chip's flat look, no ring and
   * no motion.
   */
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { CAP_STEP, capChipChat, capView, clampCap, correctCap, modeLong, otherMode } from "./turnCap";
  import type { CapMode } from "./types";

  let { plain = false }: { plain?: boolean } = $props();

  const chat = $derived(capChipChat());
  const view = $derived(chat ? capView(app.turnBudget) : null);

  let open = $state(false);
  let draft = $state(50);
  let busy = $state(false);
  let root: HTMLDivElement | undefined = $state();

  // The ring: 18 px, one arc of the allowance.
  const R = 7;
  const C = 2 * Math.PI * R;
  const dash = $derived(view ? `${(C * view.fill).toFixed(2)} ${C.toFixed(2)}` : `0 ${C}`);

  function toggle(): void {
    if (!view) return;
    if (!open) draft = view.percent;
    open = !open;
  }

  async function apply(percent: number | null, mode: CapMode | null): Promise<void> {
    if (!chat || busy) return;
    busy = true;
    const ok = await correctCap(chat, percent, mode);
    busy = false;
    if (ok && percent === null && mode === null) open = false;
  }

  const MODES: CapMode[] = ["work_to_cap_then_continue", "finish_within"];

  // Escape or a click outside closes the popover (Escape goes no further,
  // so it does not also reach the composer's own Escape).
  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      open = false;
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
    };
  });

  // The chip goes when the message ends; so does the popover.
  $effect(() => {
    if (!view) open = false;
  });
</script>

{#if view}
  <div class="cap-wrap" class:plain bind:this={root}>
    <button
      class="cap-chip"
      data-phase={view.phase}
      data-source={view.source}
      data-locked={view.locked ? "" : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Usage cap ${view.percent}%, ${view.modeShort}, ${view.sourceWords}`}
      use:tip={view.tip}
      onclick={toggle}
    >
      {#if !plain}
        <svg class="ring" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <circle class="ring-track" cx="9" cy="9" r={R} />
          <circle class="ring-arc" cx="9" cy="9" r={R} stroke-dasharray={dash} transform="rotate(-90 9 9)" />
        </svg>
      {/if}
      <span class="cap-k">cap</span>
      <span class="cap-n">{view.percent}%</span>
      <span class="cap-mode">{view.modeShort}</span>
      <span class="cap-sep" aria-hidden="true">·</span>
      <span class="cap-src">{view.sourceWords}{#if view.locked}<span class="cap-lock" aria-label="you corrected it"> ✓</span>{/if}</span>
      {#if view.latest !== null}
        <span class="cap-sep" aria-hidden="true">·</span>
        <span class="cap-spent mono">
          {#if view.spent !== null && view.allowance !== null}{view.spent} of {view.allowance} pts spent{:else}now {view.latest}%{/if}
        </span>
      {/if}
    </button>
    {#if open}
      <div class="cap-pop hud-m" role="dialog" aria-label="Change this message's usage cap" in:hudIn|global out:hudOut|global>
        <div class="pop-head">This message's cap</div>
        <div class="pop-sub">
          {#if view.latest !== null}{`5-hour window now ${view.latest}%${view.spent !== null ? ` · ${view.spent} pts spent` : ""}`}{:else}No usage reading yet{/if}
        </div>
        <div class="pop-row">
          <button class="ns-btn small step" aria-label="Lower the cap" disabled={busy || draft <= 1} onclick={() => (draft = clampCap(draft - CAP_STEP))}>−</button>
          <label class="pct">
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              aria-label="Cap percent"
              bind:value={draft}
              onkeydown={(e) => {
                if (e.key === "Enter") void apply(clampCap(draft), null);
              }}
            /><span>%</span>
          </label>
          <button class="ns-btn small step" aria-label="Raise the cap" disabled={busy || draft >= 100} onclick={() => (draft = clampCap(draft + CAP_STEP))}>+</button>
          <button class="ns-btn small primary" disabled={busy || clampCap(draft) === view.percent} onclick={() => void apply(clampCap(draft), null)}>Set</button>
        </div>
        <div class="pop-modes" role="radiogroup" aria-label="How to work under the cap">
          {#each MODES as m (m)}
            <button
              class="mode"
              class:on={view.mode === m}
              role="radio"
              aria-checked={view.mode === m}
              disabled={busy}
              onclick={() => {
                if (view && view.mode !== m) void apply(null, otherMode(view.mode));
              }}>{modeLong(m)}</button
            >
          {/each}
        </div>
        <div class="pop-foot">
          <span class="pop-who">{view.locked ? "You corrected it: Claude's calls no longer change it." : `Now ${view.sourceWords}.`}</span>
          <button class="ns-btn small ghost" disabled={busy} onclick={() => void apply(null, null)}>Remove cap</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .cap-wrap {
    position: relative;
    max-width: 760px;
    margin: 0 auto 8px;
    display: flex;
  }
  .cap-chip {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    max-width: 100%;
    padding: 4px 11px 4px 7px;
    background: var(--raised);
    border: 1px solid var(--line2);
    border-radius: 999px;
    font-size: 12px;
    color: var(--ink2);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .cap-chip:hover,
  .cap-chip[aria-expanded="true"] {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line2));
  }
  .cap-chip:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 2px;
  }
  .ring {
    flex: none;
    display: block;
  }
  .ring-track {
    fill: none;
    stroke: var(--well);
    stroke-width: 2.5;
  }
  .ring-arc {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    stroke-linecap: round;
    filter: drop-shadow(var(--glow-accent, 0 0 0 transparent));
  }
  [data-phase="near"] .ring-arc,
  [data-phase="at"] .ring-arc {
    stroke: var(--hot);
    filter: none;
  }
  .cap-k {
    font: 10.5px var(--mono);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .cap-n {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
  [data-phase="near"] .cap-n,
  [data-phase="at"] .cap-n {
    color: var(--hot);
  }
  .cap-mode {
    color: var(--ink2);
  }
  .cap-sep {
    color: var(--dim);
  }
  .cap-src {
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  [data-source="user"] .cap-src,
  [data-locked] .cap-src {
    color: var(--accent);
  }
  .cap-lock {
    font-weight: 600;
  }
  .cap-spent {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }

  .cap-pop {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 40;
    width: 300px;
    padding: 12px;
    background: var(--raised);
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.28);
    font-size: 12.5px;
    color: var(--ink2);
  }
  .pop-head {
    font-weight: 600;
    color: var(--ink);
  }
  .pop-sub {
    margin-top: 2px;
    font: 11px var(--mono);
    color: var(--dim);
  }
  .pop-row {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .step {
    width: 28px;
    justify-content: center;
  }
  .pct {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 8px;
    border: 1px solid var(--line2);
    border-radius: var(--r1, 6px);
    background: var(--well);
  }
  .pct input {
    width: 3.2em;
    border: 0;
    background: transparent;
    color: var(--ink);
    font: 600 14px var(--sans);
    font-variant-numeric: tabular-nums;
    text-align: right;
    outline: none;
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .pct input::-webkit-inner-spin-button,
  .pct input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .pct span {
    color: var(--dim);
  }
  .primary {
    margin-left: auto;
  }
  .pop-modes {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .mode {
    all: unset;
    box-sizing: border-box;
    padding: 6px 9px;
    border: 1px solid var(--line2);
    border-radius: var(--r1, 6px);
    cursor: pointer;
    color: var(--ink2);
    line-height: 1.3;
  }
  .mode:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--line2));
  }
  .mode:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }
  .mode.on {
    border-color: var(--accent);
    color: var(--ink);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .pop-foot {
    margin-top: 10px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pop-who {
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    color: var(--dim);
  }

  /* The one motion (Filament IV): a new reading eases the arc once; near
     the cap the ring breathes slowly, as the dial's notch does. */
  @media (prefers-reduced-motion: no-preference) {
    .ring-arc {
      transition:
        stroke-dasharray 600ms cubic-bezier(0.2, 0.7, 0.2, 1),
        stroke 300ms ease;
    }
    [data-phase="near"] .ring {
      animation: cap-breathe 5.6s ease-in-out infinite;
    }
    .cap-chip {
      transition: border-color 160ms ease;
    }
  }
  @keyframes cap-breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.72;
    }
  }

  /* Classic: the flat chip of its layout — square-ish, no ring, nothing
     moves. */
  .plain .cap-chip {
    border-radius: var(--r1, 4px);
    padding: 3px 9px;
    background: transparent;
    transition: none;
  }
  .plain .cap-pop {
    box-shadow: none;
  }
</style>
