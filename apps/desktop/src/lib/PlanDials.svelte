<script lang="ts">
  /**
   * Item 824, design B "Dials" (blocker 2123, his "Dials lokos good for
   * context"; 2136: the whole popover): the Context and Plan card's body —
   * three rings (context, 5 h, week), the projected percent at the reset
   * as a ghost arc and `→91%`, his stop line as a tick, the spend and
   * Itemise. Numbers and labels only; no sentence (his rule, item 776).
   *
   * One body for every surface: the main chat's card (`TopBar`), Classic's
   * (`TopBarClassic`), an aside's card, and the phone's bottom sheet
   * (`Remote`). The frame (portal, glass, sheet) is each surface's own.
   */
  import { tip } from "./tip";
  import { contextPct, pastStop, ringArcs, RING, tickAt, tokens, type DialFigures, type DialWindow } from "./planDials";

  interface Props {
    figures: DialFigures;
    /** The Itemise button: its words and what it opens; null for none. */
    itemise?: { label: string; key?: string; onclick: () => void } | null;
    /** The spend's two-line hover. */
    spendTip?: string;
    /** `sheet` on the phone: wider rings, the head as the sheet's title. */
    variant?: "card" | "sheet";
  }
  let { figures: f, itemise = null, spendTip = "", variant = "card" }: Props = $props();

  const ctxPct = $derived(f.ctx ? contextPct(f.ctx) : null);
  const ctxArcs = $derived(ringArcs(ctxPct ?? 0, null));
  const fiveHot = $derived(f.five ? pastStop(f.five.pct, f.stop) : false);
  const weekHot = $derived(f.week ? pastStop(f.week.pct, f.stop) : false);
  const tick = $derived(f.stop != null ? tickAt(f.stop) : null);
  const tilde = $derived(f.ctx?.estimated ? "~" : "");
</script>

