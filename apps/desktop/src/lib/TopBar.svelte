<script lang="ts">
  import { app, compactSession } from "./state.svelte";

  // Compaction needs at least one completed exchange to summarize.
  const canCompact = $derived(
    app.connection != null &&
      app.events.some((e) => e.event === "assistant_message"),
  );

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
