<script lang="ts">
  /**
   * The Mac's rail from the phone (item 246, wave 1C; blocker 666's
   * default: engine and turn settings yes, keys and pickers no): model,
   * effort, fallback, the approval switch, fork mode and the subagent
   * limits. A pill or a switch applies at once, as the rail's own do (the
   * Mac merges the patch and reconnects); the limits' numbers gather here
   * and go on Apply, so a run of taps is one reconnect. Rendered inside the
   * page's sheet; the page talks to the Mac (`onpatch`).
   */
  import { AGENT_MODELS, SUBAGENT_MODELS, SUBAGENT_MODEL_LABELS, type SubagentLimits, type SubagentModel } from "../lib/catalog";
  import type { Rail, RailPatch } from "./client";

  interface Props {
    rail: Rail | null;
    /** A sentence while the rail cannot be read (an old Mac, offline). */
    problem: string | null;
    /** A turn is running: the Mac applies a change from the next turn. */
    busy: boolean;
    onpatch: (patch: RailPatch) => Promise<boolean>;
  }
  let { rail, problem, busy, onpatch }: Props = $props();

  const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
  const ALIASES = AGENT_MODELS.filter(Boolean);
  const LIMIT_ROWS: { key: "per_turn" | "concurrent" | "depth"; label: string; min: number; max: number }[] = [
    { key: "per_turn", label: "Subagents a turn", min: 0, max: 50 },
    { key: "concurrent", label: "At once", min: 1, max: 20 },
    { key: "depth", label: "Depth", min: 1, max: 6 },
  ];

  let saving = $state(false);
  /** The limits as edited here, before Apply; null when untouched. Kept
   *  while the sheet is closed, so nothing typed is lost to a stray tap. */
  let limits = $state<SubagentLimits | null>(null);

  const shown = $derived(limits ?? rail?.limits ?? null);
  const approval = $derived(rail?.plan ? "plan" : rail?.ask ? "ask" : "auto");
  const otherModel = $derived(rail?.model && !ALIASES.includes(rail.model) ? rail.model : null);

  async function apply(patch: RailPatch) {
    if (saving) return;
    saving = true;
    await onpatch(patch);
    saving = false;
  }

  function step(key: "per_turn" | "concurrent" | "depth", by: number, min: number, max: number) {
    const base = shown;
    if (!base) return;
    const next = Math.min(max, Math.max(min, (base[key] ?? 0) + by));
    limits = { ...base, [key]: next };
  }

  async function applyLimits() {
    if (!limits || saving) return;
    saving = true;
    const ok = await onpatch({ limits });
    saving = false;
    if (ok) limits = null;
  }
</script>

