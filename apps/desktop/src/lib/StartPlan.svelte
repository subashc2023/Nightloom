<script lang="ts">
  import { tip } from "./tip";
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
  import {
    app,
    cancelLaunch,
    clockOf,
    loadPendingLaunch,
    loadUsage,
    paneWidth,
    scheduleLaunch,
    setPaneWidth,
    synthPlan,
    writeAndLaunch,
  } from "./state.svelte";
  import { untrack } from "svelte";
  import { clockLabel, parseClockTime, untilFromTime } from "./nightshift";
  import BacklogList from "./BacklogList.svelte";
  import Grip from "./Grip.svelte";
  import Icon from "./Icon.svelte";
  import ContextDial from "./ContextDial.svelte";
  import { classic } from "./layout.svelte";
  import { clock12, passTrace, planRun } from "./nightshiftFace";

  let listWidth = $state(paneWidth("plan.list", 420));

  const itemList = $derived(app.nightshift.items);
  const items = $derived(itemList?.items ?? []);
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
    untrack(() => {
      void synthPlan();
      void loadPendingLaunch();
      void loadUsage();
    });
  });

  const selectedIds = $derived(new Set((plan?.items ?? []).filter((i) => i.selected).map((i) => i.id)));
  const selectedCount = $derived(selectedIds.size);

  // The plan's own order — what the runner walks. The list shows the
  // selected items first in this order (its grouped mode); ticking an item
  // sends it to the end of that section, so "what runs, in what order" is
  // always the top of the list.
  const planOrder = $derived((plan?.items ?? []).map((i) => i.id));
  function toggle(id: string): void {
    const p = app.nightshift.planDraft;
    if (!p) return;
    const at = p.items.findIndex((i) => i.id === id);
    if (at < 0) {
      p.items.push({ id, selected: true });
      return;
    }
    const entry = p.items[at];
    if (entry.selected) {
      entry.selected = false;
      return;
    }
    // Selecting: move it after the last selected item.
    p.items.splice(at, 1);
    let last = -1;
    p.items.forEach((i, idx) => { if (i.selected) last = idx; });
    p.items.splice(last + 1, 0, { ...entry, selected: true });
  }
  function selectAll(on: boolean): void {
    const p = app.nightshift.planDraft;
    if (!p) return;
    for (const entry of p.items) entry.selected = on;
  }

  // Reordering on this screen changes the PLAN's order only (2026-09-13,
  // Swaraag's ask for a selected-first list). The global backlog order is
  // the Backlog screen's, and `reorderItems` is no longer called from here.
  function onReorder(newOrder: string[]): void {
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
    // `untrack`: the reads of max_units / budget_usd below must not become
    // dependencies, or every Max-units edit re-runs this and blanks the Until
    // box while the draft keeps its `until` (review F1, 2026-09-12).
    untrack(() => {
      const p = app.nightshift.planDraft;
      untilTime = "";
      maxUnitsText = p?.max_units != null ? String(p.max_units) : "";
      budgetText = p?.budget_usd != null ? String(p.budget_usd) : "";
    });
  });

  // Until is typed (`7am`, `10:30`, `noon`) or picked from the presets; the
  // draft takes the next occurrence of that time. A typed value that is not
  // a time leaves the draft unbounded and the hint says so.
  const UNTIL_PRESETS = ["6am", "7am", "9am", "noon"];
  const untilParsed = $derived(untilTime.trim() ? parseClockTime(untilTime) : null);
  function onUntilChange(): void {
    const p = app.nightshift.planDraft;
    if (!p) return;
    const from = startAtMs != null ? new Date(startAtMs) : new Date();
    p.until = untilTime.trim() ? untilFromTime(untilTime, from) : null;
  }
  function pickUntil(preset: string): void {
    untilTime = untilTime.trim().toLowerCase() === preset ? "" : preset;
    onUntilChange();
  }

  // `bind:value` on a number input hands back a number (or null when the
  // field is emptied), not the string the mirror was seeded with — so this
  // takes either. Calling `.trim()` on the number is what kept the draft's
  // bounds at "unbounded" whatever was typed (found 2026-09-12 driving the
  // first launch from the app).
  // Start: now, when the 5h usage window resets (the runner's own probe
  // says when; two minutes after, so the gate reads the new window), or at
  // a typed time — the same lenient parsing as Until, next occurrence. The
  // app holds the timer (SHIFT-CONTRACT §7's v1 rule); a held launch shows
  // in the state chip and here, with Cancel. Swaraag's round-2 point 10.
  type StartMode = "now" | "reset" | "at";
  let startMode = $state<StartMode>("now");
  let startTime = $state("");
  const RESET_MARGIN_MS = 2 * 60 * 1000;
  const resetAtMs = $derived.by(() => {
    const iso = app.nightshift.usage?.five_hour_resets_at;
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t + RESET_MARGIN_MS : null;
  });
  // `Date.now()` is not reactive; a 30 s tick keeps "already past" honest
  // while the screen sits open across the moment (review F12).
  let nowMs = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (nowMs = Date.now()), 30_000);
    return () => clearInterval(t);
  });
  const resetIsPast = $derived(resetAtMs != null && resetAtMs <= nowMs);
  const usageStale = $derived(app.nightshift.usage?.stale === true);
  const startAtMs = $derived.by(() => {
    if (startMode === "reset") return resetIsPast ? null : resetAtMs;
    if (startMode === "at") {
      const iso = startTime.trim() ? untilFromTime(startTime, new Date(nowMs)) : null;
      return iso ? Date.parse(iso) : null;
    }
    return null;
  });
  // Until is the next occurrence AFTER the start, not after now: a held
  // launch for 11pm with "until 7am" typed at 6am meant tomorrow's 7am, not
  // today's, sixteen hours before the launch (review F7). Re-derived from
  // the typed text whenever the start moves.
  $effect(() => {
    void startAtMs;
    untrack(() => onUntilChange());
  });
  const untilBeforeStart = $derived(
    plan?.until != null && startAtMs != null && Date.parse(plan.until) <= startAtMs,
  );
  const startLabel = $derived.by(() => {
    if (startMode === "now") return "Launch tonight";
    return startAtMs != null ? `Launch ${clockOf(startAtMs)}` : "Launch at…";
  });
  const canLaunch = $derived(
    !locked &&
      !app.nightshift.launching &&
      selectedCount > 0 &&
      (startMode === "now" || startAtMs != null) &&
      !untilBeforeStart,
  );
  function launch(): void {
    if (startMode === "now") void writeAndLaunch();
    else if (startAtMs != null) void scheduleLaunch(startAtMs);
  }
  function pickStart(mode: StartMode): void {
    startMode = mode;
    if (mode === "reset") void loadUsage();
  }

  // Filament IV (item 566): the plan as a strip, the last shift as a trace,
  // the plan's usage as two dials. Read-only views of data already here.
  const run = $derived(planRun(plan?.items ?? [], items));
  const passCap = $derived.by(() => {
    const sum = run.reduce((n, r) => n + (r.passes || 0), 0);
    return plan?.max_units != null ? Math.min(sum, plan.max_units) : sum;
  });
  const stops = $derived.by(() => {
    const out: string[] = [];
    if (plan?.budget_usd != null) out.push(`$${plan.budget_usd}`);
    if (plan?.until) out.push(clock12(Date.parse(plan.until), new Date(nowMs)));
    return out.length ? `stops at ${out.join(" or ")}` : "no stop but the backlog";
  });
  const lastShift = $derived(app.nightshift.shifts.find((x) => !x.live) ?? null);
  const trace = $derived(passTrace(lastShift?.status?.units ?? [], nowMs));
  const usage = $derived(app.nightshift.usage);

  function numOrNull(v: string | number | null | undefined): number | null {
    if (v == null || String(v).trim() === "") return null;
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
  {#if !classic() && plan}
    <section class="strip" aria-label="Tonight's plan">
      <div class="strip-head">
        <b>{startMode === "now" ? "Tonight's plan" : "The plan"}</b>
        <span>· {run.length} item{run.length === 1 ? "" : "s"} · up to {passCap} pass{passCap === 1 ? "" : "es"} · {stops}</span>
      </div>
      {#if run.length > 0}
        <ol class="runrow">
          {#each run as r (r.id)}
            <li class="runitem" style:flex-grow={Math.max(1, r.passes)} use:tip={r.title}><span class="ns-mono">{r.id}</span> · {r.kind} · {r.passes} pass{r.passes === 1 ? "" : "es"}</li>
          {/each}
        </ol>
      {:else}
        <div class="hint-sm">Tick items in the backlog to plan a shift.</div>
      {/if}
    </section>
  {/if}
  <div class="list-col">
    {#if locked}
      <div class="lock">
        <span class="ns-pill live"><span class="dot"></span>locked while a shift runs</span>
      </div>
    {/if}
    <div class="summary-line">
      {#if plan}
        <span>{selectedCount} of {items.length} selected</span>
        <span class="spacer"></span>
        <button class="ns-btn small" disabled={locked || selectedCount === items.length} use:tip={"Select every item"} onclick={() => selectAll(true)}>All</button>
        <button class="ns-btn small" disabled={locked || selectedCount === 0} use:tip={"Deselect every item"} onclick={() => selectAll(false)}>None</button>
      {/if}
    </div>
    <div class="scroll">
      <BacklogList
        {items}
        order={planOrder}
        {locked}
        onReorder={onReorder}
        selectable={true}
        grouped={true}
        {selectedIds}
        onToggle={toggle}
      />
      {#each itemList?.errors ?? [] as e (e)}
        <p class="hint err">{e}</p>
      {/each}
    </div>
    {#if !classic() && lastShift && trace.rows.length > 0}
      <section class="trace" aria-label="The last shift, pass by pass">
        <div class="ns-cap trace-cap">
          <span>Last shift, pass by pass</span>
          {#if trace.start != null && trace.end != null}<span class="span-when">{clock12(trace.start, new Date(nowMs))} → {clock12(trace.end, new Date(nowMs))}</span>{/if}
        </div>
        <div class="trace-rows">
          {#each trace.rows as r (r.n)}
            <div class="trow {r.outcome}">
              <span class="tn">{r.n}</span>
              <span class="tmark" aria-hidden="true">{r.outcome === "done" ? "✓" : r.outcome === "partial" ? "◐" : r.outcome === "failed" ? "✕" : "•"}</span>
              <span class="tid">{r.item}</span>
              <span class="twhat">pass {r.pass ?? "?"} · {r.outcome}</span>
              <span class="tbar"><i style:left="{r.left}%" style:width="{r.width}%"></i></span>
              <span class="tlen">{r.length}</span>
            </div>
          {/each}
        </div>
      </section>
    {/if}
  </div>
  <Grip width={listWidth} min={300} max={520} edge="right" onchange={(w) => { listWidth = w; setPaneWidth("plan.list", w); }} />

  <aside class="aside">
    {#if !info || !plan}
      <p class="hint">Loading the plan…</p>
    {:else}
      {#if !classic()}<div class="ns-cap plan-cap">Plan <span class="ns-mono sid">{plan.shift_id}</span></div>{/if}
      <div class="shift-block">
        <div class="ns-k mb">Shift</div>
        <div class="ns-mono">{plan.shift_id}</div>
      </div>

      <div class="fields">
        <div class="field" role="radiogroup" aria-label="Start">
          <span class="ns-k">Start</span>
          <span class="presets">
            <button type="button" role="radio" aria-checked={startMode === "now"} class="ns-chip preset" class:on={startMode === "now"} onclick={() => pickStart("now")}>now</button>
            <button
              type="button"
              role="radio"
              aria-checked={startMode === "reset"}
              class="ns-chip preset"
              class:on={startMode === "reset"}
              disabled={resetAtMs == null || resetIsPast}
              use:tip={resetAtMs == null ? "the usage probe has no reset time" : resetIsPast ? "the window has already reset" : `usage resets ${clockOf(resetAtMs - RESET_MARGIN_MS)}; launches two minutes after`}
              onclick={() => pickStart("reset")}
            >when usage resets{#if resetAtMs != null && !resetIsPast}{" · "}{clockOf(resetAtMs - RESET_MARGIN_MS).replace(/^at /, "")}{/if}</button>
            <button type="button" role="radio" aria-checked={startMode === "at"} class="ns-chip preset" class:on={startMode === "at"} onclick={() => pickStart("at")}>at a time</button>
          </span>
          {#if startMode === "at"}
            <input autocorrect="off" autocapitalize="off" spellcheck="false"
              class="ns-fld"
              type="text"
              aria-label="Start time"
              placeholder="e.g. 5:10am, 23:30"
              bind:value={startTime}
            />
          {/if}
          <span class="hint-sm">
            {#if startMode === "now"}launches when you press the button{:else if startMode === "reset"}{#if resetAtMs != null && !resetIsPast}5h usage {app.nightshift.usage?.five_hour ?? "?"}% · launches {clockOf(resetAtMs)}{#if usageStale}{" · "}from a stale usage sample{/if}{:else if resetIsPast}the window has already reset{#if usageStale} (stale sample){/if} — pick a time, or launch now{:else}the usage probe has no reset time{/if}{:else if startAtMs != null}launches {clockOf(startAtMs)}{:else}not a time yet{/if}
          </span>
        </div>

        <!-- A div, not a label: the preset buttons inside a label would
             inherit the whole label as their accessible name. -->
        <div class="field">
          <span class="ns-k">Until</span>
          <input autocorrect="off" autocapitalize="off" spellcheck="false"
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
            {#if !untilTime.trim()}no time limit{:else if untilBeforeStart && plan.until}until {plan.until.slice(0, 16).replace("T", " ")} is before the start — pick a later time{:else if untilParsed && plan.until}stops at {clockLabel(untilParsed)} · {plan.until.slice(0, 10)}{:else}not a time yet{/if}
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
        {#if info?.dirty}
          <div class="line dirty" use:tip={"The runner's preflight commits a dirty contract root as WIP before the first unit, and each unit's commit stages everything — a session editing the same tree during the shift has its half-work committed under the runner's name."}>
            {info.dirty} uncommitted file{info.dirty === 1 ? "" : "s"} in the contract root will be committed as WIP when the shift starts
          </div>
        {/if}
      </div>

      {#if classic()}
        <div class="usage-note">usage: see the Runs page</div>
      {:else if usage && (usage.five_hour != null || usage.seven_day != null)}
        <div class="dials" use:tip={`plan use as the runner's usage probe last read it${usage.age_seconds != null ? `, ${Math.round(usage.age_seconds / 60)} min ago` : ""}${usage.stale ? " (stale)" : ""}`}>
          {#if usage.five_hour != null}
            <ContextDial size={96} share={usage.five_hour / 100} value="{Math.round(usage.five_hour)}%" unit="5 h" label="5-hour window {Math.round(usage.five_hour)}% used" />
          {/if}
          {#if usage.seven_day != null}
            <ContextDial size={96} share={usage.seven_day / 100} value="{Math.round(usage.seven_day)}%" unit="week" label="Week {Math.round(usage.seven_day)}% used" />
          {/if}
        </div>
        {#if usage.stale}<div class="hint-sm center">from a stale usage sample</div>{/if}
      {:else}
        <div class="usage-note">plan use not read yet</div>
      {/if}

      <div class="launch-col">
        {#if app.nightshift.pending}
          <div class="ns-card held">
            <span class="ns-pill open"><span class="dot"></span>held</span>
            <span class="held-text">launches {classic() ? clockOf(app.nightshift.pending.fire_at_ms) : clock12(app.nightshift.pending.fire_at_ms, new Date(nowMs))} · {app.nightshift.pending.items} item{app.nightshift.pending.items === 1 ? "" : "s"}</span>
            <button type="button" class="ns-btn small ghost" onclick={() => void cancelLaunch()}>Cancel</button>
          </div>
        {/if}
        {#if !classic()}<span class="count">{selectedCount} item{selectedCount === 1 ? "" : "s"} selected</span>{/if}
        <button class="ns-btn accent launch" disabled={!canLaunch} onclick={launch}>
          <Icon name="play" />{app.nightshift.launching ? "Launching…" : startLabel}
        </button>
        <div class="hint-sm center">
          {#if startMode === "now"}
            writes <span class="ns-mono">shifts/…/plan.json</span> once, then launches the runner
          {:else}
            the app holds the plan and writes it when the time comes — keep Nightloom open{#if app.nightshift.pending}; a new launch replaces the held one{/if}
          {/if}
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
    padding: 8px 14px 4px 20px;
    font-size: 12.5px;
    color: var(--dim);
    min-height: 1.4em;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .summary-line .spacer {
    flex: 1;
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
  .line.dirty {
    color: var(--partial);
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
  .held {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    font-size: 12.5px;
  }
  .held-text {
    flex: 1;
    min-width: 0;
    color: var(--ink2);
  }
  .preset:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* Filament IV (item 566; f4-night.png): a page with margins — the plan
     strip across the top, the backlog and the last shift's trace on the
     left, the plan's fields, dials and Launch in a card on the right.
     Gated: Classic draws fe79d50's rules above, untouched. */
  :global(:where(:root:not([data-layout="classic"]))) .plan {
    grid-template-rows: auto minmax(0, 1fr);
    padding: 16px 48px 24px;
    row-gap: 16px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .strip {
    grid-column: 1 / -1;
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    background: var(--sheet);
    padding: 14px 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  .strip-head {
    font-size: 14px;
    color: var(--ink2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .strip-head b {
    color: var(--ink);
    font-weight: 600;
  }
  .runrow {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    gap: 8px;
    min-width: 0;
  }
  .runitem {
    flex-basis: 0;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line2);
    border-left: 3px solid var(--accent);
    border-radius: var(--r1);
    padding: 3px 10px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .list-col {
    gap: 10px;
    overflow: hidden;
  }
  :global(:where(:root:not([data-layout="classic"]))) .lock {
    padding: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .summary-line {
    padding: 0 2px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .scroll {
    flex: 1 1 auto;
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    background: var(--sheet);
  }
  .trace {
    flex: none;
    max-height: 42%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .trace-cap .span-when {
    order: 2;
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--ink2);
    font-variant-numeric: tabular-nums;
  }
  .trace-rows {
    overflow-y: auto;
    min-height: 0;
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    background: var(--sheet);
  }
  .trow {
    display: grid;
    grid-template-columns: 28px 20px 48px minmax(0, 1fr) minmax(80px, 30%) 56px;
    align-items: center;
    gap: 10px;
    padding: 7px 16px;
    font: 13px var(--mono);
    color: var(--ink2);
    font-variant-numeric: tabular-nums;
  }
  .trow + .trow {
    border-top: 1px solid var(--line);
  }
  .tn {
    color: var(--dim);
  }
  .tid {
    color: var(--ink);
  }
  .twhat {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tmark {
    color: var(--done);
    text-align: center;
  }
  .trow.partial .tmark {
    color: var(--partial);
  }
  .trow.failed .tmark {
    color: var(--failed);
  }
  .trow.running .tmark,
  .trow.wip .tmark {
    color: var(--signal);
  }
  .tbar {
    position: relative;
    height: 3px;
    border-radius: 2px;
    background: var(--well);
  }
  .tbar i {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 2px;
    background: var(--done);
  }
  .trow.partial .tbar i {
    background: var(--partial);
  }
  .trow.failed .tbar i {
    background: var(--failed);
  }
  .trow.running .tbar i,
  .trow.wip .tbar i {
    background: var(--signal);
  }
  .tlen {
    text-align: right;
  }
  :global(:where(:root:not([data-layout="classic"]))) .aside {
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    background: var(--sheet);
    padding: 18px 22px;
    gap: 16px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .fields {
    gap: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .field {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    column-gap: 12px;
    row-gap: 6px;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  :global(:where(:root:not([data-layout="classic"]))) .field > :not(.ns-k) {
    grid-column: 2;
  }
  :global(:where(:root:not([data-layout="classic"]))) .field > .ns-k {
    grid-row: 1;
    font-size: 13.5px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink2);
    font-family: var(--sans);
  }
  :global(:where(:root:not([data-layout="classic"]))) .summary {
    background: var(--raised);
  }
  .dials {
    display: flex;
    justify-content: space-around;
    gap: 12px;
    padding: 4px 0;
  }
  .count {
    font-size: 14px;
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .launch-col {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
  }
  :global(:where(:root:not([data-layout="classic"]))) .launch-col > .held,
  :global(:where(:root:not([data-layout="classic"]))) .launch-col > .hint-sm {
    flex-basis: 100%;
  }
  :global(:where(:root:not([data-layout="classic"]))) .launch-col > .held {
    order: -1;
  }
  :global(:where(:root:not([data-layout="classic"]))) .launch {
    padding: 8px 18px;
    font-size: 14px;
    font-weight: 600;
  }
  /* The shift id rides in the Plan heading; the summary card shows only
     when it carries the dirty-tree warning (the strip says the rest); the
     Launch row stays in view at the card's foot while the fields scroll. */
  :global(:where(:root:not([data-layout="classic"]))) .shift-block {
    display: none;
  }
  .plan-cap .sid {
    order: 2;
    font-size: 10.5px;
    letter-spacing: 0.02em;
    text-transform: none;
    color: var(--dim);
  }
  :global(:where(:root:not([data-layout="classic"]))) .summary:not(:has(.dirty)) {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .summary > .ns-k,
  :global(:where(:root:not([data-layout="classic"]))) .summary > .line:not(.dirty) {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .field {
    padding: 8px 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .launch-col {
    position: sticky;
    bottom: -18px;
    margin-bottom: -18px;
    padding: 12px 0 18px;
    background: var(--sheet);
    border-top: 1px solid var(--line);
    z-index: 1;
  }
</style>
