<script lang="ts">
  /**
   * Review → Runs (3.3): the shift list; the selected shift's timeline from
   * `status.json`, its units with commit links, the changes as a side-by-side
   * diff (one unit's commit, or the whole shift), and `run.log` as a terminal
   * drawer at the bottom. Revert opens the confirmed dialog. Every value is
   * one the backend returns; the timeline is drawn from the unit start and
   * end times because `status.json` carries the current phase, not a phase
   * history — the log is that.
   */
  import {
    app,
    paneWidth,
    revertPreview,
    selectShift,
    setPaneWidth,
    showDiff,
  } from "./state.svelte";
  import * as api from "./api";
  import type { RevertPreview, ShiftSummary, UnitStatus } from "./types";
  import {
    duration,
    hhmmss,
    kib,
    pillClass,
    shiftCost,
    shiftMeta,
    shiftWord,
    short,
    usd,
  } from "./nightshift";
  import Grip from "./Grip.svelte";
  import Icon from "./Icon.svelte";
  import DiffView from "./DiffView.svelte";
  import RevertDialog from "./RevertDialog.svelte";

  const shifts = $derived(app.nightshift.shifts);
  const shift = $derived(
    shifts.find((s) => s.id === app.nightshift.selectedShift) ?? null,
  );
  const status = $derived(shift?.status ?? null);
  const plan = $derived(shift?.plan ?? null);
  const word = $derived(shift ? shiftWord(shift) : "");

  let listWidth = $state(paneWidth("runs.list", 290));
  let listOpen = $state(true);
  let drawerOpen = $state(true);
  let revert = $state<{ id: string; preview: RevertPreview } | null>(null);
  let reverting = $state(false);

  /** The whole shift's diff, once a shift with a start commit is selected. */
  $effect(() => {
    if (shift && status?.head_at_start && app.nightshift.diff === null) {
      void showDiff("shift", shift.id);
    }
  });

  interface Seg {
    label: string;
    when: string;
    weight: number;
    kind: "unit" | "runner" | "now";
  }

  /**
   * The timeline. Units are the accent segments; what the runner did
   * between them (preflight and gate before the first, continuation,
   * checkpoint, review and the page after the last) is one dim segment
   * each, labelled by the phase the status names when it is the last one.
   */
  const segments = $derived.by((): Seg[] => {
    if (!status) return [];
    const t = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);
    const start = t(status.started);
    const end = t(status.updated);
    const units = status.units.filter((u) => u.started);
    const out: Seg[] = [];
    let cursor = start;
    const push = (label: string, a: number, b: number, kind: Seg["kind"]) => {
      const w = Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : 0;
      out.push({
        label,
        when: b > a && Number.isFinite(b) ? `${hhmmss(new Date(a).toISOString())} – ${hhmmss(new Date(b).toISOString())}` : hhmmss(Number.isFinite(a) ? new Date(a).toISOString() : null),
        weight: w,
        kind,
      });
    };
    units.forEach((u, i) => {
      const a = t(u.started);
      const b = u.ended ? t(u.ended) : end;
      if (Number.isFinite(cursor) && Number.isFinite(a) && a > cursor) {
        push(i === 0 ? "preflight · gate" : "between units", cursor, a, "runner");
      }
      push(`unit ${u.n} · ${u.item_id ?? "?"} p${u.pass ?? "?"}`, a, b, "unit");
      cursor = b;
    });
    if (Number.isFinite(cursor) && Number.isFinite(end) && end > cursor) {
      push(status.phase, cursor, end, status.exit == null ? "now" : "runner");
    } else if (units.length === 0) {
      push(status.phase, start, end, status.exit == null ? "now" : "runner");
    }
    // Every segment gets a floor so a one-second gate is still visible.
    const total = out.reduce((s, x) => s + x.weight, 0) || 1;
    return out.map((s) => ({ ...s, weight: Math.max(s.weight / total, 0.07) }));
  });

  function outcomeWord(u: UnitStatus): string {
    return u.outcome ?? "running";
  }

  const units = $derived(status?.units ?? []);
  const unitsLine = $derived.by(() => {
    if (!shift || !status) return "";
    const n = units.length;
    const max = plan?.max_units;
    const cost = shiftCost(shift);
    const parts = [max != null ? `${n} of max ${max}` : `${n}`];
    if (cost != null) parts.push(plan?.budget_usd != null ? `${usd(cost)} of ${usd(plan.budget_usd)}` : usd(cost));
    return parts.join(" · ");
  });

  const headMeta = $derived.by(() => {
    if (!shift) return "";
    const parts: string[] = [];
    if (plan) {
      parts.push(plan.source);
      if (plan.kind) parts.push(plan.kind);
      if (plan.max_units != null) parts.push(`max ${plan.max_units} unit${plan.max_units === 1 ? "" : "s"}`);
      if (plan.budget_usd != null) parts.push(usd(plan.budget_usd));
      if (plan.until) parts.push(`until ${plan.until}`);
    } else if (shift.plan_error) {
      parts.push("plan.json did not parse");
    }
    return parts.join(" · ");
  });

  const diff = $derived(app.nightshift.diff);
  const diffUnit = $derived(
    diff?.kind === "unit" ? units.find((u) => u.commit === diff.key || u.continuation_commit === diff.key) ?? null : null,
  );

  async function openRevert() {
    if (!shift) return;
    reverting = true;
    const p = await revertPreview(shift.id);
    reverting = false;
    if (p) revert = { id: shift.id, preview: p };
  }

  function openFolder(s: ShiftSummary) {
    void api.reveal(s.dir).catch(() => {});
  }

  // The log follows: scrolled to its end whenever it changes.
  let logEl = $state<HTMLElement | null>(null);
  $effect(() => {
    void app.nightshift.log;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  const logLines = $derived(app.nightshift.log.split("\n"));
</script>

<div class="runs" style:grid-template-columns={listOpen ? `${listWidth}px 7px minmax(0,1fr)` : "34px minmax(0,1fr)"}>
  {#if listOpen}
    <div class="list-col">
      <div class="ns-side-h row">
        Shifts · <span class="ns-mono dir">shifts/</span>
        <span class="spacer"></span>
        <button class="fold" title="Collapse the shift list" onclick={() => (listOpen = false)}>
          <Icon name="chevl" />
        </button>
      </div>
      {#if shifts.length === 0}
        <p class="hint">No shifts yet — nothing under shifts/.</p>
      {:else}
        <div class="ns-list scroll">
          {#each shifts as s (s.id)}
            {@const word = shiftWord(s)}
            <button class="ns-row shift" class:on={s.id === shift?.id} onclick={() => void selectShift(s.id)}>
              <span class="t idline">
                <span class="ns-mono">{s.id}</span>
                <span class="ns-pill {pillClass(word)}">{word}</span>
              </span>
              <span class="m sans">{shiftMeta(s)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <Grip width={listWidth} min={220} max={480} edge="left" onchange={(w) => { listWidth = w; setPaneWidth("runs.list", w); }} />
  {:else}
    <div class="list-col folded">
      <button class="fold" title="Show the shift list" onclick={() => (listOpen = true)}>
        <Icon name="chevr" />
      </button>
    </div>
  {/if}

  <div class="main">
    {#if !shift}
      <p class="hint pad">Select a shift.</p>
    {:else}
      <div class="head">
        <h1 class="ns-mono">{shift.id}</h1>
        <span class="ns-pill {pillClass(word)}">
          <span class="dot"></span>{word}{#if status?.exit != null}&nbsp;· exit {status.exit}{/if}
        </span>
        <span class="meta">
          {headMeta}{#if status?.head_at_start}{headMeta ? " · " : ""}from <span class="ns-mono">{short(status.head_at_start)}</span>{/if}
        </span>
        <span class="spacer"></span>
        <button class="ns-btn" onclick={() => openFolder(shift)}><Icon name="ext" />Open folder</button>
        <button
          class="ns-btn danger"
          disabled={shift.live || !status?.head_at_start || reverting}
          title={shift.live ? "The shift is running" : !status?.head_at_start ? "No start commit recorded" : "Show what a revert would discard, then confirm"}
          onclick={() => void openRevert()}
        >
          <Icon name="revert" />{reverting ? "Reading…" : "Revert this shift…"}
        </button>
      </div>

      {#if shift.status_error}
        <p class="err">status.json: {shift.status_error}</p>
      {/if}

      <div>
        <div class="ns-sect">
          <span class="ns-k">Timeline</span>
          {#if status?.started}
            <span class="sub">
              {hhmmss(status.started)} → {hhmmss(status.updated)}
              {#if duration(status.started, status.updated)} · {duration(status.started, status.updated)}{/if}
            </span>
          {/if}
        </div>
        <div class="ns-card timeline">
          {#if segments.length === 0}
            <span class="hint">No timing recorded.</span>
          {:else}
            {#each segments as s, i (i)}
              <div class="seg" style:flex={s.weight}>
                <div class="bar {s.kind}"></div>
                <div class="label">{s.label}</div>
                <div class="when ns-mono">{s.when}</div>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <div>
        <div class="ns-sect">
          <span class="ns-k">Units</span>
          <span class="sub">{unitsLine}</span>
        </div>
        <div class="ns-card table">
          {#if units.length === 0}
            <p class="hint pad">No unit has started.</p>
          {:else}
            <table class="ns-grid">
              <thead>
                <tr><th>unit</th><th>item · pass</th><th>outcome</th><th>commit</th><th>cost</th><th>turns</th><th></th></tr>
              </thead>
              <tbody>
                {#each units as u (u.n)}
                  {@const w = outcomeWord(u)}
                  <tr>
                    <td class="ns-mono">{u.n}</td>
                    <td><span class="ns-mono">{u.item_id ?? "—"}</span>{#if u.pass != null} · pass {u.pass}{/if}{#if u.landing} <span class="ns-pill grey">landing</span>{/if}</td>
                    <td><span class="ns-pill {pillClass(w)}">{w}</span></td>
                    <td class="ns-mono">
                      {#if u.commit}
                        <button class="ns-link" onclick={() => void showDiff("unit", u.commit!)}>{short(u.commit)}</button>
                        {#if u.continuation_commit}
                          <span class="dim">+ cont. <button class="ns-link" onclick={() => void showDiff("unit", u.continuation_commit!)}>{short(u.continuation_commit)}</button></span>
                        {/if}
                      {:else}—{/if}
                    </td>
                    <td class="ns-mono">{usd(u.cost_usd) || "—"}</td>
                    <td class="ns-mono">{u.turns ?? "—"}</td>
                    <td class="right">
                      {#if u.commit}
                        <button class="ns-link small" onclick={() => void showDiff("unit", u.commit!)}>show this unit's changes ↓</button>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      </div>

      <div class="changes">
        <div class="ns-sect">
          <span class="ns-k">Changes</span>
          <span class="sub">scrolls; the page does not</span>
        </div>
        <div class="ns-card changes-card">
          <div class="tabs">
            {#if diff?.kind === "unit"}
              <button class="tab on">
                {diffUnit ? `Unit ${diffUnit.n}` : "Commit"} · {short(diff.key)}
              </button>
            {/if}
            {#if status?.head_at_start}
              <button
                class="tab"
                class:on={diff?.kind === "shift"}
                onclick={() => void showDiff("shift", shift.id)}
              >
                Whole shift · {short(status.head_at_start)}..HEAD
              </button>
            {/if}
          </div>
          {#if diff}
            <DiffView
              text={diff.text}
              loading={diff.loading}
              error={diff.error}
              leftLabel={diff.kind === "shift" ? short(status?.head_at_start) : ""}
              rightLabel={diff.kind === "shift" ? "HEAD" : short(diff.key)}
            />
          {:else}
            <p class="hint pad">
              {status?.head_at_start ? "Pick a unit's commit above." : "No start commit recorded, so there is no whole-shift diff; pick a unit's commit."}
            </p>
          {/if}
        </div>
      </div>

      <div class="term" class:closed={!drawerOpen}>
        <div class="term-h">
          <Icon name="term" />
          <span class="dot" class:live={shift.live} class:failed={word === "failed"}></span>
          <span>run.log{shift.live ? " · following" : ""} · {kib(shift.log_bytes)}</span>
          <span class="spacer"></span>
          <button class="fold" title={drawerOpen ? "Collapse the log" : "Show the log"} onclick={() => (drawerOpen = !drawerOpen)}>
            <Icon name={drawerOpen ? "chev" : "chevl"} />
          </button>
        </div>
        {#if drawerOpen}
          <div class="log" bind:this={logEl}>
            {#each logLines as line, i (i)}<div class="line">{line}</div>{/each}
            {#if shift.live}<span class="cur"></span>{/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if revert}
  <RevertDialog shiftId={revert.id} preview={revert.preview} onclose={() => (revert = null)} />
{/if}

<style>
  .runs {
    flex: 1;
    min-height: 0;
    display: grid;
    overflow: hidden;
    position: relative;
  }
  .list-col {
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }
  .list-col.folded {
    align-items: center;
    padding-top: 18px;
  }
  .row {
    display: flex;
    align-items: center;
    padding-top: 18px;
  }
  .dir {
    letter-spacing: 0;
    text-transform: none;
    margin-left: 4px;
  }
  .spacer {
    flex: 1;
  }
  .fold {
    background: transparent;
    border: none;
    color: var(--dim);
    cursor: pointer;
    padding: 2px;
    display: inline-flex;
    border-radius: 4px;
  }
  .fold:hover {
    color: var(--ink);
    background: var(--well);
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
    padding-bottom: 10px;
  }
  .shift {
    padding: 10px 12px;
  }
  .idline {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .m.sans {
    font-family: var(--sans);
    font-size: 12px;
  }
  .hint {
    margin: 0;
    font-size: 13px;
    color: var(--dim);
    padding: 12px 20px;
  }
  .hint.pad {
    padding: 14px;
  }
  .err {
    margin: 0;
    color: var(--failed);
    font-family: var(--mono);
    font-size: 12px;
  }

  .main {
    overflow: hidden;
    min-width: 0;
    display: grid;
    /* One column that can shrink below its content: an implicit `auto`
       track takes the widest child's minimum and overflows the pane. */
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(260px, 1fr) auto;
    gap: 16px;
    min-height: 0;
    padding: 22px 28px 0;
    /* At 900px tall everything fits and only the Changes card scrolls; on
       a shorter window the pane scrolls rather than crushing the diff. */
    overflow-y: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    row-gap: 10px;
    min-width: 0;
    flex-wrap: wrap;
  }
  h1 {
    font-size: 19px;
    font-weight: 500;
    margin: 0;
    white-space: nowrap;
    flex: none;
  }
  .meta {
    color: var(--dim);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .timeline {
    min-width: 0;
    padding: 14px 18px;
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .seg {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .bar {
    height: 8px;
    border-radius: 2px;
    background: var(--line2);
  }
  .bar.unit {
    background: var(--accent);
  }
  .bar.now {
    background: var(--live);
  }
  .label {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .when {
    font-size: 10.5px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .table {
    overflow: auto;
    max-height: 160px;
    min-width: 0;
  }
  .dim {
    color: var(--dim);
  }
  .right {
    text-align: right;
  }
  .ns-link.small {
    font-size: 12px;
  }

  .changes {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .changes-card {
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 8px 12px 0;
  }
  .tab {
    padding: 6px 12px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--ink2);
    font-size: 13px;
    font-family: var(--sans);
    cursor: pointer;
  }
  .tab:hover {
    background: var(--well);
  }
  .tab.on {
    background: var(--well);
    color: var(--ink);
    box-shadow: 0 0 0 1px var(--line2);
  }

  .term {
    margin: 0 -28px;
    background: var(--term);
    border-top: 1px solid var(--line2);
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 160px;
  }
  .term.closed {
    height: auto;
  }
  .term-h {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    font-size: 11.5px;
    color: var(--dim);
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .term-h .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--done);
  }
  .term-h .dot.live {
    background: var(--live);
    box-shadow: 0 0 0 3px var(--live-soft);
  }
  .term-h .dot.failed {
    background: var(--failed);
  }
  .log {
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--ink2);
    overflow: auto;
    padding: 8px 14px;
    min-height: 0;
    flex: 1;
  }
  .line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .cur {
    display: inline-block;
    width: 7px;
    height: 13px;
    background: var(--done);
    vertical-align: -2px;
  }
</style>