<div class="rs-title">Model and settings</div>
<p class="rs-note">
  {#if problem}{problem}{:else if !rail}Reading the Mac's rail…{:else}The Mac's rail{rail.engine ? ` · ${rail.engine === "claude-code" ? "Claude Code" : rail.engine}` : ""} — a change applies on the Mac{busy ? " from the next turn" : ""}.{/if}
</p>
{#if rail && !problem}
  {#if rail.error}<p class="rs-bad">{rail.error}</p>
  {:else if rail.deferred}<p class="rs-note">Waiting for the running turn: the Mac connects with this after it ends.</p>
  {:else if rail.connecting}<p class="rs-note">The Mac is reconnecting…</p>{/if}
{/if}

{#if rail}
  {#if rail.model !== undefined}
    <div class="rs-label">Model</div>
    <div class="rs-pills" role="radiogroup" aria-label="Model">
      <button class:on={!rail.model} disabled={saving} onclick={() => apply({ model: "" })}>default</button>
      {#each ALIASES as a (a)}
        <button class:on={rail.model === a} disabled={saving} onclick={() => apply({ model: a })}>{a}</button>
      {/each}
      {#if otherModel}<button class="on" disabled>{otherModel}</button>{/if}
    </div>
  {/if}

  {#if rail.effort !== undefined}
    <div class="rs-label">Effort</div>
    <div class="rs-seg" role="radiogroup" aria-label="Effort">
      {#each EFFORTS as e (e)}
        <button class:on={(rail.effort ?? "") === e} disabled={saving} onclick={() => apply({ effort: e })}>{e || "default"}</button>
      {/each}
    </div>
  {/if}

  {#if rail.fallback !== undefined}
    <div class="rs-label">When overloaded, fall back to</div>
    <div class="rs-pills" role="radiogroup" aria-label="Fallback model">
      <button class:on={!rail.fallback} disabled={saving} onclick={() => apply({ fallback: "" })}>none</button>
      {#each ALIASES as a (a)}
        <button class:on={rail.fallback === a} disabled={saving} onclick={() => apply({ fallback: a })}>{a}</button>
      {/each}
    </div>
  {/if}

  {#if rail.ask !== undefined || rail.plan !== undefined}
    <div class="rs-label">Approvals</div>
    <div class="rs-seg" role="radiogroup" aria-label="Approvals">
      <button class:on={approval === "auto"} disabled={saving} onclick={() => apply({ ask: false, plan: false })}>Auto</button>
      <button class:on={approval === "ask"} disabled={saving} onclick={() => apply({ ask: true, plan: false })}>Ask</button>
      <button class:on={approval === "plan"} disabled={saving} onclick={() => apply({ ask: true, plan: true })}>Plan</button>
    </div>
  {/if}

  {#if rail.fork_mode !== undefined}
    <button class="rs-switch" role="switch" aria-checked={!!rail.fork_mode} disabled={saving} onclick={() => apply({ fork_mode: !rail!.fork_mode })}>
      <span class="rs-grow">
        Fork helpers
        <small>the model may fork the chat for a side task, at cache-read cost</small>
      </span>
      <span class="rs-knob" class:on={rail.fork_mode}></span>
    </button>
  {/if}

  {#if shown}
    <div class="rs-label">Subagent limits</div>
    <div class="rs-box">
      {#each LIMIT_ROWS as l (l.key)}
        <div class="rs-row">
          <span class="rs-grow">{l.label}{shown.off?.[l.key] ? " · off" : ""}</span>
          <button class="rs-step" aria-label="Fewer" disabled={saving || shown[l.key] <= l.min} onclick={() => step(l.key, -1, l.min, l.max)}>−</button>
          <span class="rs-num">{shown[l.key]}</span>
          <button class="rs-step" aria-label="More" disabled={saving || shown[l.key] >= l.max} onclick={() => step(l.key, 1, l.min, l.max)}>+</button>
        </div>
      {/each}
      <div class="rs-row col">
        <span>Subagents run on</span>
        <div class="rs-seg small" role="radiogroup" aria-label="Subagent model">
          {#each SUBAGENT_MODELS as m (m)}
            <button class:on={shown.model === m} disabled={saving} onclick={() => (limits = { ...shown!, model: m as SubagentModel })}>{m}</button>
          {/each}
        </div>
        <small>{SUBAGENT_MODEL_LABELS[shown.model] ?? ""}</small>
      </div>
    </div>
    {#if limits}
      <div class="rs-actions">
        <button class="rs-btn" disabled={saving} onclick={() => (limits = null)}>Undo changes</button>
        <span class="rs-grow"></span>
        <button class="rs-btn accent" disabled={saving} onclick={applyLimits}>Apply limits</button>
      </div>
    {/if}
  {/if}
{/if}

<style>
  .rs-title {
    font-weight: 600;
    font-size: 17px;
  }
  .rs-note {
    font-size: 13px;
    color: var(--dim);
    margin: -6px 0 0;
  }
  .rs-bad {
    font-size: 13px;
    color: var(--failed);
    margin: 0;
  }
  .rs-label {
    font-size: 13px;
    color: var(--dim);
    margin: 4px 0 -4px;
  }
  .rs-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .rs-pills button,
  .rs-seg button {
    all: unset;
    cursor: pointer;
    min-height: 38px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 19px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
  }
  .rs-seg {
    display: flex;
    background: var(--paper);
    border-radius: 12px;
    padding: 3px;
    gap: 2px;
  }
  .rs-seg button {
    flex: 1;
    border: none;
    border-radius: 9px;
    padding: 0 4px;
    font-size: 14px;
    min-width: 0;
  }
  .rs-seg.small button {
    min-height: 34px;
  }
  .rs-pills button.on,
  .rs-seg button.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-color: var(--accent);
    font-weight: 600;
  }
  .rs-pills button:disabled:not(.on),
  .rs-seg button:disabled:not(.on) {
    opacity: 0.5;
  }
  .rs-switch {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: var(--paper);
    border-radius: 14px;
    cursor: pointer;
  }
  .rs-switch small,
  .rs-row small {
    display: block;
    font-size: 12px;
    color: var(--dim);
  }
  .rs-grow {
    flex: 1;
    min-width: 0;
  }
  .rs-knob {
    width: 46px;
    height: 28px;
    border-radius: 14px;
    background: var(--line2);
    position: relative;
    flex: none;
    transition: background 0.2s;
  }
  .rs-knob::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--sheet);
    transition: transform 0.2s;
  }
  .rs-knob.on {
    background: var(--accent);
  }
  .rs-knob.on::after {
    transform: translateX(18px);
  }
  .rs-box {
    background: var(--paper);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
  }
  .rs-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 50px;
    padding: 0 10px 0 14px;
  }
  .rs-row + .rs-row {
    border-top: 1px solid var(--line);
  }
  .rs-row.col {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 10px 14px;
  }
  .rs-step {
    all: unset;
    cursor: pointer;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    border: 1px solid var(--line2);
    display: grid;
    place-items: center;
    font-size: 20px;
    box-sizing: border-box;
  }
  .rs-step:disabled {
    opacity: 0.35;
  }
  .rs-num {
    min-width: 28px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .rs-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .rs-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
  }
  .rs-btn:disabled {
    opacity: 0.4;
  }
  .rs-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
</style>
