<script lang="ts">
  /**
   * The per-turn council control (nightshift backlog 149, blocker 243):
   * a popover above the composer's *Council* button with the roster and
   * the mode for this turn, seeded from Settings → Council and remembered
   * per chat (`councilFor` / `setCouncilFor`), and *Send to the council*,
   * which sends the message in the box as a council turn. The next turn
   * is ordinary unless the button is used again.
   */
  import { app, councilFor, setCouncilFor } from "./state.svelte";
  import { AGENT_MODELS } from "./catalog";
  import { councilBudgetLine } from "./budget";
  import { MAX_SEATS, MIN_SEATS, lastCouncil, type CouncilMode, type CouncilPrefs, type Seat } from "./council";

  let {
    disabled = false,
    onsend,
    onclose,
  }: {
    /** Nothing in the box, or no connection: the send button is off. */
    disabled?: boolean;
    onsend: (prefs: CouncilPrefs) => void;
    onclose: () => void;
  } = $props();

  // A copy of the chat's remembered roster, written back on every change
  // so reopening shows what was last set here.
  let prefs = $state<CouncilPrefs>(structuredClone(councilFor(app.activeSessionId)));
  function keep(): void {
    setCouncilFor(app.activeSessionId, prefs);
  }
  const models = AGENT_MODELS.filter((m) => m !== "");
  function setModel(i: number, model: string): void {
    prefs.seats[i] = { ...prefs.seats[i], model };
    keep();
  }
  function remove(i: number): void {
    if (prefs.seats.length <= MIN_SEATS) return;
    prefs.seats.splice(i, 1);
    keep();
  }
  function add(): void {
    if (prefs.seats.length >= MAX_SEATS) return;
    const last = prefs.seats[prefs.seats.length - 1];
    const seat: Seat = { model: last?.model ?? "opus", engine: "subscription" };
    prefs.seats.push(seat);
    keep();
  }
  function setMode(mode: CouncilMode): void {
    prefs.mode = mode;
    keep();
  }
  // The areas rule (blocker 240): when the last council turn's sources
  // overlapped past the threshold, the next turn assigns the chair's gaps.
  const last = $derived(lastCouncil(app.events));
  const areas = $derived(last?.fired ? last.areas_next : []);

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }
</script>

<div class="pick-menu council-menu" role="dialog" aria-label="Council" tabindex="-1" {onkeydown}>
  <div class="pick-head"><span>Council</span><span class="pick-sub">this turn · remembered on this chat</span></div>
  <div class="council-rows">
    {#each prefs.seats as seat, i (i)}
      <div class="council-row">
        <span class="council-n">seat {i + 1}</span>
        <select class="council-select" value={seat.model} onchange={(e) => setModel(i, e.currentTarget.value)} aria-label="seat {i + 1} model">
          {#each models as m (m)}
            <option value={m}>{m}</option>
          {/each}
        </select>
        <span class="council-engine">subscription</span>
        <button
          class="remove"
          title={prefs.seats.length <= MIN_SEATS ? `A council needs ${MIN_SEATS} seats` : "Remove this seat"}
          aria-label="remove seat {i + 1}"
          disabled={prefs.seats.length <= MIN_SEATS}
          onclick={() => remove(i)}>×</button
        >
      </div>
    {/each}
  </div>
  <div class="council-line">
    <button class="ns-btn ghost small" disabled={prefs.seats.length >= MAX_SEATS} onclick={add}>+ seat</button>
    <span class="council-hint">the chair is this chat's model; a seat on it reads the chat's cache, the others start cold</span>
  </div>
  <div class="council-line council-mode" role="radiogroup" aria-label="Mode">
    <button class="ns-chip" class:on={prefs.mode === "answer"} role="radio" aria-checked={prefs.mode === "answer"} onclick={() => setMode("answer")}
      >answer</button
    >
    <button class="ns-chip" class:on={prefs.mode === "disproof"} role="radio" aria-checked={prefs.mode === "disproof"} onclick={() => setMode("disproof")}
      >disproof</button
    >
    <span class="council-hint">
      {prefs.mode === "answer"
        ? "each seat answers the message with its own searches; the chair writes agreed · disputed · one-member-only · its answer"
        : "each seat searches for what already exists or contradicts the idea and returns a hits table — no verdict, no score"}
    </span>
  </div>
  {#if areas.length > 0}
    <div class="council-line council-areas">
      <span class="council-hint">
        Last time every seat cited {Math.round((last?.overlap.shared_by_all ?? 0) * 100)}% of the same sources, so this turn assigns areas:
        {#each areas as a, i (i)}<span class="council-area">seat {(i % prefs.seats.length) + 1} → {a}</span>{/each}
      </span>
    </div>
  {/if}
  <!-- The budget (nightshift backlog 165, pass 2): a council turn counts
       its seats against the message's share of the window like
       subagents, so the number is here before the send. -->
  <div class="council-line council-budget">
    <span class="council-hint">{councilBudgetLine(app.draft.agentLimits.budget_pct, app.planUsage?.five_hour ?? null, app.draft.agentLimits.stop_at)}</span>
  </div>
  <div class="council-line council-send">
    <button class="ns-btn ghost small" onclick={onclose}>Cancel</button>
    <span class="spacer"></span>
    <button class="ns-btn accent small" {disabled} onclick={() => onsend(prefs)}>Send to the council</button>
  </div>
</div>

<style>
  .council-menu {
    min-width: 360px;
    max-width: 440px;
    gap: 6px;
  }
  .council-rows {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .council-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 6px;
    border-radius: 6px;
  }
  .council-n {
    font-size: 11px;
    color: var(--dim);
    width: 44px;
  }
  .council-select {
    font: inherit;
    font-size: 12px;
    background: var(--bg);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 2px 6px;
  }
  .council-engine {
    font-size: 11px;
    color: var(--dim);
    flex: 1;
  }
  .remove {
    background: none;
    border: none;
    color: var(--dim);
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
  }
  .remove:hover:not(:disabled) {
    color: var(--ink);
  }
  .remove:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .council-line {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 6px;
  }
  .council-hint {
    font-size: 11px;
    color: var(--dim);
    line-height: 1.35;
  }
  .council-mode .ns-chip.on {
    color: var(--accent-ink);
    border-color: var(--accent);
  }
  .council-areas {
    border-top: 1px solid var(--line2);
    padding-top: 6px;
  }
  .council-area {
    display: block;
    color: var(--ink2);
  }
  .council-send {
    border-top: 1px solid var(--line2);
    padding-top: 8px;
  }
  .spacer {
    flex: 1;
  }
  /* The composer's menu frame, restated here since the popover is its own
     component: the same sheet, border, shadow and placement. */
  .pick-menu {
    position: absolute;
    z-index: 70;
    bottom: calc(100% + 8px);
    right: 0;
    max-height: 70vh;
    overflow-y: auto;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    padding: 8px;
    display: flex;
    flex-direction: column;
    font-family: var(--sans);
  }
  .pick-head {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 2px 6px 4px;
  }
  .pick-sub {
    text-transform: none;
    letter-spacing: 0;
  }
</style>
