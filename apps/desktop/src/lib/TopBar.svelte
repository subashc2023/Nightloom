<script lang="ts">
  import {
    addToast,
    app,
    chatMode,
    compactSession,
    contextUsed,
    currentTodos,
    liveFlags,
    MODE_GLYPH,
    sessionCost,
    subagentsOfTurn,
  } from "./state.svelte";
  import { cacheState } from "./cache";
  import { budgetChip, budgetTitle } from "./budget";
  import RightRail from "./RightRail.svelte";
  import { portal, anchorBelow } from "./portal";
  import { foldToFit } from "./fold";
  const POP_WIDTH = 340;
  import NotificationCentre from "./NotificationCentre.svelte";
  import { chatKind, kindLabel, openSession } from "./state.svelte";
  import { forkLine } from "./edit";

  /**
   * The chat top bar in the redesign (item 036, the mock-up's Chat artboard):
   * the session's name and short id on the left; on the right the ~~model~~
   * kind chip, the context chip, ~~the cache chip,~~ the cost chip and
   * Compact. The ~~model~~ chip opens a popover that *is* the old right
   * rail (Model · Tasks · Context), so nothing the rail did is lost — it
   * just no longer takes a 240px column on every screen.
   *
   * Shortened 2026-09-16 (nightshift backlog 112, "the top bar is kinda
   * getting too long"): the model's name, the thinking and tools toggles
   * and the cache chip moved to the composer — the model and effort as
   * buttons in the box, thinking · tools · cache on a row under it — and
   * the chip reads the kind and the engine alone (blocker 141). This bar
   * is what is about the *chat*: its name, its kind, how full its window
   * is, the plan, what it has cost.
   *
   * Folds by priority (nightshift backlog 129, 2026-09-17; the rule his
   * review of the tabs boards stated for 099 — "shortening the number of
   * elements rather than just truncating all of them"): the bar is a CSS
   * container, and as *its own* width runs out — a narrow window, a pane
   * of a split, ⌘= at 150–200% — the chips shed their words in three
   * steps rather than clipping at the right edge. Step 1 (under 1000px):
   * the gauges lose their labels — the context gauge's `of 200k`, the plan
   * chip's `plan` and `· stale` (the colour and the title still say it).
   * Step 2 (under 860px): the spend chip folds into the gauge's hover, the
   * gauge drops its percentage, the plan chip its week. Step 3 (under
   * 700px): the token count folds into the gauge's hover too — both
   * gauges are bars alone, every value in their titles — and the kind
   * chip drops the engine. What survives last is his priority order: the
   * plan's 5h bar, the context bar, the kind. Nothing is removed outright:
   * every folded figure is in the hover of the chip it folded into, and
   * the rail (⌘M) and the Context page (⌘⇧C) have all of it. A container
   * query, not a media query, so the zoom factor (backlog 108) is
   * invisible to it: at 200% the bar is half as many CSS pixels wide and
   * folds as a half-width bar would.
   * ~~A container query … invisible to the zoom~~ — wrong in WebKit
   * (nightshift backlog 183, measured 2026-09-22): under page zoom the
   * query reads the bar's width × the zoom, so each step fired a zoom
   * step late and the bar wrapped. The bar now folds by measuring
   * (`fold.ts`).
   *
   * Board d since 2026-09-22 (nightshift backlog 175 pass 2, blocker 274):
   * no title row — the tab names the chat, and its hover carries the short
   * id; the context gauge, the plan chip and the spend chip are one gauge
   * chip — two thin bars (context over plan) and the plan reading's age —
   * whose click opens a card with every figure and a button to the
   * itemised Context page (⌘⇧C still opens that page directly). One row,
   * 44 px, at every zoom from 100 to 200 % in a 1440 px window; what is
   * left to fold (the kind chip's engine, the agents chip's words) folds by
   * measurement, and the wrap stays the floor beneath.
   */

  const session = $derived(app.sessions.find((s) => s.id === app.activeSessionId) ?? null);
  // ~~`title` and `crumb` (the name and the short id on the bar's left)~~ —
  // board d (backlog 175): the tab is the title; the id is in its hover.

  /**
   * The chat's mode, projected from its log (nightshift backlog 059): a
   * glyph and the word after the short id. An ephemeral chat has no listing
   * row, so `title` above is empty for it and this mark is what says what
   * it is; it also says, in the same breath, that nothing is kept.
   */
  /**
   * "Continued from" (nightshift backlog 086): a chat opened by the
   * hand-off card carries its parent on its creation line with
   * `reason: "handoff"`; the mark names the parent the way the sidebar's
   * lineage line does and opens it on click. An edit-and-send fork has
   * no reason and no mark here — the sidebar already says "from …".
   */
  const continuedFrom = $derived.by(() => {
    if (!session?.forked_from || session.forked_from.reason !== "handoff") return null;
    const line = forkLine(session, app.sessions) ?? "from an earlier chat";
    return { id: session.forked_from.session, line: line.replace(/^from /, "") };
  });
  const mode = $derived(chatMode(app.events));
  const modeText = $derived(
    mode === "incognito"
      ? "incognito"
      : mode === "ephemeral"
        ? "ephemeral — nothing is kept"
        : "",
  );
  const modeTitle = $derived(
    mode === "incognito"
      ? "Incognito: kept and marked; writes nothing, unread by other chats"
      : "Ephemeral: no log, no name, no CLI session; gone when you close it",
  );

  /**
   * Context gauge. The denominator comes from the backend's limits table and
   * is null for models it doesn't know; in that case the raw count is shown
   * with no bar, because a guessed window would tell the reader — and the
   * model reading the same figure in its sidecar — that there is headroom
   * nobody verified.
   */
  const gauge = $derived.by(() => {
    const used = contextUsed();
    if (used == null) return null;
    const limit = app.connection?.contextLimit ?? null;
    const ratio = limit ? Math.min(used / limit, 1) : null;
    return { used, limit, ratio };
  });

  const level = $derived(
    gauge?.ratio == null ? "" : gauge.ratio >= 0.9 ? "hot" : gauge.ratio >= 0.7 ? "warm" : "",
  );

  /**
   * Session spend. Shown only once there is something to show, and never as
   * "$0.00" for a model with no price — an unknown cost and a free one look
   * identical at two decimal places, and only one of them is true.
   */
  const spend = $derived.by(() => {
    const c = sessionCost();
    if (!c) return null;
    if (c.usd === 0 && c.complete) return null;
    // Sub-cent turns are the common case early in a session; two decimals
    // would render most of them as $0.00 and look broken.
    const digits = c.usd > 0 && c.usd < 0.01 ? 4 : 2;
    return { text: `$${c.usd.toFixed(digits)}`, complete: c.complete };
  });

  /**
   * The prompt-cache timer (nightshift backlog 063, 2026-09-15): when the
   * last turn's cache entry expires, read off the log — each turn records
   * when its request was sent and the lifetime of the cache it left, on
   * both engines — so reopening a chat shows the countdown it had.
   *
   * This supersedes the countdown the cached chip used to infer (five
   * minutes from the reply's *end*, API engine only): the origin was the
   * wrong clock, since the API counts from the request's start, and the
   * Claude Code engine's hour was unreadable from here. Both are now
   * recorded; see `cache.ts`.
   *
   * ~~The clock is a chain of timeouts aligned to when the text would
   * change~~ — the chip and its clock moved to the composer's bottom row
   * (nightshift backlog 112, 2026-09-16); what stays here is the toast
   * on the crossing to cold, since this bar is up on every view the chat
   * is open under and the composer only under the transcript. One timeout
   * to the expiry, and only if the cache was warm when the chain was
   * built: a chat reopened already cold is a state, not a crossing, and
   * the chain is torn down and rebuilt whenever the open chat's log
   * changes, so a background chat has no chain and cannot toast.
   */
  $effect(() => {
    const warmUntil = cacheState(app.events, Date.now())?.warmUntil ?? null;
    if (warmUntil == null) return;
    const wait = warmUntil - Date.now();
    if (wait <= 0) return;
    // A millisecond past the boundary, as the display's ticks were: a
    // timer firing on the boundary itself would read the cache as warm.
    const id = setTimeout(
      () => addToast("Prompt cache cold — edits to the history now cost nothing extra"),
      wait + 1,
    );
    return () => clearTimeout(id);
  });

  /**
   * The plan chip (nightshift backlog 073, 2026-09-16): on the Claude Code
   * engine, the subscription's five-hour and seven-day percentages beside
   * the context gauge — two numbers he ran `/usage` for more than any
   * other command. Read from the Claude desktop app's sample file and the
   * CLI's cache (`plan_usage.rs`), whichever is fresher, at connect and at
   * every turn end; the title says how old the reading is and when each
   * window resets, and a reading past twenty minutes is marked stale
   * rather than shown as current. Account-wide and server-computed: it
   * counts every surface, not this chat. Nothing before a sample exists.
   * ~~The last turn's `rate_limit_event` carries no percentage~~ — measured
   * 2026-09-16 on CLI 2.1.263, it does (`unifiedWindows`, both windows),
   * and that live figure is the first choice (`planUsageFromTurn`); the
   * files are the fallback before the first turn and on an older CLI.
   */
  const plan = $derived.by(() => {
    if (app.connection?.engine !== "claude-code") return null;
    const u = app.planUsage;
    if (!u || u.source === "none" || u.five_hour == null) return null;
    return u;
  });
  // The reading's age, ticking (his ask 2026-09-18: "add like a '5min
  // ago' in the bar at the top"): `age_seconds` is fixed at the read, so
  // the clock here runs from `sampled_at_ms` every 30 s.
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });
  const planAgeSeconds = $derived.by(() => {
    if (!plan) return null;
    if (plan.sampled_at_ms != null) return Math.max(0, (now - plan.sampled_at_ms) / 1000);
    return plan.age_seconds;
  });
  const planAgeMark = $derived.by(() => {
    const a = planAgeSeconds;
    if (a == null) return "?";
    if (a < 90) return "now";
    if (a < 3600) return `${Math.round(a / 60)}m`;
    return `${Math.round(a / 3600)}h`;
  });
  const planAgeText = $derived(
    planAgeSeconds == null
      ? "age unknown"
      : planAgeSeconds < 90
        ? "sampled just now"
        : `sampled ${Math.round(planAgeSeconds / 60)} min ago`,
  );
  const planWhere = $derived(
    !plan
      ? ""
      : plan.source === "turn"
        ? "this chat's last turn (the CLI's rate-limit event)"
        : plan.source === "desktop"
          ? "the Claude app's sample"
          : plan.source === "cli-usage"
            ? "the CLI's /usage, run live (zero tokens)"
            : "the CLI's /usage cache",
  );
  /** A reset time for the gauge card (board d): `21:40` today, `Thu 09:00`
   *  on another day. */
  function resetText(iso: string | null): string {
    if (!iso) return "reset time unknown";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "reset time unknown";
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const today = new Date(now);
    return d.toDateString() === today.toDateString()
      ? `resets ${time}`
      : `resets ${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  const planTitle = $derived.by(() => {
    if (!plan) return "";
    const age = planAgeText;
    const where = planWhere;
    const when = (iso: string | null) => {
      if (!iso) return "reset time unknown";
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "reset time unknown" : `resets ${d.toLocaleString()}`;
    };
    return (
      `Plan usage, account-wide (every surface, not just this chat): ` +
      `5-hour window ${plan.five_hour}% (${when(plan.five_hour_resets_at)}); ` +
      `7-day window ${plan.seven_day ?? "?"}% (${when(plan.seven_day_resets_at)}). ` +
      `From ${where}, ${age}${plan.stale ? " — stale: past 20 minutes, may be behind" : ""}. Refreshed at each turn end.`
    );
  });

  function tokens(n: number): string {
    if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(2))}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
  }

  // Compaction needs at least one completed exchange to summarize — one the
  // projection still carries, since that is what the backend summarizes.
  const canCompact = $derived.by(() => {
    if (!app.connection) return false;
    // Compaction rewrites what the *log* projects onto the next request, and
    // on the agent engine nothing projects: the next turn resumes a history
    // Claude Code keeps. The button would change what this window shows and
    // nothing about the conversation, which is worse than not offering it.
    if (app.connection.engine === "claude-code") return false;
    const live = liveFlags(app.events);
    return app.events.some((e, i) => live[i] && e.event === "assistant_message");
  });

  // ~~`annotation`: the chip's `· thinking default · tools` tail~~ — gone
  // with backlog 112 (2026-09-16): the thinking mode is the composer's
  // second button on the provider engine, and the tools switch is the
  // rail's; board 10's chips carry neither.

  const openTasks = $derived(currentTodos().filter((t) => t.status !== "completed").length);

  /** The chip's second word: `subscription` on the Claude Code engine,
   *  the provider's name on the other. Folds at step 3 (backlog 129). */
  const engineName = $derived(
    app.connection?.engine === "claude-code" ? "subscription" : (app.connection?.provider ?? ""),
  );
  /** The spend, for the gauge's hover once its chip has folded (backlog
   *  129, step 2) — carried always, so the hover reads the same at every
   *  width. */
  const spendTail = $derived(
    spend ? ` · spent ${spend.complete ? "" : "at least "}${spend.text}` : "",
  );
  /**
   * The latest turn's subagents (nightshift backlog 152): the agents chip
   * — `2 agents · 41k` while any runs, `2 agents · done · 41k` after —
   * opening the Running-tasks panel, and the gauge's "+ subagents" line
   * in its hover, so the window figure is not read as the whole.
   */
  const agents = $derived(subagentsOfTurn());
  const agentsTail = $derived(
    agents.rows.length > 0
      ? ` · + subagents: ${agents.tokens.toLocaleString()} tokens (${agents.rows.length}, not in the window)`
      : "",
  );
  function toggleTasks() {
    app.showRail = false;
    app.showContext = false;
    app.showTasks = !app.showTasks;
  }

  // The popovers: the model one opens from the model chip (or ⌘M, or the
  // ⌘K palette — which is why the flags are app state), the context one
  // from the gauge chip (or ⌘⇧C). The rail closes on Escape, on a click
  // outside it, or on its chip again; opening one closes the other. Context
  // is a centre modal since 2026-09-15 (nightshift backlog 056) — mounted
  // in `App.svelte` on the same overlay as Settings, which handles its
  // own outside click — so only Escape is shared here.
  let popEl = $state<HTMLElement | null>(null);
  let chipEl = $state<HTMLElement | null>(null);
  /** The gauge card (board d, backlog 175): open while true; the bar's
   *  own, since nothing else opens it (⌘⇧C opens the Context page). */
  let showGauge = $state(false);
  let gaugeEl = $state<HTMLElement | null>(null);
  let gaugePopEl = $state<HTMLElement | null>(null);
  function onDocClick(e: MouseEvent): void {
    const t = e.target as Node;
    if (!(popEl?.contains(t) || chipEl?.contains(t))) app.showRail = false;
    if (!(gaugePopEl?.contains(t) || gaugeEl?.contains(t))) showGauge = false;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      app.showRail = false;
      app.showContext = false;
      showGauge = false;
    }
  }
  $effect(() => {
    if (!app.showRail && !app.showContext && !showGauge) return;
    document.addEventListener("mousedown", onDocClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  });
  function toggleRail() {
    app.showContext = false;
    showGauge = false;
    app.showRail = !app.showRail;
  }
  // The card's place, refreshed while it is open on resize and on scroll
  // (backlog 163). ~~From the chip's rectangle~~ — since 2026-09-22 from the
  // bar's (nightshift backlog 180, his word: "it used to be on the right
  // hand side. i think i liked that more"): once the bar wrapped (20392bd)
  // the chip sat mid-window and the card followed it. Back to the pre-163
  // spot — 20 px in from the bar's right end, hanging from its foot — with
  // 163's portal and z-order kept, so the Welcome page's bug stays fixed.
  let barEl = $state<HTMLElement | null>(null);
  let popPos = $state({ top: 0, left: 0 });
  function placePop(): void {
    const el = barEl ?? chipEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    popPos = anchorBelow({ left: r.left, right: r.right - 20, bottom: r.bottom - 1 }, POP_WIDTH, window.innerWidth, 0);
  }
  $effect(() => {
    if (!app.showRail) return;
    placePop();
    window.addEventListener("resize", placePop);
    window.addEventListener("scroll", placePop, true);
    return () => {
      window.removeEventListener("resize", placePop);
      window.removeEventListener("scroll", placePop, true);
    };
  });
  // ~~`toggleContext` (the gauge chip's click)~~ — the chip opens the gauge
  // card since board d (backlog 175); the card's button is `itemise` below,
  // and ⌘⇧C toggles the page from `state.svelte.ts`.

  // The gauge card's place: right-aligned under the gauge chip, refreshed
  // on resize and scroll while open, as the rail's card is.
  const GAUGE_WIDTH = 320;
  let gaugePos = $state({ top: 0, left: 0 });
  function placeGauge(): void {
    if (!gaugeEl) return;
    const r = gaugeEl.getBoundingClientRect();
    gaugePos = anchorBelow({ left: r.left, right: r.right, bottom: r.bottom }, GAUGE_WIDTH, window.innerWidth, 6);
  }
  $effect(() => {
    if (!showGauge) return;
    placeGauge();
    window.addEventListener("resize", placeGauge);
    window.addEventListener("scroll", placeGauge, true);
    return () => {
      window.removeEventListener("resize", placeGauge);
      window.removeEventListener("scroll", placeGauge, true);
    };
  });
  function toggleGauge() {
    app.showRail = false;
    app.showContext = false;
    showGauge = !showGauge;
  }
  function itemise() {
    showGauge = false;
    app.showRail = false;
    app.showContext = true;
  }

  // The folds, by measurement (nightshift backlog 183): on every change of
  // the bar's size — a window resize, a split, ⌘+ — and of what it holds,
  // step the fold level up from 0 until the bar's items sit on one line.
  const FOLD_MAX = 3;
  let rightEl = $state<HTMLElement | null>(null);
  /** Mirrors what `foldToFit` wrote, so the attribute is dynamic markup
   *  (a static one would let Svelte prune the fold rules as unused). */
  let foldAttr = $state("0");
  function refold(): void {
    const bar = barEl;
    if (!bar) return;
    foldAttr = String(foldToFit(
      bar,
      () => [...bar.querySelectorAll(":scope > .left > *, :scope > .right > *")],
      FOLD_MAX,
    ));
  }
  $effect(() => {
    const bar = barEl;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => refold());
    ro.observe(bar);
    if (rightEl) ro.observe(rightEl);
    return () => ro.disconnect();
  });
  $effect(() => {
    // What the bar holds; each read registers the dependency.
    void [
      agents.rows.length,
      agents.running,
      agents.tokens,
      app.turnBudget,
      spend,
      canCompact,
      modeText,
      continuedFrom,
      app.connection,
      gauge == null,
      plan == null,
      planAgeMark,
      openTasks,
    ];
    refold();
  });
  // ~~The two transcript toggles' key caps, the thinking-cost note (066)
  // and `thinkingDead` (097)~~ — with the toggles, in `Composer.svelte`'s
  // bottom row since backlog 112.
</script>

<header class="topbar" bind:this={barEl} data-fold={foldAttr}>
  <!-- ~~The title and the short id~~ — board d (backlog 175): the tab is
       the title, its hover the id. The mode mark and "continued from"
       stay, at the bar's left, when a chat has one. -->
  {#if modeText || continuedFrom}
    <div class="left">
      {#if modeText}
        <span class="mode {mode}" title={modeTitle}
          ><span aria-hidden="true">{MODE_GLYPH[mode]}</span><span class="fold2"> {modeText}</span></span
        >
      {/if}
      {#if continuedFrom}
        <button
          class="continued"
          title="This chat continues a full one from its HANDOFF.md — click to open the earlier chat"
          onclick={() => void openSession(continuedFrom.id)}
        >
          <span aria-hidden="true">↳</span><span class="fold1"> continued from {continuedFrom.line}</span>
        </button>
      {/if}
    </div>
  {/if}

  <div class="right" bind:this={rightEl}>
    <!-- The kind chip (nightshift backlog 102; blocker 141's final form
         since backlog 112): `Claude Code · subscription`, `Chat ·
         subscription`, `Build · anthropic`, `Chat · anthropic` — the kind
         and the engine, no model. The model's name is the composer's
         button; this chip still opens the rail, where the model is. -->
    <button
      class="ns-chip model"
      class:open={app.showRail}
      bind:this={chipEl}
      title={app.connection
        ? `${kindLabel(chatKind(app.events), app.connection.engine)} · ${engineName} — model and tasks, click to open (⌘M)`
        : "Model and tasks — click to open (⌘M)"}
      aria-expanded={app.showRail}
      onclick={toggleRail}
    >
      <span class="dot" class:unknown={!app.connection}></span>
      {#if app.connection}
        <span class="model-name"
          >{kindLabel(chatKind(app.events), app.connection.engine)}<span class="fold2"> · {engineName}</span></span
        >
      {:else}
        <span class="annotation">not connected</span>
      {/if}
      {#if openTasks > 0}<span class="badge" title="{openTasks} open tasks">{openTasks}</span>{/if}
    </button>

    <!-- The gauge chip (board d, nightshift backlog 175 pass 2): the
         context gauge and the plan chip made one — two thin bars, context
         (amber, warm and hot as before) over the plan's five hours (the
         live blue), and the plan reading's age (his "4m", 2026-09-18).
         ~~Its click opens the Context page~~ — it opens the gauge card with
         every figure; the card's button and ⌘⇧C open the Context page.
         Every figure is also in the chip's hover. Before any usage it reads
         "Context", and with no known window the raw count stands in for
         the bar. -->
    {#if app.connection}
      <button
        class="ns-chip mono gauge {level}"
        class:open={showGauge}
        class:stale={plan?.stale}
        aria-expanded={showGauge}
        bind:this={gaugeEl}
        title={(gauge
          ? gauge.limit
            ? `Context: ${gauge.used.toLocaleString()} of ${gauge.limit.toLocaleString()} tokens (${Math.round((gauge.ratio ?? 0) * 100)}%)${spendTail}${agentsTail}`
            : `Context: ${gauge.used.toLocaleString()} tokens — window size unknown for this model${spendTail}${agentsTail}`
          : "Context: nothing sent yet") +
          (plan ? `\n${planTitle}` : "") +
          " — click for the figures (⌘⇧C itemises the context)"}
        onclick={toggleGauge}
      >
        {#if gauge || plan}
          <span class="bars">
            {#if gauge?.ratio != null}
              <span class="gbar ctx"><span class="fill" style:width="{gauge.ratio * 100}%"></span></span>
            {/if}
            {#if plan}
              <span class="gbar"><span class="fill plan-fill" style:width="{Math.min(plan.five_hour ?? 0, 100)}%"></span></span>
            {/if}
          </span>
          {#if gauge && gauge.ratio == null}<span class="figure">{tokens(gauge.used)}</span>{/if}
          {#if plan}<span class="of plan-age">{planAgeMark}</span>{/if}
        {:else}
          <span class="figure sans">Context</span>
        {/if}
      </button>
    {/if}

    <!-- The agents chip (nightshift backlog 152): the latest turn's
         subagents and their tokens, opening the Running-tasks panel. Shown
         while any runs and kept, quieter, once all are done, so a finished
         agent's transcript stays a click away until the next turn. -->
    {#if agents.rows.length > 0}
      <button
        class="ns-chip mono agents"
        class:live={agents.running > 0}
        class:open={app.showTasks}
        aria-expanded={app.showTasks}
        title="{agents.rows.length} subagent{agents.rows.length === 1 ? '' : 's'} this turn{agents.running > 0 ? `, ${agents.running} running` : ', all done'} · {agents.tokens.toLocaleString()} tokens (the CLI's figure per agent, not in the context gauge) — click for the Running-tasks panel{app.turnBudget ? `\n${budgetTitle(app.turnBudget)}` : ''}"
        onclick={toggleTasks}
      >
        <span class="figure">
          <span>{agents.rows.length} agent{agents.rows.length === 1 ? "" : "s"}</span>
          {#if agents.running === 0}<span class="of fold1">· done</span>{/if}
          <span class="of fold3">· {tokens(agents.tokens)}</span>
          <!-- The message's budget meter (backlog 165, pass 2): spent of
               budget, in window percent, as the hook's ledger moves. -->
          {#if app.turnBudget}<span class="of budget" class:stopped={!!app.turnBudget.stopped}>· {budgetChip(app.turnBudget)}</span>{/if}
        </span>
      </button>
    {/if}

    <!-- ~~The plan chip (backlog 073) and the spend chip~~ — folded into
         the gauge chip and its card (board d, backlog 175 pass 2,
         2026-09-22); every figure they showed is in the card and the
         chip's hover. ~~The two transcript toggles (backlog 052) and the
         cache chip (063)~~ — the composer's bottom row since backlog 112. -->

    <!--
      Compaction and nothing else. The settings gear used to sit beside it and
      moved up into the window's title bar, where it belongs: this bar describes
      the conversation — which model, how full its window is, what it has cost —
      and settings are about the app.
    -->
    {#if canCompact}
      <button
        class="ns-btn ghost small"
        title="Replace earlier turns with a model-written summary"
        onclick={() => void compactSession()}
        disabled={app.busy}
      >
        {app.busy ? "…" : "Compact"}
      </button>
    {/if}
    <!-- New terminal (nightshift backlog 113, agent M's hunk): a shell
         docked under the chat, at the right end of the chips (board 12a). -->
    <!-- ~~<TerminalButton />~~ — the sidebar's foot beside Settings since
         2026-09-18 (his words: "move the terminal button to the bottom row
         … right next to the settings button; that might save some space"). -->
    <!-- The bell (nightshift backlog 069, agent I's hunk): what waits on
         him, five kinds; the Nightshift header carries the same one. -->
    <NotificationCentre />
  </div>

  {#if app.showRail}
    <!-- Portalled to body and placed by the chip's rectangle (backlog 163):
         inside the bar's stacking context it painted under the Welcome
         page's floating composer and off its chip. -->
    <div
      class="popover"
      bind:this={popEl}
      use:portal
      style="top: {popPos.top}px; left: {popPos.left}px"
    >
      <RightRail />
    </div>
  {/if}
  {#if showGauge && app.connection}
    <!-- The gauge card (board d, backlog 175 pass 2): every figure the
         context gauge, the plan chip and the spend chip carried, portalled
         and placed under the gauge chip as the rail's card is (163). -->
    <div
      class="gauge-card"
      role="dialog"
      aria-label="Context and plan"
      bind:this={gaugePopEl}
      use:portal
      style="top: {gaugePos.top}px; left: {gaugePos.left}px; width: {GAUGE_WIDTH}px"
    >
      <div class="gc-head">Context and plan</div>
      <div class="gc-row">
        <span class="gc-label">Context</span>
        <span class="gc-val">
          {#if gauge}
            {#if gauge.ratio != null}
              <span class="gc-bar {level}"><span class="fill" style:width="{gauge.ratio * 100}%"></span></span>
            {/if}
            <span class="gc-fig"
              >{gauge.used.toLocaleString()}{" "}{#if gauge.limit}of {gauge.limit.toLocaleString()} · {Math.round(
                  (gauge.ratio ?? 0) * 100,
                )}%{:else}tokens — window size unknown{/if}</span
            >
            {#if agents.rows.length > 0}
              <span class="gc-note"
                >+ subagents: {agents.tokens.toLocaleString()} tokens ({agents.rows.length}, not in the window)</span
              >
            {/if}
          {:else}
            <span class="gc-fig sans">nothing sent yet</span>
          {/if}
        </span>
      </div>
      {#if plan}
        <div class="gc-row">
          <span class="gc-label">Plan, 5 h</span>
          <span class="gc-val">
            <span class="gc-bar"><span class="fill plan-fill" style:width="{Math.min(plan.five_hour ?? 0, 100)}%"></span></span>
            <span class="gc-fig">{plan.five_hour}% · {resetText(plan.five_hour_resets_at)}</span>
          </span>
        </div>
        {#if plan.seven_day != null}
          <div class="gc-row">
            <span class="gc-label">Plan, week</span>
            <span class="gc-val">
              <span class="gc-bar"><span class="fill plan-fill" style:width="{Math.min(plan.seven_day, 100)}%"></span></span>
              <span class="gc-fig">{plan.seven_day}% · {resetText(plan.seven_day_resets_at)}</span>
            </span>
          </div>
        {/if}
      {/if}
      {#if spend}
        <div class="gc-row">
          <span class="gc-label">Spent</span>
          <span class="gc-val">
            <span
              class="gc-fig"
              class:partial={!spend.complete}
              title={spend.complete
                ? "Session cost so far, summed from each exchange at the price in force when it ran"
                : "At least this much: some exchanges ran on a model with no verified price"}
              >{spend.complete ? "" : "at least "}{spend.text}</span
            >
          </span>
        </div>
      {/if}
      {#if plan}
        <p class="gc-foot" class:stale={plan.stale}>
          Plan {planAgeText.replace(/^sampled /, "read ")} from {planWhere}; account-wide, every surface.{#if plan.stale}
            Stale: past 20 minutes, may be behind.{/if} Refreshed at each turn end.
        </p>
      {/if}
      <div class="gc-actions">
        <button class="ns-btn ghost small" onclick={itemise}>Itemise the context <span class="gc-key">⌘⇧C</span></button>
      </div>
    </div>
  {/if}
  <!-- The Context page is no longer a popover here: it opens as a centre
       modal from `App.svelte` (2026-09-15), on the same overlay as
       Settings. The chip above still toggles `app.showContext`. -->
</header>

<style>
  .topbar {
    position: relative;
    /* ~~The bar is a CSS container (backlog 129)~~ — no longer (backlog
       183, 2026-09-22: under WebKit page zoom a container query reads the
       width × the zoom); it folds by measurement (`fold.ts`, `data-fold`).
       It stays a stacking context lifted a step over `.content` — which
       follows it in the DOM. Under the overlays (20), the find bar (10 is
       inside `.content`, whose own context this does not enter) and the
       toasts. */
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
    padding: 0 20px;
    /* ~~52px~~ — 44 px with the title row gone (board d, backlog 175). */
    min-height: 44px;
    /* Past the three folds the bar wraps to a second line rather than
       clipping its last chip (his screenshot at ⌘+ zoom, 2026-09-18:
       "≥$0.0" cut at the edge — the gauge grew a week bar after 129
       measured the folds). `min-height`, so a one-line bar is unchanged. */
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .left {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  /* ~~`.title` and `.crumb`~~ — gone with the title row (board d,
     backlog 175, 2026-09-22); the tab's hover carries the id. */
  /* The mode mark: the crumb's size, a shade brighter so it reads as a
     state and not as an id. */
  .mode {
    font-size: 11.5px;
    color: var(--text);
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The hand-off's trace (backlog 086): the mode mark's size, a button
     because it opens the earlier chat. */
  .continued {
    font-size: 11.5px;
    color: var(--dim);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: var(--sans);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .continued:hover {
    color: var(--ink);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    /* ~~flex-shrink: 0~~ — with the cluster unshrinkable its width was its
       content's, so `flex-wrap` on it never had a bound to wrap at and the
       last chip still ran off the edge at 175% (his screenshot, 2026-09-18,
       after 20392bd). Bounded to the bar, it shrinks and wraps its chips. */
    flex-shrink: 1;
    min-width: 0;
    max-width: 100%;
    flex-wrap: wrap;
    justify-content: flex-end;
    row-gap: 4px;
    /* With no title on the left, the cluster keeps the right end. */
    margin-left: auto;
  }
  /* The folds, by measurement (backlog 183; ~~three `@container topbar`
     steps at 1000 / 860 / 700 px~~, which WebKit's page zoom fired a step
     late). `refold()` sets `data-fold` to the first level at which the
     bar's items sit on one line. Level 1: the agents chip's "· done" and
     "continued from"'s words. Level 2: the kind chip's engine and the mode
     mark's words. Level 3: the agents chip's token count, and the gauge's
     bars and the kind chip narrow. Every folded word is in a hover. */
  .topbar:is([data-fold="1"], [data-fold="2"], [data-fold="3"]) .fold1 {
    display: none;
  }
  .topbar:is([data-fold="2"], [data-fold="3"]) .fold2 {
    display: none;
  }
  .topbar[data-fold="3"] .fold3 {
    display: none;
  }
  .topbar[data-fold="3"] .gbar {
    width: 36px;
  }
  .topbar[data-fold="3"] .model {
    max-width: 200px;
  }
  .topbar[data-fold="3"] .right {
    gap: 6px;
  }

  .model {
    cursor: pointer;
    font-family: var(--sans);
    max-width: 380px;
  }
  .model.open,
  .model:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .model-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .annotation {
    color: var(--dim);
  }
  .badge {
    background: var(--accent);
    color: var(--paper);
    border-radius: 999px;
    font-size: 10px;
    line-height: 1;
    padding: 2px 5px;
    font-variant-numeric: tabular-nums;
  }

  .gauge {
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
  }
  .gauge {
    cursor: pointer;
  }
  .gauge.open,
  .gauge:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  /* The agents chip (backlog 152): the live blue while a child runs,
     the gauge's grey once all are done. */
  .agents {
    cursor: pointer;
    color: var(--ink2);
  }
  .agents.live {
    color: var(--live);
    border-color: var(--live-soft);
  }
  .agents.open,
  .agents:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .figure.sans {
    font-family: var(--sans);
  }
  .figure {
    display: inline-flex;
    gap: 5px;
  }
  .of {
    color: var(--dim);
  }
  /* The budget meter once the hook has refused (backlog 165 pass 2; the
     class was set with no rule until the review of 44ab834). */
  .of.budget.stopped {
    color: var(--failed);
  }
  /* ~~`.bar`, `.plan`, `.plan .figure`, `.spend`~~ — the old gauge's,
     plan chip's and spend chip's; board d's are `.gbar` and the card's. */
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 120ms linear;
  }
  .gauge.hot {
    color: var(--failed);
  }
  .plan-fill {
    background: var(--live);
  }
  /* The gauge chip (board d): context over plan, two 3 px bars. */
  .gauge .bars {
    display: inline-flex;
    flex-direction: column;
    gap: 3px;
  }
  .gbar {
    display: block;
    width: 48px;
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
    overflow: hidden;
  }
  .gbar .fill,
  .gc-bar .fill {
    display: block;
  }
  .gauge .plan-age {
    font-size: 11px;
  }
  .gauge.stale .plan-age {
    font-style: italic;
  }
  .gauge.warm .gbar.ctx .fill {
    background: var(--partial);
  }
  .gauge.hot .gbar.ctx .fill {
    background: var(--failed);
  }
  /* The gauge card: the rail card's frame, a label column and a value
     column; portalled, so fixed to the viewport. */
  .gauge-card {
    position: fixed;
    z-index: 80;
    box-sizing: border-box;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    font-size: 12.5px;
    color: var(--ink2);
  }
  .gc-head {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .gc-row {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
  }
  .gc-label {
    color: var(--ink);
  }
  .gc-val {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .gc-bar {
    display: block;
    height: 4px;
    margin-top: 6px;
    border-radius: 2px;
    background: var(--line2);
    overflow: hidden;
  }
  .gc-bar.warm .fill {
    background: var(--partial);
  }
  .gc-bar.hot .fill {
    background: var(--failed);
  }
  .gc-fig {
    font-family: var(--mono);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .gc-fig.sans {
    font-family: var(--sans);
    color: var(--dim);
  }
  .gc-fig.partial {
    font-style: italic;
  }
  .gc-note {
    color: var(--dim);
    font-size: 11.5px;
  }
  .gc-foot {
    margin: 0;
    color: var(--dim);
    font-size: 11.5px;
    line-height: 1.4;
  }
  .gc-foot.stale {
    color: var(--partial);
  }
  .gc-actions {
    display: flex;
    justify-content: flex-end;
  }
  .gc-key {
    color: var(--dim);
    margin-left: 4px;
  }
  /* The cache chip's and the toggles' rules went with them to
     `Composer.svelte` (backlog 112). */

  .popover {
    position: fixed;
    /* top and left are set inline from the chip's rectangle (backlog 163). */
    /* 340 × 780 since the 2026-09-13 redesign (was 300 × 560): the Model
       pane became cards, pills and a radio list, which want the width, and
       the height shows the Provider pane's first four sections unscrolled. */
    width: 340px;
    height: min(780px, calc(100vh - var(--titlebar-h) - 80px));
    display: flex;
    flex-direction: column;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    overflow: hidden;
    /* Above the composer's menus (70) and the overlays; under the toasts
       (100). Portalled, so the bar's context no longer caps it. */
    z-index: 80;
  }
  /* The context popover: the same card, its own head, and the panel that
     was the rail's third tab. Shorter than the model popover — a list, not
     four sections. */
  /* The rail draws its own left border and panel background for the column it
     used to be; inside the popover the card is the frame. */
  .popover :global(.rail) {
    border-left: none;
    background: transparent;
    flex: 1;
    min-height: 0;
  }
</style>
