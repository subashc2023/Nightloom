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
  import RightRail from "./RightRail.svelte";
  import NotificationCentre from "./NotificationCentre.svelte";
  import TerminalButton from "./TerminalButton.svelte";
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
   */

  const session = $derived(app.sessions.find((s) => s.id === app.activeSessionId) ?? null);
  const title = $derived(session ? (session.title ?? session.first_user ?? "new chat") : "");
  const crumb = $derived(app.activeSessionId ? app.activeSessionId.slice(0, 8) : "");

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
  const planTitle = $derived.by(() => {
    if (!plan) return "";
    const age =
      plan.age_seconds == null
        ? "age unknown"
        : plan.age_seconds < 90
          ? "sampled just now"
          : `sampled ${Math.round(plan.age_seconds / 60)} min ago`;
    const where =
      plan.source === "turn"
        ? "this chat's last turn (the CLI's rate-limit event)"
        : plan.source === "desktop"
          ? "the Claude app's sample"
          : "the CLI's /usage cache";
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
  function onDocClick(e: MouseEvent): void {
    const t = e.target as Node;
    if (popEl?.contains(t) || chipEl?.contains(t)) return;
    app.showRail = false;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      app.showRail = false;
      app.showContext = false;
    }
  }
  $effect(() => {
    if (!app.showRail && !app.showContext) return;
    document.addEventListener("mousedown", onDocClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  });
  function toggleRail() {
    app.showContext = false;
    app.showRail = !app.showRail;
  }
  function toggleContext() {
    app.showRail = false;
    app.showContext = !app.showContext;
  }
  // ~~The two transcript toggles' key caps, the thinking-cost note (066)
  // and `thinkingDead` (097)~~ — with the toggles, in `Composer.svelte`'s
  // bottom row since backlog 112.
</script>

<header class="topbar">
  <div class="left">
    {#if title}
      <span class="title" {title}>{title}</span>
    {/if}
    {#if crumb}
      <span class="crumb ns-mono fold3" title={app.activeSessionId ?? ""}>{crumb}</span>
    {/if}
    {#if modeText}
      <span class="mode {mode}" title={modeTitle}
        ><span aria-hidden="true">{MODE_GLYPH[mode]}</span> {modeText}</span
      >
    {/if}
    {#if continuedFrom}
      <button
        class="continued"
        title="This chat continues a full one from its HANDOFF.md — click to open the earlier chat"
        onclick={() => void openSession(continuedFrom.id)}
      >
        <span aria-hidden="true">↳</span> continued from {continuedFrom.line}
      </button>
    {/if}
  </div>

  <div class="right">
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
          >{kindLabel(chatKind(app.events), app.connection.engine)}<span class="fold3"> · {engineName}</span></span
        >
      {:else}
        <span class="annotation">not connected</span>
      {/if}
      {#if openTasks > 0}<span class="badge" title="{openTasks} open tasks">{openTasks}</span>{/if}
    </button>

    <!-- The context gauge is the Context button (review round 1,
         2026-09-13): it opens the itemised request in its own popover, where
         the rail's third tab used to be. Before any usage it reads "Context". -->
    {#if app.connection}
      <button
        class="ns-chip mono gauge {level}"
        class:open={app.showContext}
        aria-expanded={app.showContext}
        title={gauge
          ? gauge.limit
            ? `${gauge.used.toLocaleString()} of ${gauge.limit.toLocaleString()} context tokens (${Math.round((gauge.ratio ?? 0) * 100)}%)${spendTail}${agentsTail} — click to itemise (⌘⇧C)`
            : `${gauge.used.toLocaleString()} context tokens — window size unknown for this model${spendTail}${agentsTail} — click to itemise (⌘⇧C)`
          : "What the next request carries — click to open (⌘⇧C)"}
        onclick={toggleContext}
      >
        {#if gauge}
          {#if gauge.ratio != null}
            <div class="bar"><div class="fill" style:width="{gauge.ratio * 100}%"></div></div>
          {/if}
          <!-- The fold classes (backlog 129): `fold1` goes first as the
               bar narrows, `fold3` last; the count itself folds only when
               a bar is left to stand for it. -->
          <span class="figure">
            <span class:fold3={gauge.ratio != null}>{tokens(gauge.used)}</span>{#if gauge.limit}<span class="of fold1">of {tokens(gauge.limit)}</span><span class="pct fold2">· {Math.round((gauge.ratio ?? 0) * 100)}%</span>{:else}<span class="of fold1">tokens</span>{/if}
          </span>
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
        title="{agents.rows.length} subagent{agents.rows.length === 1 ? '' : 's'} this turn{agents.running > 0 ? `, ${agents.running} running` : ', all done'} · {agents.tokens.toLocaleString()} tokens (the CLI's figure per agent, not in the context gauge) — click for the Running-tasks panel"
        onclick={toggleTasks}
      >
        <span class="figure">
          <span>{agents.rows.length} agent{agents.rows.length === 1 ? "" : "s"}</span>
          {#if agents.running === 0}<span class="of fold1">· done</span>{/if}
          <span class="of">· {tokens(agents.tokens)}</span>
        </span>
      </button>
    {/if}

    <!-- The plan chip (nightshift backlog 073): 5h and 7d beside the
         gauge, bars in the live blue so it never reads as the context
         gauge. Basic rendering tonight; the Fable board has the shape. -->
    {#if plan}
      <div class="ns-chip mono plan" class:stale={plan.stale} title={planTitle}>
        <span class="figure">
          <span class="of fold1">plan</span>
          <span class="pct fold3">5h</span>
          <div class="bar"><div class="fill plan-fill" style:width="{Math.min(plan.five_hour ?? 0, 100)}%"></div></div>
          <span class="fold3">{plan.five_hour}%</span>
          {#if plan.seven_day != null}
            <span class="pct fold2">· wk</span>
            <div class="bar fold2"><div class="fill plan-fill" style:width="{Math.min(plan.seven_day, 100)}%"></div></div>
            <span class="fold2">{plan.seven_day}%</span>
          {/if}
          {#if plan.stale}<span class="of fold1">· stale</span>{/if}
        </span>
      </div>
    {/if}

    <!-- ~~The two transcript toggles (backlog 052) and the cache chip
         (063)~~ — the composer's bottom row since backlog 112
         (2026-09-16), with their titles, keys and the 097 disabled rule. -->

    {#if spend}
      <div
        class="ns-chip mono spend fold2"
        class:partial={!spend.complete}
        title={spend.complete
          ? "Session cost so far, summed from each exchange at the price in force when it ran"
          : "At least this much: some exchanges ran on a model with no verified price"}
      >
        {spend.complete ? "" : "≥"}{spend.text}
      </div>
    {/if}

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
    <TerminalButton />
    <!-- The bell (nightshift backlog 069, agent I's hunk): what waits on
         him, five kinds; the Nightshift header carries the same one. -->
    <NotificationCentre />
  </div>

  {#if app.showRail}
    <div class="popover" bind:this={popEl}>
      <RightRail />
    </div>
  {/if}
  <!-- The Context page is no longer a popover here: it opens as a centre
       modal from `App.svelte` (2026-09-15), on the same overlay as
       Settings. The chip above still toggles `app.showContext`. -->
</header>

<style>
  .topbar {
    position: relative;
    /* The bar is a CSS container (backlog 129): the fold rules below
       fire on its own width, whatever the zoom. Containment makes it a
       stacking context, so it is lifted a step over `.content` — which
       follows it in the DOM — or the rail popover would paint under the
       transcript. Under the overlays (20), the find bar (10 is inside
       `.content`, whose own context this does not enter) and the toasts. */
    container-type: inline-size;
    container-name: topbar;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
    padding: 0 20px;
    min-height: 52px;
  }
  .left {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .title {
    font-family: var(--serif);
    font-size: 18px;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumb {
    font-size: 11.5px;
    color: var(--dim);
    /* The id and the mode keep their width; the title is what ellipsizes
       (backlog 129) — before, both shrank in proportion and at 200% the
       title went to nothing while the id stayed. */
    flex-shrink: 0;
  }
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
    flex-shrink: 0;
  }
  /* The three folds (backlog 129), by the bar's own width. Step 1: the
     gauges' words. Step 2: the spend chip, the gauge's percentage, the
     plan chip's week. Step 3: the counts — bars alone — and the chip's
     engine; the bars narrow a little so a 200% bar in a 1440px window
     keeps room for the title. Every folded figure is in a hover. */
  @container topbar (max-width: 1000px) {
    .fold1 {
      display: none;
    }
  }
  @container topbar (max-width: 860px) {
    .fold2 {
      display: none;
    }
  }
  @container topbar (max-width: 700px) {
    .fold3 {
      display: none;
    }
    .bar {
      width: 44px;
    }
    .model {
      max-width: 200px;
    }
    .right {
      gap: 6px;
    }
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

  .gauge,
  .spend {
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
  .of,
  .pct {
    color: var(--dim);
  }
  .bar {
    width: 56px;
    height: 4px;
    border-radius: 2px;
    background: var(--line2);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 120ms linear;
  }
  .gauge.warm .fill {
    background: var(--partial);
  }
  .gauge.hot {
    color: var(--failed);
  }
  .gauge.hot .fill {
    background: var(--failed);
  }
  .plan {
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
  }
  .plan .figure {
    align-items: center;
  }
  .plan-fill {
    background: var(--live);
  }
  .plan.stale {
    color: var(--dim);
  }
  /* The cache chip's and the toggles' rules went with them to
     `Composer.svelte` (backlog 112). */
  .spend.partial {
    font-style: italic;
  }

  .popover {
    position: absolute;
    top: calc(100% - 1px);
    right: 20px;
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
    z-index: 30;
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
