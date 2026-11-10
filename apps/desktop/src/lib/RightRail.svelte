<script lang="ts">
  import ProviderRail from "./ProviderRail.svelte";
  import TaskPanel from "./TaskPanel.svelte";
  import ContextDial from "./ContextDial.svelte";
  import { app, contextUsed, currentTodos } from "./state.svelte";
  import { mark as handoffMark } from "./handoff.svelte";
  import { cacheState, nextTickMs, remainingText } from "./cache";
  import {
    clockText,
    freshIn,
    handoffText,
    lastLoggedTurn,
    modelShort,
    niceCeil,
    shortTokens,
    tickCounts,
    toolMarks,
    toolsText,
    WEEK_HOT,
  } from "./contextDial";
  import { tip } from "./tip";

  interface Props {
    /**
     * Item 533 (Filament IV stage 2): the right column beside the chat —
     * Context (the dial and its three legend lines), Plan use, This turn,
     * Tasks. Without it, the model chip's popover as before (Model · Tasks).
     */
    column?: boolean;
  }
  let { column = false }: Props = $props();

  type Tab = "connection" | "tasks";

  let tab = $state<Tab>("connection");

  const open = $derived(
    currentTodos().filter((t) => t.status !== "completed").length,
  );

  /**
   * Model and Tasks only (review round 1, 2026-09-13). The Context tab
   * left for its own popover under the top bar's gauge — which also ended
   * the engine special-case here: the tab used to be dropped on Claude
   * Code, and the popover explains that instead of hiding it.
   */
  const TABS: { id: Tab; label: string }[] = [
    { id: "connection", label: "Model" },
    { id: "tasks", label: "Tasks" },
  ];

  // ---- the column's readings (item 533). Each comes from what the app
  // already holds; a reading it does not hold is left out, never drawn
  // from a guess.

  /** Context: the next request's prefix over the window (the top bar's gauge's figures). */
  const used = $derived(column ? contextUsed() : null);
  const limit = $derived(app.connection?.contextLimit ?? null);
  const share = $derived(used != null && limit ? Math.min(used / limit, 1) : 0);
  /** The hand-off line: the chat's own mark, else the Settings percent or token cap (backlog 436). */
  const markShare = $derived(limit ? handoffMark(app.activeSessionId, limit) : null);
  const markTokens = $derived(limit && markShare != null ? Math.round(markShare * limit) : null);
  const ticks = $derived(tickCounts(limit));
  const handoffLine = $derived(handoffText(used, markTokens));

  /**
   * The prompt cache (backlog 063): the newest live reply's entry. The
   * clock wakes when the text would change — once a minute, then once a
   * second under two minutes — and not at all once cold, so an idle
   * column with a cold cache has no timer.
   */
  let now = $state(Date.now());
  const cache = $derived(column ? cacheState(app.events, now) : null);
  $effect(() => {
    if (!cache || !cache.warm) return;
    const wait = nextTickMs(cache.remainingMs);
    if (wait == null) return;
    const id = setTimeout(() => (now = Date.now()), wait);
    return () => clearTimeout(id);
  });
  const TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;
  const cacheShare = $derived(cache ? Math.max(0, cache.remainingMs) / TTL_MS[cache.ttl] : null);
  const cacheLeft = $derived(cache ? remainingText(cache.remainingMs) : null);

  /** Plan use (backlog 073): the Claude Code engine's five-hour and week, account-wide. */
  const plan = $derived.by(() => {
    if (!column || app.connection?.engine !== "claude-code") return null;
    const u = app.planUsage;
    if (!u || u.source === "none" || u.five_hour == null) return null;
    return u;
  });

  /**
   * This turn: while one runs, the live reply's calls and the newest
   * request's usage, the clock from his message; idle, the last turn as
   * the log has it, its clock stopped.
   */
  const logged = $derived(column ? lastLoggedTurn(app.events) : null);
  const live = $derived(column && app.busy && app.live != null);
  $effect(() => {
    if (!live) return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const turnClock = $derived.by(() => {
    if (!logged?.startedAt) return null;
    if (live) return clockText(now - logged.startedAt);
    return logged.endedAt != null && logged.endedAt >= logged.startedAt ? clockText(logged.endedAt - logged.startedAt) : null;
  });
  const marks = $derived(live ? toolMarks(app.live?.segments ?? []) : (logged?.tools ?? []));
  const turnUsage = $derived(live ? app.liveUsage : (logged?.usage ?? null));
  const inTokens = $derived(freshIn(turnUsage));
  const outTokens = $derived(turnUsage ? turnUsage.output_tokens : null);
  const ioScale = $derived(niceCeil(Math.max(inTokens ?? 0, outTokens ?? 0)));
  const toolsLine = $derived(toolsText(marks));
  const hasTurn = $derived(turnClock != null || inTokens != null || outTokens != null || toolsLine != null);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
</script>

{#if column}
  <aside class="col" aria-label="Context, plan use, this turn and tasks">
    <section>
      <h4>Context <span>{modelShort(app.connection?.model)}</span></h4>
      <div class="dial-at">
        <ContextDial
          size={104}
          {share}
          mark={markShare}
          inner={cache ? cacheShare : null}
          minor={ticks.minor}
          major={ticks.major}
          value={used != null ? shortTokens(used) : "—"}
          unit={limit ? `of ${shortTokens(limit)}` : used != null ? "window unknown" : ""}
          label={used != null
            ? `Context ${used.toLocaleString()} tokens${limit ? ` of ${limit.toLocaleString()}` : ""}`
            : "Context: no reading yet"}
        />
      </div>
      <div class="legend">
        {#if limit && used != null}
          <div class="dk" use:tip={"What the next request carries, over the model's window"}>
            <i class="u"></i><span>Used</span><b>{pct(share)}</b>
          </div>
        {/if}
        {#if handoffLine}
          <div
            class="dk"
            class:past={handoffLine === "past hand-off"}
            use:tip={`The hand-off line: ${markTokens?.toLocaleString()} tokens (${pct(markShare ?? 0)} of the window). Set in Settings → Subscription, or for this chat in its hand-off card.`}
          >
            <i class="n"></i><span>Hand-off line</span><b>{handoffLine}</b>
          </div>
        {/if}
        {#if cache}
          <div
            class="dk"
            use:tip={cacheLeft
              ? `The prompt cache from the newest reply: ${cache.ttl === "1h" ? "an hour" : "five minutes"} from when its request was sent`
              : "The prompt cache has expired: the next request writes it again"}
          >
            <i class="s"></i><span>Cache {cacheLeft ? "warm" : "cold"}</span><b class:sig={!!cacheLeft}>{cacheLeft ? `${cacheLeft} left` : "—"}</b>
          </div>
        {/if}
      </div>
    </section>

    {#if plan}
      <section>
        <h4>
          Plan use
          {#if plan.stale}<span use:tip={"The newest reading is past twenty minutes old and may be behind"}>stale</span>{/if}
        </h4>
        <div class="kv" use:tip={"Account-wide: every surface, not just this chat"}><span>5 hours</span><b>{plan.five_hour}%</b></div>
        <div class="bar am"><i style:width="{Math.min(100, plan.five_hour ?? 0)}%"></i></div>
        <div class="scale"></div>
        {#if plan.seven_day != null}
          <div class="kv wk"><span>This week</span><b>{plan.seven_day}%</b></div>
          <div class="bar" class:ok={plan.seven_day / 100 <= WEEK_HOT} class:ht={plan.seven_day / 100 > WEEK_HOT}>
            <i style:width="{Math.min(100, plan.seven_day)}%"></i>
          </div>
          <div class="scale"></div>
        {/if}
      </section>
    {/if}

    {#if hasTurn}
      <section>
        <h4>This turn {#if turnClock}<span class:sig={live}>{turnClock}</span>{/if}</h4>
        {#if inTokens != null}
          <div class="io" use:tip={"The newest request's input not read back from the cache: new to the prompt this round"}>
            <span>In</span>
            <div class="bar am"><i style:width="{(inTokens / ioScale) * 100}%"></i></div>
            <b>{shortTokens(inTokens)}</b>
          </div>
        {/if}
        {#if outTokens != null}
          <div class="io" use:tip={"The newest request's output"}>
            <span>Out</span>
            <div class="bar sg"><i style:width="{(outTokens / ioScale) * 100}%"></i></div>
            <b>{shortTokens(outTokens)}</b>
          </div>
        {/if}
        {#if toolsLine}
          <div class="kv tools"><span>Tools</span><b>{toolsLine}</b></div>
          <div class="tks" aria-hidden="true">
            {#each marks as m, i (i)}<i class:r={!m.done} class:e={m.error}></i>{/each}
          </div>
        {/if}
      </section>
    {/if}

    <section class="tasks">
      <TaskPanel column />
    </section>
  </aside>
{:else}
  <aside class="rail">
    <div class="tabs" role="tablist">
      {#each TABS as t (t.id)}
        <button
          role="tab"
          aria-selected={tab === t.id}
          class:active={tab === t.id}
          onclick={() => (tab = t.id)}
        >
          {t.label}
          {#if t.id === "tasks" && open > 0}<span class="badge">{open}</span>{/if}
        </button>
      {/each}
    </div>

    {#if tab === "connection"}
      <ProviderRail />
    {:else}
      <TaskPanel />
    {/if}
  </aside>
{/if}

<style>
  .rail {
    background: var(--panel);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  /* A segmented control rather than underlined tabs: three short words in a
     240px column read better as one pill than as three headings. */
  .tabs {
    display: flex;
    flex-shrink: 0;
    gap: 2px;
    margin: 0.6rem 0.7rem 0;
    padding: 2px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .tabs button {
    flex: 1;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 0.28rem 0.3rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.28rem;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.active {
    color: var(--text);
    background: var(--panel);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .badge {
    background: var(--accent);
    color: var(--bg);
    border-radius: 999px;
    font-size: 0.6rem;
    line-height: 1;
    padding: 0.13rem 0.28rem;
    font-variant-numeric: tabular-nums;
  }

  /* ---- the right column (item 533; 521 mockup `tele`, f4x-chat.png) */
  .col {
    background: var(--sheet);
    border-left: 1px solid var(--line);
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .col section {
    padding: 0 0 14px;
    margin-bottom: 14px;
    border-bottom: 1px solid var(--line);
  }
  .col section:last-child {
    border: 0;
    margin-bottom: 0;
    padding-bottom: 0;
  }
  /* Tasks sit at the foot of the column, as drawn. */
  .col section.tasks {
    margin-top: auto;
  }
  /* Titles: mono capitals in the lit level (IV+), the sans in calm. */
  .col h4 {
    margin: 0 0 8px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  :global([data-light="calm"]) .col h4 {
    font: 600 12px var(--sans);
    letter-spacing: 0;
    text-transform: none;
  }
  .col h4 span {
    font: 11px var(--mono);
    letter-spacing: 0;
    text-transform: none;
    color: var(--dim);
  }
  .col h4 span.sig {
    color: var(--signal);
  }
  .dial-at {
    display: flex;
    justify-content: center;
  }
  .legend {
    margin-top: 8px;
  }
  .dk {
    font-size: 11.5px;
    color: var(--dim);
    display: grid;
    grid-template-columns: 8px 1fr auto;
    gap: 6px;
    align-items: center;
    padding: 2px 0;
  }
  .dk b {
    font: 11px var(--mono);
    font-weight: 400;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .dk b.sig {
    color: var(--signal);
  }
  .dk.past b {
    color: var(--hot);
  }
  .dk i {
    width: 8px;
    height: 2px;
    background: var(--accent);
  }
  .dk i.s {
    background: var(--signal);
  }
  .dk i.n {
    background: var(--ink);
    width: 2px;
    height: 8px;
    justify-self: center;
  }
  .kv {
    display: flex;
    justify-content: space-between;
    font-size: 12.5px;
    color: var(--ink);
    padding: 3px 0;
  }
  .kv span {
    color: var(--dim);
  }
  .kv b {
    font: 11.5px var(--mono);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .kv.wk {
    margin-top: 8px;
  }
  .kv.tools {
    margin-top: 3px;
  }
  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--well);
    position: relative;
    margin: 2px 0 0;
    overflow: hidden;
  }
  .bar i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    max-width: 100%;
    border-radius: 2px;
    background: var(--accent);
  }
  .bar.sg i {
    background: var(--signal);
  }
  .bar.ok i {
    background: var(--done);
  }
  .bar.ht i {
    background: var(--hot);
  }
  /* A bar's scale: a tick at each quarter and one at the end. */
  .scale {
    height: 3px;
    margin-top: 2px;
    background:
      linear-gradient(90deg, var(--line2) 0 1px, transparent 1px) 0 0 / 25% 100%,
      linear-gradient(var(--line2), var(--line2)) 100% 0 / 1px 100% no-repeat;
  }
  .io {
    display: grid;
    grid-template-columns: 28px 1fr 38px;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--dim);
    padding: 3px 0;
  }
  .io b {
    font: 11.5px var(--mono);
    font-weight: 400;
    color: var(--ink);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .io .bar {
    margin: 0;
  }
  .tks {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 7px;
  }
  .tks i {
    width: 6px;
    height: 12px;
    background: var(--done);
    border-radius: 1px;
  }
  .tks i.r {
    background: var(--signal);
    box-shadow: var(--glow-signal);
  }
  .tks i.e {
    background: var(--failed, var(--hot));
  }
  @media (prefers-reduced-motion: no-preference) {
    .bar i {
      transition: width 300ms ease;
    }
  }
</style>
