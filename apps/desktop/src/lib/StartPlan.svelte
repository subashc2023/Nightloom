<script lang="ts">
  /**
   * Start → Plan a shift (3.7): the backlog with a checkbox per item on the
   * left (same order, same drag reorder as 3.6, via `BacklogList`); until,
   * max units and budget on the right, a summary of the plan as it stands,
   * and Launch. A shift has no kind (SHIFT-CONTRACT §13.1a): each pass
   * follows its item's.
   *
   * `synthPlan()` seeds `planDraft` fresh — with a new shift id — every time
   * this screen is entered or the selected project changes; every edit
   * after that (selection, reorder, kind, bounds) mutates `planDraft`
   * locally. Nothing is written until Launch (`writeAndLaunch`), which
   * writes `plan.json` once and then launches the runner on it.
   */
  import { app, paneWidth, reorderItems, setPaneWidth, synthPlan, writeAndLaunch } from "./state.svelte";
  import { untrack } from "svelte";
  import { clockLabel, parseClockTime, untilFromTime } from "./nightshift";
  import BacklogList from "./BacklogList.svelte";
  import Grip from "./Grip.svelte";
  import Icon from "./Icon.svelte";

  let listWidth = $state(paneWidth("plan.list", 420));

  const itemList = $derived(app.nightshift.items);
  const items = $derived(itemList?.items ?? []);
  const order = $derived(itemList?.order ?? []);
  const row = $derived(app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null);
  const info = $derived(row?.nightshift ?? null);
  const locked = $derived(info?.live ?? false);
  const plan = $derived(app.nightshift.planDraft);

  // Re-seed the draft on entry and whenever the selected project changes —
  // and only then. `synthPlan` reads `rows` before its first await, so
  // without `untrack` every `nightshift-change` row refresh (the usage probe
  // rewrites `state/` every ~30s; a live runner writes `run.log`) would
  // re-seed the draft and drop the edits.
  $effect(() => {
    void app.nightshift.selected;
    untrack(() => void synthPlan());
  });

  const selectedIds = $derived(new Set((plan?.items ?? []).filter((i) => i.selected).map((i) => i.id)));
  const selectedCount = $derived(selectedIds.size);

  function toggle(id: string): void {
    const p = app.nightshift.planDraft;
    if (!p) return;
    const entry = p.items.find((i) => i.id === id);
    if (entry) entry.selected = !entry.selected;
    else p.items.push({ id, selected: true });
  }

  function onReorder(newOrder: string[]): void {
    void reorderItems(newOrder);
    const p = app.nightshift.planDraft;
    if (!p) return;
    const byId = new Map(p.items.map((i) => [i.id, i]));
    const next = newOrder.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    for (const entry of p.items) if (!newOrder.includes(entry.id)) next.push(entry);
    p.items = next;
  }

  // Local text mirrors of the draft's bound fields — reset whenever a fresh
  // plan arrives (its shift_id changes), left alone on every other render so
  // typing isn't fought.
  let untilTime = $state("");
  let maxUnitsText = $state("");
  let budgetText = $state("");
  $effect(() => {
    void plan?.shift_id;
    const p = app.nightshift.planDraft;
    untilTime = "";
    maxUnitsText = p?.max_units != null ? String(p.max_units) : "";
    budgetText = p?.budget_usd != null ? String(p.budget_usd) : "";
  });

  // Until is typed (`7am`, `10:30`, `noon`) or picked from the presets; the
  // draft takes the next occurrence of that time. A typed value that is not
  // a time leaves the draft unbounded and the hint says so.
  const UNTIL_PRESETS = ["6am", "7am", "9am", "noon"];
  const untilParsed = $derived(untilTime.trim() ? parseClockTime(untilTime) : null);
  function onUntilChange(): void {
    const p = app.nightshift.planDraft;
    if (!p) return;
    p.until = untilTime.trim() ? untilFromTime(untilTime) : null;
  }
  function pickUntil(preset: string): void {
    untilTime = untilTime.trim().toLowerCase() === preset ? "" : preset;
    onUntilChange();
  }

  function numOrNull(v: string): number | null {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function onMaxUnitsChange(): void {
    const p = app.nightshift.planDraft;
    if (p) p.max_units = numOrNull(maxUnitsText);
  }
  function onBudgetChange(): void {
    const p = app.nightshift.planDraft;
    if (p) p.budget_usd = numOrNull(budgetText);
  }
</script>

<div class="plan" style:grid-template-columns="minmax(0,1fr) 7px {listWidth}px">
  <div class="list-col">
    {#if locked}
      <div class="lock">
        <span class="ns-pill live"><span class="dot"></span>locked while a shift runs</span>
      </div>
    {/if}
    <div class="summary-line">
      {#if plan}
        {selectedCount} of {items.length} selected
      {/if}
    </div>
    <div class="scroll">
      <BacklogList
        {items}
        {order}
        {locked}
        onReorder={onReorder}
        selectable={true}
        {selectedIds}
        onToggle={toggle}
      />
      {#each itemList?.errors ?? [] as e (e)}
        <p class="hint err">{e}</p>
      {/each}
    </div>
  </div>
  <Grip width={listWidth} min={300} max={520} edge="right" onchange={(w) => { listWidth = w; setPaneWidth("plan.list", w); }} />

  <aside class="aside">
    {#if !info || !plan}
      <p class="hint">Loading the plan…</p>
    {:else}
      <div>
        <div class="ns-k mb">Shift</div>
        <div class="ns-mono">{plan.shift_id}</div>
      </div>

      <div class="fields">
        <!-- A div, not a label: the preset buttons inside a label would
             inherit the whole label as their accessible name. -->
        <div class="field">
          <span class="ns-k">Until</span>
          <input
            class="ns-fld"
            type="text"
            aria-label="Until"
            placeholder="no time limit — e.g. 7am, 10:30"
            bind:value={untilTime}
            oninput={onUntilChange}
            onchange={onUntilChange}
          />
          <span class="presets">
            {#each UNTIL_PRESETS as pr (pr)}
              <button type="button" class="ns-chip preset" class:on={untilTime.trim().toLowerCase() === pr} onclick={() => pickUntil(pr)}>{pr}</button>
            {/each}
          </span>
          <span class="hint-sm">
            {#if !untilTime.trim()}no time limit{:else if untilParsed && plan.until}stops at {clockLabel(untilParsed)} · {plan.until.slice(0, 10)}{:else}not a time yet{/if}
          </span>
        </div>

        <label class="field">
          <span class="ns-k">Max units</span>
          <input class="ns-fld" type="number" min="1" step="1" placeholder="unbounded" bind:value={maxUnitsText} onchange={onMaxUnitsChange} />
        </label>

        <label class="field">
          <span class="ns-k">Budget (USD)</span>
          <input class="ns-fld" type="number" min="0" step="1" placeholder="unbounded" bind:value={budgetText} onchange={onBudgetChange} />
        </label>
      </div>

      <div class="ns-card summary">
        <div class="ns-k">Plan</div>
        <div class="line">{selectedCount} of {items.length} items selected</div>
        <div class="line">until {plan.until ?? "unbounded"}</div>
        <div class="line">max {plan.max_units ?? "unbounded"} units · budget {plan.budget_usd != null ? `$${plan.budget_usd}` : "unbounded"}</div>
      </div>

      <div class="usage-note">usage: see the Runs page</div>

      <div class="launch-col">
        <button
          class="ns-btn accent launch"
          disabled={locked || app.nightshift.launching || selectedCount === 0}
          onclick={() => void writeAndLaunch()}
        >
          <Icon name="play" />{app.nightshift.launching ? "Launching…" : "Launch tonight"}
        </button>
        <div class="hint-sm center">
          writes <span class="ns-mono">shifts/…/plan.json</span> once, then launches the runner
        </div>
      </div>
    {/if}
  </aside>
</div>

<style>
  .plan {
    flex: 1;
    min-height: 0;
    display: grid;
    overflow: hidden;
  }
  .list-col {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .lock {
    padding: 12px 20px 0;
  }
  .summary-line {
    padding: 12px 20px 4px;
    font-size: 12.5px;
    color: var(--dim);
    min-height: 1.4em;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
  }
  .hint {
    margin: 0;
    padding: 12px 20px;
    font-size: 13px;
    color: var(--dim);
  }
  .hint.err {
    color: var(--failed);
    font-family: var(--mono);
    font-size: 12px;
  }

  .aside {
    border-left: 1px solid var(--line);
    background: var(--sheet);
    padding: 24px 22px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow-y: auto;
    min-height: 0;
    font-size: 13px;
  }
  .mb {
    margin-bottom: 4px;
  }
  .fields {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .hint-sm {
    font-size: 11.5px;
    color: var(--dim);
  }
  .presets {
    display: flex;
    gap: 5px;
    flex-wrap: wrap;
  }
  .preset {
    cursor: pointer;
    padding: 2px 9px;
    font-size: 11.5px;
    font-family: var(--sans);
  }
  .preset:hover {
    border-color: var(--accent);
  }
  .preset.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-ink);
  }
  .hint-sm.center {
    text-align: center;
  }
  .summary {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: var(--paper);
  }
  .line {
    color: var(--ink2);
  }
  .usage-note {
    font-size: 12px;
    color: var(--dim);
  }
  .launch-col {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .launch {
    justify-content: center;
    padding: 10px;
    font-size: 14px;
  }
</style>
