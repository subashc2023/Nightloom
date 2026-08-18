<script lang="ts">
  import {
    app,
    cacheHitRate,
    compactSession,
    contextUsed,
    liveFlags,
    sessionCost,
  } from "./state.svelte";

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

  function tokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  // Compaction needs at least one completed exchange to summarize — one the
  // projection still carries, since that is what the backend summarizes.
  const canCompact = $derived.by(() => {
    if (!app.connection) return false;
    const live = liveFlags(app.events);
    return app.events.some((e, i) => live[i] && e.event === "assistant_message");
  });

  const annotation = $derived.by(() => {
    if (!app.connection) return "";
    const parts: string[] = [];
    if (app.connection.thinking !== "default") {
      parts.push(app.connection.thinking);
    }
    if (app.connection.tools) parts.push("tools");
    return parts.join(" · ");
  });
</script>

<header class="topbar">
  <div class="status">
    {#if app.connection}
      <span>{app.connection.provider} : {app.connection.model}</span>
      {#if annotation}
        <span class="annotation">{annotation}</span>
      {/if}
    {:else}
      <span class="annotation">not connected</span>
    {/if}
  </div>
  {#if gauge}
    <div
      class="gauge {level}"
      title={gauge.limit
        ? `${gauge.used.toLocaleString()} of ${gauge.limit.toLocaleString()} context tokens`
        : `${gauge.used.toLocaleString()} context tokens — window size unknown for this model`}
    >
      {#if gauge.ratio != null}
        <div class="bar"><div class="fill" style:width="{gauge.ratio * 100}%"></div></div>
      {/if}
      <span class="figure">
        {tokens(gauge.used)}{#if gauge.limit}<span class="of"> / {tokens(gauge.limit)}</span
          ><span class="pct"> · {Math.round((gauge.ratio ?? 0) * 100)}%</span>{:else}
          <span class="of"> tokens</span>
        {/if}
      </span>
    </div>
  {/if}

  {#if spend}
    <div
      class="spend"
      class:partial={!spend.complete}
      title={spend.complete
        ? "Session cost so far, summed from each exchange at the price in force when it ran"
        : "At least this much: some exchanges ran on a model with no verified price"}
    >
      {spend.complete ? "" : "≥"}{spend.text}{#if cached != null}<span class="cache"
          title="Share of the last request's prompt served from cache">
          · {Math.round(cached * 100)}% cached</span
        >{/if}
    </div>
  {/if}

  <div class="actions">
    {#if canCompact}
      <button
        class="compact"
        title="Replace earlier turns with a model-written summary"
        onclick={() => void compactSession()}
        disabled={app.busy}
      >
        {app.busy ? "…" : "Compact"}
      </button>
    {/if}
    <button
      class="gear"
      title="Settings"
      aria-label="Settings"
      onclick={() => (app.showSettings = !app.showSettings)}
    >
      ⚙
    </button>
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0.75rem;
    min-height: 2.4rem;
  }
  .spend {
    font-size: 0.72rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    margin-left: 0.6rem;
  }
  .spend.partial {
    font-style: italic;
  }
  .cache {
    opacity: 0.75;
  }
  .status {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-size: 0.85rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .annotation {
    color: var(--dim);
    font-size: 0.78rem;
  }
  .gauge {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.72rem;
    color: var(--dim);
    flex-shrink: 0;
    margin-left: auto;
    padding-right: 0.6rem;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    width: 64px;
    height: 4px;
    border-radius: 2px;
    background: var(--border);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 120ms linear;
  }
  .gauge.warm .fill {
    background: #e0b341;
  }
  .gauge.hot {
    color: var(--error);
  }
  .gauge.hot .fill {
    background: var(--error);
  }
  .of,
  .pct {
    color: var(--dim);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  .compact {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--dim);
    font-size: 0.75rem;
    padding: 0.25rem 0.55rem;
    border-radius: 6px;
    cursor: pointer;
  }
  .compact:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .compact:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .gear {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 1rem;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    border-radius: 6px;
    line-height: 1;
  }
  .gear:hover {
    color: var(--text);
    background: #1b1830;
  }
</style>
