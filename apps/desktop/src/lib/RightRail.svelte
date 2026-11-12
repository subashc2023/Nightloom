<script lang="ts">
  import ProviderRail from "./ProviderRail.svelte";
  import TaskPanel from "./TaskPanel.svelte";
  import ContextDial from "./ContextDial.svelte";
  import DialMotion from "./DialMotion.svelte";
  import { ContextDrive } from "./contextDrive.svelte";
  import { app, chatAgentSession, contextUsed, currentTodos } from "./state.svelte";
  import * as api from "./api";
  import {
    compactCount,
    duration,
    modelName,
    resetClock,
    spenderName,
    stackParts,
    usd,
    type ScopedLimits,
    type SessionFigures,
    type StackPart,
  } from "./usageFigures";
  import { mark as handoffMark } from "./handoff.svelte";
  import { touchedUntil } from "./keepWarm";
  import { keepWarm } from "./keepWarm.svelte";
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
  import { railFold, toggleRailFold } from "./railFold.svelte";
  import { liveContextOf } from "./liveContext.svelte";
  import { liveFor, liveLegend, liveTip, liveTokens, liveValue } from "./liveContext";
  import type { Aside } from "./state.svelte";
  import { asideFigures } from "./asideFigures";
  import { contextOf } from "./chatContext.svelte";

  interface Props {
    /**
     * Item 533 (Filament IV stage 2): the right column beside the chat —
     * Context (the dial and its three legend lines), Plan use, This turn,
     * Tasks. Without it, the model chip's popover as before (Model · Tasks).
     */
    column?: boolean;
    /**
     * Item 605 (his "shouldn't asides still have cost, context, all of the
     * stuff in the side bar?"): the column beside an aside tab — the same
     * column, reading the aside: its context dial, plan use, This aside
     * (its cost and cache hit), This turn (its newest exchange). No Tasks
     * (the to-do list is the chat's session's) and no cache timer (the
     * timer is the chat's newest reply's). Null: the chat's, as before.
     */
    aside?: Aside | null;
    /** The chat the aside is of (item 605), for its hand-off line. */
    asideChat?: string | null;
  }
  let { column = false, aside = null, asideChat = null }: Props = $props();

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

  /**
   * Item 590: while a reply runs, the live reading — the last exact figure
   * plus an estimate of what has streamed since — in place of the last
   * round's. (Declared before `used`; `live` and `logged` are below.)
   */
  let now = $state(Date.now());
  /** Item 605: the aside's own figures, on the column's clock (declared
   *  here, before the readings that use it). */
  /** Item 639: the chat's last context reading — the prefix every aside of
   *  it forks from — for an aside that kept no tokens (answered before 605). */
  const asideBase = $derived.by(() => {
    if (!column || !aside || !asideChat) return null;
    if (asideChat === app.activeSessionId) return contextUsed() ?? contextOf(asideChat)?.used ?? null;
    return contextOf(asideChat)?.used ?? null;
  });
  const af = $derived(column && aside ? asideFigures(aside, now, asideBase) : null);
  /** Item 639: the dial's figure is an estimate (no turn kept its tokens). */
  const est = $derived(af?.estimated ?? null);
  const liveCtx = $derived(
    column && !aside && app.busy && app.live != null
      ? liveFor(liveContextOf(app.activeSessionId), lastLoggedTurn(app.events)?.startedAt ?? null)
      : null,
  );
  /** Context: the next request's prefix over the window (the top bar's gauge's figures). */
  const used = $derived(column ? (af ? af.used : liveCtx ? liveTokens(liveCtx) : contextUsed()) : null);
  const limit = $derived(app.connection?.contextLimit ?? (aside && asideChat ? contextOf(asideChat)?.limit || null : null));
  const share = $derived(used != null && limit ? Math.min(used / limit, 1) : 0);
  /** Item 590: the estimated tail of the arc, as a share of the window. */
  const estShare = $derived(liveCtx && liveCtx.estimate > 0 && limit ? Math.min(liveCtx.estimate / limit, share) : null);
  /** Item 590: each exact step swells the column's motion (587's language). */
  const stepKey = $derived(liveCtx ? `${app.activeSessionId ?? ""}:${liveCtx.steps}` : "");
  /** The hand-off line: the chat's own mark, else the Settings percent or token cap (backlog 436). */
  const markShare = $derived(limit ? handoffMark(aside ? asideChat : app.activeSessionId, limit) : null);
  const markTokens = $derived(limit && markShare != null ? Math.round(markShare * limit) : null);
  const ticks = $derived(tickCounts(limit));
  const handoffLine = $derived(handoffText(used, markTokens));

  /**
   * The prompt cache (backlog 063): the newest live reply's entry. The
   * clock wakes when the text would change — once a minute, then once a
   * second under two minutes — and not at all once cold, so an idle
   * column with a cold cache has no timer.
   */
  const cache = $derived(column && !aside ? cacheState(app.events, now, app.activeSessionId ? touchedUntil(keepWarm.byChat[app.activeSessionId]) : null) : null);
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

  /**
   * Item 654 (his pick B3, blocker 1962): the column's dial moves with a
   * reply — the drive (`dialDrive.ts`) follows the live reading while one
   * runs (the chat's `liveCtx`; an aside's figure as it lands) and runs the
   * landing when it ends; ContextDial draws its layer, DialMotion's gears
   * count its tokens. At rest it holds still, as before.
   */
  const drive = new ContextDrive();
  $effect(() => {
    if (!column || used == null || !limit) return;
    drive.set({
      exact: liveCtx ? liveCtx.exact : used,
      estimate: liveCtx ? liveCtx.estimate : 0,
      limit,
      streaming: live,
      ticks: ticks.minor,
    });
  });
  $effect(() => () => drive.destroy());
  const dv = $derived(column && used != null && limit ? drive.view : null);
  /** The figure: the drive's count while it moves, `~` while it is an estimate. */
  const dialValue = $derived.by(() => {
    if (dv && used != null) {
      const estimating = dv.estimating || (liveCtx != null && liveCtx.estimate > 0);
      return `${estimating || est ? "~" : ""}${shortTokens(dv.figure)}`;
    }
    return liveCtx ? liveValue(liveCtx, shortTokens) : used != null ? `${est ? "~" : ""}${shortTokens(used)}` : "—";
  });

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
  const logged = $derived(column && !aside ? lastLoggedTurn(app.events) : null);
  const live = $derived(af ? !!af.turn?.live : column && app.busy && app.live != null);
  $effect(() => {
    if (!live) return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const turnClock = $derived.by(() => {
    if (af) return af.turn?.ms != null ? clockText(af.turn.ms) : null;
    if (!logged?.startedAt) return null;
    if (live) return clockText(now - logged.startedAt);
    return logged.endedAt != null && logged.endedAt >= logged.startedAt ? clockText(logged.endedAt - logged.startedAt) : null;
  });
  const marks = $derived(
    aside ? toolMarks(aside.turns[aside.turns.length - 1]?.segments ?? []) : live ? toolMarks(app.live?.segments ?? []) : (logged?.tools ?? []),
  );
  const turnUsage = $derived(af ? (af.turn?.usage ?? null) : live ? app.liveUsage : (logged?.usage ?? null));
  const inTokens = $derived(freshIn(turnUsage));
  /** Item 639: an aside answer that kept no tokens: its output estimated from its text. */
  const outEst = $derived(!turnUsage && af?.turn?.estOut != null);
  const outTokens = $derived(turnUsage ? turnUsage.output_tokens : (af?.turn?.estOut ?? null));
  const ioScale = $derived(niceCeil(Math.max(inTokens ?? 0, outTokens ?? 0)));
  const toolsLine = $derived(toolsText(marks));
  const hasTurn = $derived(turnClock != null || inTokens != null || outTokens != null || toolsLine != null);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  /**
   * Item 585: the new-chat layers the column's dial draws. Item 587 (his "add
   * the gear and vibrating thing to the context wheel too", then "the same new
   * chat animatiosn"): every new-chat layer, in DialMotion's column form, which
   * keeps them in the band outside the figure. (Null: all layers.)
   */
  const COLUMN_LAYERS = null;
  /** Item 587: the 5-hour hand, from the same plan use the column shows below. */
  const motionPlan = $derived(plan ? { used: plan.five_hour ?? null, resetsAt: plan.five_hour_resets_at ?? null } : null);
  /** Item 587: his keys in a composer surge the column's ring, as they do the new-chat dial's. */
  let keys = $state(0);
  $effect(() => {
    if (!column) return;
    const on = (e: Event) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".composer")) keys++;
    };
    document.addEventListener("input", on, { passive: true });
    return () => document.removeEventListener("input", on);
  });

  // ---- item 569: Claude Code's /usage figures. The account's per-model
  // weeklies (the CLI cache) under Plan use; this chat's own totals (its
  // transcript's `cost-state`) in This chat. Neither is drawn from a guess:
  // a figure the files do not hold is left out.
  const claudeCode = $derived(column && app.connection?.engine === "claude-code");
  let scoped = $state<ScopedLimits | null>(null);
  $effect(() => {
    if (!claudeCode) return;
    // Re-read whenever the plan reading moves (its five-minute refresh rewrites the cache).
    void app.planUsage?.sampled_at_ms;
    let gone = false;
    api
      .planScopedLimits()
      .then((s) => {
        if (!gone) scoped = s;
      })
      .catch(() => {});
    return () => (gone = true);
  });
  const agentSession = $derived(claudeCode && !aside ? chatAgentSession(app.events) : null);
  let figures = $state<SessionFigures | null>(null);
  let figuresOf = $state<string | null>(null);
  $effect(() => {
    const id = agentSession;
    // A turn's end writes the newest totals: read again when one ends.
    const busy = app.busy;
    if (!id || busy) return;
    let gone = false;
    api
      .sessionFigures(id)
      .then((f) => {
        if (gone) return;
        figures = f;
        figuresOf = id;
      })
      .catch(() => {});
    return () => (gone = true);
  });
  /** Only the open chat's figures: another chat's never show while this one's load. */
  const chat = $derived(figures && figures.found && figuresOf === agentSession ? figures : null);
  // Item 584: the two splits as stacked bars, and the Details fold (kept across chats and restarts).
  const modelParts = $derived(chat ? stackParts(chat.models.map((m) => ({ name: modelName(m.model), value: m.cost_usd }))) : []);
  const usingParts = $derived(chat ? stackParts(chat.using.map((u) => ({ name: spenderName(u), value: u.share }))) : []);
  const DETAILS_KEY = "nightloom.chatDetails";
  let details = $state(readDetails());
  function readDetails(): boolean {
    try {
      return localStorage.getItem(DETAILS_KEY) === "1";
    } catch {
      return false;
    }
  }
  function toggleDetails() {
    details = !details;
    try {
      localStorage.setItem(DETAILS_KEY, details ? "1" : "0");
    } catch {
      /* the fold still works for this run */
    }
  }