{#snippet ring(arcs: { now: string | null; ghost: string | null }, color: string, withTick: boolean)}
  <svg viewBox="0 0 {RING.size} {RING.size}" aria-hidden="true">
    <circle class="track" cx={RING.c} cy={RING.c} r={RING.r} />
    {#if arcs.ghost}
      <circle class="ghost" cx={RING.c} cy={RING.c} r={RING.r} style:stroke={color} stroke-dasharray={arcs.ghost} transform="rotate(-90 {RING.c} {RING.c})" />
    {/if}
    {#if arcs.now}
      <circle class="now" cx={RING.c} cy={RING.c} r={RING.r} style:stroke={color} style:--glow={color} stroke-dasharray={arcs.now} transform="rotate(-90 {RING.c} {RING.c})" />
    {/if}
    {#if withTick && tick}
      <line class="tick" x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} />
    {/if}
  </svg>
{/snippet}

{#snippet planDial(name: string, kind: string, w: DialWindow, hot: boolean)}
  {@const color = hot ? "var(--hot)" : "var(--signal)"}
  <div class="dial" class:stale={f.stale != null} data-dial={kind}>
    <div class="ring">
      {@render ring(ringArcs(w.pct, w.proj), color, true)}
      <div class="center">
        <span class="pct" class:hot>{w.pct}%</span>
        {#if w.proj != null}<span class="proj" class:hot={pastStop(w.proj, f.stop)}>→{w.proj}%</span>{/if}
      </div>
    </div>
    <span class="lbl">{name}</span>
    <span class="val">{w.reset}</span>
  </div>
{/snippet}

<div class="pd" class:sheet={variant === "sheet"} data-figures="dials">
  <div class="pd-head">{f.head}{#if f.stale}<span class="tag">{f.stale}</span>{/if}</div>
  <div class="dials">
    <div class="dial" data-dial="context">
      <div class="ring">
        {@render ring(ctxArcs, "var(--accent)", false)}
        <div class="center">
          {#if f.ctx}
            {#if ctxPct != null}
              <span class="pct">{tilde}{ctxPct}%</span>
            {:else}
              <span class="pct small">{tilde}{tokens(f.ctx.used)}</span>
            {/if}
          {:else}
            <span class="pct dim">—</span>
          {/if}
        </div>
      </div>
      <span class="lbl">Context</span>
      {#if f.ctx}
        <span class="val">{tilde}{tokens(f.ctx.used)} / {f.ctx.limit ? tokens(f.ctx.limit) : "?"}</span>
        {#if f.ctx.agents > 0}<span class="val">+{tokens(f.ctx.agents)} agents</span>{/if}
      {:else}
        <span class="val">nothing sent</span>
      {/if}
    </div>
    {#if f.five}{@render planDial("5 h", "five-hour", f.five, fiveHot)}{/if}
    {#if f.week}{@render planDial("Week", "week", f.week, weekHot)}{/if}
  </div>
  {#if f.spend || itemise}
    <div class="foot">
      {#if f.spend}
        <span class="spend" use:tip={spendTip}><span class="lbl">Spent</span><span class="fig" class:partial={!f.spend.complete}>{f.spend.complete ? "" : "≥"}{f.spend.text}</span></span>
      {:else}
        <span></span>
      {/if}
      {#if itemise}
        <button class="ns-btn ghost small itemise" onclick={itemise.onclick}>{itemise.label}{#if itemise.key}<kbd>{itemise.key}</kbd>{/if}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pd {
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: var(--ink2);
    font-size: 12.5px;
  }
  .pd-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
    white-space: nowrap;
  }
  .pd-head::after {
    content: "";
    flex: 1;
    height: 1px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 30%, var(--line2)), transparent);
  }
  .pd-head .tag {
    order: 2;
    color: var(--partial, var(--accent));
    letter-spacing: 0.06em;
  }
  .dials {
    display: flex;
    justify-content: space-around;
    gap: 6px;
  }
  .dial {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    text-align: center;
  }
  .dial.stale {
    opacity: 0.5;
  }
  .ring {
    position: relative;
    width: 74px;
    height: 74px;
  }
  .ring svg {
    position: absolute;
    inset: 0;
    overflow: visible;
  }
  .ring circle {
    fill: none;
    stroke-width: 5;
  }
  .ring .track {
    stroke: var(--well);
  }
  .ring .ghost {
    stroke-opacity: 0.5;
  }
  .ring .now {
    stroke-linecap: round;
    filter: drop-shadow(0 0 4px var(--glow));
  }
  .ring .tick {
    stroke: var(--hot);
    stroke-width: 2;
    stroke-linecap: round;
    filter: drop-shadow(0 0 3px var(--hot));
  }
  .center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .pct {
    font: 500 16px var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--ink);
    line-height: 1;
  }
  .pct.small {
    font-size: 13px;
  }
  .pct.dim {
    color: var(--dim);
  }
  .pct.hot,
  .proj.hot {
    color: var(--hot);
  }
  .proj {
    font: 10.5px var(--mono);
    margin-top: 3px;
    color: var(--signal-ink, var(--signal));
  }
  .lbl {
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--dim);
    white-space: nowrap;
  }
  .dial .lbl {
    margin-top: 2px;
  }
  .val {
    font: 11px var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--dim);
    white-space: nowrap;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding-top: 10px;
    border-top: 1px solid color-mix(in srgb, var(--line2) 60%, transparent);
  }
  .spend {
    display: flex;
    align-items: baseline;
    gap: 8px;
    white-space: nowrap;
  }
  .fig {
    font: 12.5px var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }
  .fig.partial {
    color: var(--ink2);
  }
  .itemise {
    white-space: nowrap;
  }
  .itemise kbd {
    font: 11px var(--mono);
    color: var(--dim);
    margin-left: 6px;
  }
  /* The phone's sheet: the same body, a little more room. */
  .pd.sheet {
    gap: 16px;
    padding: 2px 4px 4px;
  }
  .pd.sheet .ring {
    width: 84px;
    height: 84px;
  }
  .pd.sheet .pct {
    font-size: 18px;
  }
  .pd.sheet .val {
    font-size: 12px;
  }
  .pd.sheet .itemise {
    font-size: 14px;
    padding: 8px 14px;
  }

  /* Classic (1d4ca17's look): flat — no glow, sans labels, the card's own
     plain rule; the same rings, ticks and numbers. */
  :global([data-layout="classic"]) .ring .now,
  :global([data-layout="classic"]) .ring .tick {
    filter: none;
  }
  :global([data-layout="classic"]) .pd-head {
    font: 10.5px var(--sans);
    letter-spacing: 0.08em;
    color: var(--dim);
  }
  :global([data-layout="classic"]) .pd-head::after {
    background: var(--line2);
    opacity: 0.6;
  }
  :global([data-layout="classic"]) .lbl {
    font: 11px var(--sans);
    letter-spacing: 0.02em;
    text-transform: none;
    color: var(--ink);
  }
</style>
