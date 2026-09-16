<script lang="ts">
  import {
    addToast,
    app,
    cacheHitRate,
    chatMode,
    compactSession,
    contextUsed,
    currentTodos,
    liveFlags,
    MODE_GLYPH,
    sessionCost,
  } from "./state.svelte";
  import { cacheLine, cacheState, nextTickMs, remainingText } from "./cache";
  import RightRail from "./RightRail.svelte";
  import { toggleTranscriptPref, transcript } from "./transcriptPrefs.svelte";
  import { isMac } from "./platform";

  /**
   * The chat top bar in the redesign (item 036, the mock-up's Chat artboard):
   * the session's name and short id on the left; on the right the model chip,
   * the context chip, the cache chip, the cost chip and Compact. The model
   * chip opens a popover that *is* the old right rail (Model · Tasks ·
   * Context), so nothing the rail did is lost — it just no longer takes a
   * 240px column on every screen.
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

  const cached = $derived(cacheHitRate());

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
   * The clock is a chain of timeouts aligned to when the text would change
   * — once a minute, once a second under two minutes — rather than a
   * one-second interval, so it wakes as rarely as the display allows and
   * still never shows a value a second stale. The toast fires on the tick
   * that crosses to cold, and only if this chain saw the cache warm: a
   * chat reopened already cold is a state, not a crossing, and the chain
   * is torn down and rebuilt whenever the open chat's log changes, so a
   * background chat has no chain and cannot toast.
   */
  let now = $state(Date.now());
  const cache = $derived(cacheState(app.events, now));
  $effect(() => {
    const warmUntil = cacheState(app.events, Date.now())?.warmUntil ?? null;
    if (warmUntil == null) return;
    now = Date.now();
    let id: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const t = Date.now();
      now = t;
      const wait = nextTickMs(warmUntil - t);
      if (wait == null) {
        addToast("Prompt cache cold — edits to the history now cost nothing extra");
        return;
      }
      id = setTimeout(tick, wait);
    };
    const first = nextTickMs(warmUntil - Date.now());
    if (first != null) id = setTimeout(tick, first);
    return () => {
      if (id != null) clearTimeout(id);
    };
  });
  const cacheShareTitle = "Share of the last request's prompt served from cache.";
  const cacheTitle = $derived.by(() => {
    if (!cache) return "";
    const engine = app.connection?.engine === "claude-code" ? "claude-code" : "api";
    if (!cache.warm) {
      return "The last turn's prompt cache has expired, so the next turn re-reads the whole history either way and editing it now costs nothing extra.";
    }
    const what = `Time left on the last turn's prompt cache (${cache.ttl}), counted from when its request was sent: until it expires an edit to the history re-writes the cache, and after it the next turn pays for the whole history whether or not you edited it.`;
    return engine === "claude-code"
      ? `${what} On this engine you are on the subscription, so "free" means an edit costs no more usage than an unedited turn would — whether cache reads are discounted against the plan's limit is not documented.`
      : what;
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

  const annotation = $derived.by(() => {
    if (!app.connection) return "";
    const parts: string[] = [];
    if (app.connection.engine === "claude-code") parts.push("subscription");
    parts.push(`thinking ${app.connection.thinking}`);
    if (app.connection.tools) parts.push("tools");
    return parts.join(" · ");
  });

  const openTasks = $derived(currentTodos().filter((t) => t.status !== "completed").length);

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

  // The two transcript toggles' key caps, for their tooltips.
  const shiftKey = isMac ? "⌘⇧" : "Ctrl+Shift+";
</script>

<header class="topbar">
  <div class="left">
    {#if title}
      <span class="title" {title}>{title}</span>
    {/if}
    {#if crumb}
      <span class="crumb ns-mono">{crumb}</span>
    {/if}
    {#if modeText}
      <span class="mode {mode}" title={modeTitle}
        ><span aria-hidden="true">{MODE_GLYPH[mode]}</span> {modeText}</span
      >
    {/if}
  </div>

  <div class="right">
    <button
      class="ns-chip model"
      class:open={app.showRail}
      bind:this={chipEl}
      title="Model and tasks — click to open (⌘M)"
      aria-expanded={app.showRail}
      onclick={toggleRail}
    >
      <span class="dot" class:unknown={!app.connection}></span>
      {#if app.connection}
        <span class="model-name">{app.connection.provider} · {app.connection.model}</span>
        {#if annotation}<span class="annotation">· {annotation}</span>{/if}
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
            ? `${gauge.used.toLocaleString()} of ${gauge.limit.toLocaleString()} context tokens — click to itemise (⌘⇧C)`
            : `${gauge.used.toLocaleString()} context tokens — window size unknown for this model — click to itemise (⌘⇧C)`
          : "What the next request carries — click to open (⌘⇧C)"}
        onclick={toggleContext}
      >
        {#if gauge}
          {#if gauge.ratio != null}
            <div class="bar"><div class="fill" style:width="{gauge.ratio * 100}%"></div></div>
          {/if}
          <span class="figure">
            {tokens(gauge.used)}{#if gauge.limit}<span class="of">of {tokens(gauge.limit)}</span><span class="pct">· {Math.round((gauge.ratio ?? 0) * 100)}%</span>{:else}<span class="of">tokens</span>{/if}
          </span>
        {:else}
          <span class="figure sans">Context</span>
        {/if}
      </button>
    {/if}

    <!-- The two transcript toggles (nightshift backlog 052, 2026-09-14),
         beside Context because they are about the conversation as shown:
         every thinking block open or every one a closed pill, every tool
         call the full block or one line each. A click on any single block
         still overrides its toggle; flipping the toggle clears those
         clicks. Remembered across relaunch; thinking off and tools on is
         how the transcript read before them. -->
    <button
      class="ns-chip toggle"
      class:on={transcript.thinking}
      aria-pressed={transcript.thinking}
      title={transcript.thinking
        ? `Thinking shown in every reply — click to fold it to a pill (${shiftKey}T)`
        : `Thinking folded to a pill — click to show it in every reply (${shiftKey}T)`}
      onclick={() => toggleTranscriptPref("thinking")}
    >
      <span class="mark" aria-hidden="true">✦</span>thinking
    </button>
    <button
      class="ns-chip toggle"
      class:on={transcript.tools}
      aria-pressed={transcript.tools}
      title={transcript.tools
        ? `Tool calls shown in full — click to fold each to one line (${shiftKey}B)`
        : `Tool calls folded to one line each — click to show them in full (${shiftKey}B)`}
      onclick={() => toggleTranscriptPref("tool")}
    >
      <span class="mark" aria-hidden="true">⚒</span>tools
    </button>

    <!-- One chip for the cache (his ask, 2026-09-16): the share of the
         last request served from it, then the timer from backlog 063 —
         how long it stays warm, or `cold`. A chat whose last turn predates
         the timer's fields shows the share alone, and the title says why.
         Nothing before the first turn. -->
    {#if cached != null || cache}
      <div
        class="ns-chip mono cache"
        class:cold={cache ? !cache.warm : false}
        title={cache
          ? `${cacheShareTitle} ${cacheTitle}`
          : `${cacheShareTitle} No timer for this chat: its last turn was made before the cache lifetime was recorded (2026-09-15); the next turn will show one.`}
      >
        {#if cached != null}{Math.round(cached * 100)}% cached{:else}cache{/if}{#if cache}
          <span class="cache-when" aria-label={cacheLine(cache)}>· {remainingText(cache.remainingMs) ?? "cold"}</span>
        {/if}
      </div>
    {/if}

    {#if spend}
      <div
        class="ns-chip mono spend"
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
  }
  /* The mode mark: the crumb's size, a shade brighter so it reads as a
     state and not as an id. */
  .mode {
    font-size: 11.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
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
  .cache,
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
  /* Only the timer half dims when cold; the share is still a fact. */
  .cache.cold .cache-when {
    color: var(--dim);
  }
  /* The transcript toggles: off is the dimmed chip with its mark struck
     through the colour, on is the accent mark. */
  .toggle {
    cursor: pointer;
    font-family: var(--sans);
    color: var(--dim);
    gap: 5px;
  }
  .toggle .mark {
    font-size: 11px;
    opacity: 0.55;
  }
  .toggle.on {
    color: var(--ink);
  }
  .toggle.on .mark {
    color: var(--accent);
    opacity: 1;
  }
  .toggle:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
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