</script>

{#snippet stack(title: string, why: string, parts: StackPart[])}
  <div class="stack" use:tip={why}>
    <div class="sub">{title}</div>
    <div class="sbar" role="img" aria-label={`${title}: ${parts.map((p) => `${p.name} ${p.pct}%`).join(", ")}`}>
      {#each parts as p, i (p.name)}<i class="c{i % 5}" style:flex-grow={p.share}></i>{/each}
    </div>
    <div class="lg">
      {#each parts as p, i (p.name)}<span><i class="c{i % 5}"></i>{p.name}<b>{p.pct}%</b></span>{/each}
    </div>
  </div>
{/snippet}

{#snippet foldButton(folded: boolean)}
  <!-- Item 599: fold the column to a strip and back; the choice is kept across chats and relaunches. -->
  <button
    type="button"
    class="fold"
    aria-expanded={!folded}
    aria-label={folded ? "Show the right column" : "Hide the right column"}
    use:tip={folded ? "Show the context dial and readings" : "Hide the context dial and readings; the chat widens"}
    onclick={toggleRailFold}
  >
    <svg viewBox="0 0 12 12" aria-hidden="true"><path d={folded ? "M7.5 2.5 4 6l3.5 3.5" : "M4.5 2.5 8 6 4.5 9.5"} /></svg>
  </button>
{/snippet}

{#if column && railFold.folded}
  <aside class="col folded" aria-label="Context, plan use, this turn and tasks (folded)">
    {@render foldButton(true)}
    {#if used != null && limit}
      <span class="fpct" use:tip={`Context ${used.toLocaleString()} of ${limit.toLocaleString()} tokens`}>{pct(share)}</span>
    {/if}
  </aside>
{:else if column}
  <!-- Item 563: data-rail-col — the first send from the new-chat page slides this column in (sendMotion.ts departDial). -->
  <aside class="col" data-rail-col aria-label="Context, plan use, this turn and tasks">
    <section>
      <h4>Context <span class="hr"><span>{modelShort(af?.model ?? aside?.model ?? app.connection?.model)}</span>{@render foldButton(false)}</span></h4>
      <div class="dial-at" data-dial-dock>
        <!-- Item 585: a few of 581's new-chat layers behind the dial, quieter (item 587: DialMotion's column form —
             all of the new-chat dial's layers, the gears, radar and 5-hour hand between the figure and the inner ring; his keys surge it too); the ring holds a gentle surge while a turn streams
             and each new tool call nudges it. Paused when hidden, still under reduced motion. -->
        <div class="dm-at">
          <DialMotion size={104} pad={14} quiet column layers={COLUMN_LAYERS} plan={motionPlan} streaming={live} typed={marks.length + keys} flowKey={stepKey} gear={dv ? drive.gear : null} gearKey={drive.n} />
        <ContextDial
          size={104}
          share={dv ? dv.solid : share}
          mark={markShare}
          inner={cache ? cacheShare : null}
          estimate={dv ? null : estShare}
          drive={dv}
          minor={ticks.minor}
          major={ticks.major}
          value={dialValue}
          unit={limit ? `of ${shortTokens(limit)}` : used != null ? "window unknown" : ""}
          label={used != null
            ? `Context ${(liveCtx && liveCtx.estimate > 0) || est ? "about " : ""}${used.toLocaleString()} tokens${limit ? ` of ${limit.toLocaleString()}` : ""}${liveCtx && liveCtx.estimate > 0 ? ", estimated since the last step" : ""}${est ? ", estimated" : ""}`
            : "Context: no reading yet"}
        />
        </div>
      </div>
      <div class="legend">
        {#if limit && used != null}
          <div class="dk" use:tip={"What the next request carries, over the model's window"}>
            <i class="u"></i><span>Used</span><b>{pct(share)}</b>
          </div>
        {/if}
        {#if est}
          <!-- Item 639: an aside that kept no tokens — its figure is estimated, and says from what. -->
          <div
            class="dk est"
            use:tip={est === "chat"
              ? "Estimated: this aside kept no token counts (answered before Nov 11), so the figure is the chat's last context reading plus the thread's text (characters ÷ 4)"
              : "Estimated, a floor: no token counts kept and no reading of the chat's context yet, so only the thread's text (characters ÷ 4)"}
          >
            <i class="e"></i><span>Estimated</span><b>{est === "chat" ? "chat + thread" : "thread only"}</b>
          </div>
        {/if}
        {#if liveCtx}
          <!-- Item 590: the live reading's line while a reply runs — exact at a step, else the estimate on top. -->
          <div class="dk live" class:est={liveCtx.estimate > 0} use:tip={liveTip(liveCtx)}>
            <i class="e"></i><span>Live</span><b>{liveLegend(liveCtx, shortTokens)}</b>
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
        <div class="kv" use:tip={"Account-wide: every surface, not just this chat"}>
          <span>5 hours</span><b>{plan.five_hour}%</b>
        </div>
        <div class="bar am"><i style:width="{Math.min(100, plan.five_hour ?? 0)}%"></i></div>
        <div class="scale"></div>
        {#if resetClock(plan.five_hour_resets_at)}<div class="rs">resets {resetClock(plan.five_hour_resets_at)}</div>{/if}
        {#if plan.seven_day != null}
          <div class="kv wk">
            <span>This week</span><b>{plan.seven_day}%</b>
          </div>
          <div class="bar" class:ok={plan.seven_day / 100 <= WEEK_HOT} class:ht={plan.seven_day / 100 > WEEK_HOT}>
            <i style:width="{Math.min(100, plan.seven_day)}%"></i>
          </div>
          <div class="scale"></div>
          {#if resetClock(plan.seven_day_resets_at)}<div class="rs">resets {resetClock(plan.seven_day_resets_at)}</div>{/if}
        {/if}
        {#each scoped?.limits ?? [] as l (l.name)}
          <div
            class="kv wk"
            data-scoped={l.name}
            use:tip={`The week's ${l.name}-only limit, account-wide (Claude Code's cache, as /usage shows it)${scoped?.stale ? "; the reading is over twenty minutes old" : ""}`}
          >
            <span>{l.name} this week</span><b>{l.percent}%</b>
          </div>
          <div class="bar" class:ok={l.percent / 100 <= WEEK_HOT} class:ht={l.percent / 100 > WEEK_HOT}>
            <i style:width="{Math.min(100, l.percent)}%"></i>
          </div>
          <div class="scale"></div>
          {#if resetClock(l.resets_at)}<div class="rs">resets {resetClock(l.resets_at)}</div>{/if}
        {/each}
      </section>
    {/if}

    {#if chat}
      <!-- Item 584 (his "squashed … not easy to look at" on 569): the cost large, three small tiles, one stacked bar
           per split; the per-model tokens and both clocks behind Details, which keeps its fold. -->
      <section class="chat-use" aria-label="This chat's usage">
        <h4>This chat</h4>
        {#if chat.cost_usd != null}
          <div class="cost" use:tip={"Claude Code's own estimate at API prices, subagents included — the figure /usage shows"}>
            <b>{usd(chat.cost_usd)}{chat.unknown_cost ? "+" : ""}</b><span>at API prices</span>
          </div>
        {/if}
        <div class="tiles">
          {#if chat.cache_hit != null}
            <div class="tile" use:tip={"Input read back from the prompt cache, of all input"}>
              <span>Cache hit</span><b>{Math.round(chat.cache_hit * 100)}%</b>
            </div>
          {/if}
          {#if chat.lines_added != null || chat.lines_removed != null}
            <div class="tile" use:tip={`Lines Claude's edits added and removed in this chat: +${(chat.lines_added ?? 0).toLocaleString()} −${(chat.lines_removed ?? 0).toLocaleString()}`}>
              <span>Lines</span><b><ins>+{compactCount(chat.lines_added ?? 0)}</ins> <del>−{compactCount(chat.lines_removed ?? 0)}</del></b>
            </div>
          {/if}
          {#if chat.run_ms != null}
            <div class="tile" use:tip={"Claude Code's own clock over this chat's runs (not /usage's Active, which Claude Code never writes down)"}>
              <span>Run time</span><b>{duration(chat.run_ms)}</b>
            </div>
          {/if}
        </div>
        {#if modelParts.length > 1}
          {@render stack("Models", "Each model's share of this chat's cost", modelParts)}
        {/if}
        {#if usingParts.length > 1}
          {@render stack("Using it", "Who spent this chat's cost: the main chat and each subagent type", usingParts)}
        {/if}
        <button class="more" type="button" aria-expanded={details} onclick={toggleDetails}>
          <svg viewBox="0 0 8 8" aria-hidden="true"><path d="M2.5 1.5 5.5 4 2.5 6.5" /></svg>Details
        </button>
        {#if details}
          <div class="det">
            {#if chat.api_ms != null}
              <div class="kv" use:tip={"Every request's time, subagents' too, so it can pass the clock"}><span>API time</span><b>{duration(chat.api_ms)}</b></div>
            {/if}
            {#if chat.run_ms != null}
              <div class="kv" use:tip={"Claude Code's own clock over this chat's runs"}><span>Run time</span><b>{duration(chat.run_ms)}</b></div>
            {/if}
            {#if chat.models.length}
              <table class="tok" aria-label="Tokens by model">
                <thead><tr><th scope="col">Tokens</th><th scope="col" use:tip={"Input not read from the cache"}>In</th><th scope="col">Out</th><th scope="col" use:tip={"Read back from the prompt cache"}>Read</th><th scope="col" use:tip={"Written to the prompt cache"}>Write</th></tr></thead>
                <tbody>
                  {#each chat.models as m (m.model)}
                    <tr use:tip={`${modelName(m.model)}: in ${m.input.toLocaleString()}, out ${m.output.toLocaleString()}, cache read ${m.cache_read.toLocaleString()}, cache write ${m.cache_write.toLocaleString()} · ${usd(m.cost_usd)}`}>
                      <th scope="row">{modelName(m.model)}</th>
                      <td>{compactCount(m.input)}</td>
                      <td>{compactCount(m.output)}</td>
                      <td>{compactCount(m.cache_read)}</td>
                      <td>{compactCount(m.cache_write)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
        {/if}
      </section>
    {/if}

    {#if af && af.exchanges > 0}
      <!-- Item 605: the aside's own spend, in This chat's form. Item 639: always drawn for an asked aside — an
           old one says its cost was not kept rather than dropping the section. -->
      <section class="chat-use" aria-label="This aside's usage">
        <h4>This aside</h4>
        {#if af.cost}
          <div class="cost" use:tip={"The CLI's estimate for each of this aside's answers, at API prices — not a bill under a subscription"}>
            <b>{usd(af.cost.usd)}{af.cost.complete ? "" : "+"}</b><span>at API prices</span>
          </div>
        {:else}
          <div class="kv" data-cost-unkept use:tip={"Answers before Nov 11 kept no cost estimate; the next answer here is counted"}>
            <span>Cost</span><b>not kept</b>
          </div>
        {/if}
        <div class="tiles">
          <div class="tile" use:tip={"Questions asked in this aside"}>
            <span>Exchanges</span><b>{af.exchanges}</b>
          </div>
          {#if af.cacheHit != null}
            <div class="tile" use:tip={"The newest answer's input read back from the chat's prompt cache, of all its input"}>
              <span>Cache hit</span><b>{Math.round(af.cacheHit * 100)}%</b>
            </div>
          {/if}
        </div>
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
          <div class="io" use:tip={outEst ? "The newest answer's output, estimated from its text (characters ÷ 4): this answer kept no token counts" : "The newest request's output"}>
            <span>Out</span>
            <div class="bar sg"><i style:width="{(outTokens / ioScale) * 100}%"></i></div>
            <b>{outEst ? "~" : ""}{shortTokens(outTokens)}</b>
          </div>
        {/if}
        {#if toolsLine}
          <div class="kv tools"><span>Tools</span><b>{toolsLine}</b></div>
          {#if marks.length > 1}<div class="tks" aria-hidden="true">
            {#each marks as m, i (i)}<i class:r={!m.done} class:e={m.error}></i>{/each}
          </div>{/if}
        {/if}
      </section>
    {/if}

    {#if !aside}
      <section class="tasks">
        <TaskPanel column />
      </section>
    {/if}
  </aside>
{:else}
  <aside class="rail">
    <div class="tabs" role="tablist">
      <!-- Item 657: an aside's card (its chip's) has no Tasks — the to-do list is the chat's session's, as in 605's column. -->
      {#each aside ? TABS.filter((t) => t.id !== "tasks") : TABS as t (t.id)}
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

    {#if tab === "connection" || aside}
      <ProviderRail {aside} {asideChat} />
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
  /* ---- item 599: the fold button, and the folded strip */
  .col h4 .hr {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .fold {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin: -4px -4px -4px 0;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--dim);
    cursor: pointer;
  }
  .fold:hover {
    color: var(--ink);
    border-color: var(--line);
  }
  .fold:focus-visible {
    outline: 2px solid var(--signal);
    outline-offset: 1px;
  }
  .fold svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .col.folded {
    padding: 12px 0;
    align-items: center;
    gap: 10px;
    overflow: hidden;
  }
  .col.folded .fold {
    margin: 0;
    width: 24px;
    height: 24px;
  }
  .fpct {
    font: 10px var(--mono);
    color: var(--dim);
    font-variant-numeric: tabular-nums;
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
  /* Item 629: Calm used to set these headings in 12 px sans; Instrument
     light changes only the light now, so they are mono capitals in both. */
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
  .dm-at {
    position: relative;
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
  /* Item 590: the live line's key — the estimate's lighter tone (the dial's tail breathes; the legend holds still). */
  .dk i.e {
    background: color-mix(in srgb, var(--accent) 45%, var(--well));
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
  /* Item 569: a limit's reset under its bar, small and dim. */
  .rs {
    font: 10px var(--mono);
    color: var(--dim);
    text-align: right;
    margin-top: 1px;
  }
  /* ---- Item 584: This chat at a glance. */
  .cost {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin: 0 0 10px;
  }
  .cost b {
    font: 400 24px/1 var(--mono);
    letter-spacing: -0.02em;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .cost span {
    font-size: 11px;
    color: var(--dim);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, auto);
    justify-content: space-between;
    gap: 8px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .tile span {
    font-size: 10.5px;
    color: var(--dim);
    white-space: nowrap;
  }
  .tile b {
    font: 400 13px var(--mono);
    color: var(--ink);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .tile b ins {
    text-decoration: none;
    color: var(--done);
  }
  .tile b del {
    text-decoration: none;
    color: var(--hot);
  }
  .stack {
    margin-top: 12px;
  }
  .stack .sub {
    margin: 0 0 5px;
  }
  .sbar {
    display: flex;
    gap: 2px;
    height: 6px;
  }
  .sbar i {
    flex: 0 0 auto;
    flex-basis: 0;
    min-width: 3px;
    border-radius: 2px;
  }
  .lg {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 12px;
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--ink2);
  }
  .lg span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .lg i {
    width: 6px;
    height: 6px;
    border-radius: 1px;
  }
  .lg b {
    font: 400 11px var(--mono);
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .c0 {
    background: var(--accent);
  }
  .c1 {
    background: var(--signal);
  }
  .c2 {
    background: var(--done);
  }
  .c3 {
    background: var(--ink2);
  }
  .c4 {
    background: var(--dim);
  }
  .more {
    margin: 12px 0 0;
    padding: 2px 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: 0;
    font: 500 10px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    cursor: pointer;
  }
  .more:hover,
  .more:focus-visible {
    color: var(--ink);
  }
  .more svg {
    width: 8px;
    height: 8px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
  }
  .more[aria-expanded="true"] svg {
    transform: rotate(90deg);
  }
  .det {
    margin-top: 6px;
  }
  .sub {
    margin: 9px 0 1px;
    font: 500 10px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .tok {
    width: 100%;
    margin-top: 6px;
    border-collapse: collapse;
    font: 10px var(--mono);
    font-variant-numeric: tabular-nums;
    table-layout: fixed;
  }
  .tok th,
  .tok td {
    padding: 3px 0;
    text-align: right;
    font-weight: 400;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tok thead th {
    color: var(--dim);
    font-size: 10px;
    border-bottom: 1px solid var(--line);
  }
  .tok thead th:first-child {
    width: 27%;
    text-align: left;
  }
  .tok tbody th {
    text-align: left;
    color: var(--ink2);
    font: 10.5px var(--sans);
  }
  .tok td {
    color: var(--ink);
    padding-left: 2px;
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
  /* Item 584: one segment per call, in the bars' grammar (a lone 6 × 12 block read as a stray mark). */
  .tks {
    display: flex;
    gap: 2px;
    height: 4px;
    margin-top: 5px;
  }
  .tks i {
    flex: 1 1 0;
    max-width: 18px;
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
