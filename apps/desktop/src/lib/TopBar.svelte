<script lang="ts">
  import { app } from "./state.svelte";

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
  <button
    class="gear"
    title="Settings"
    aria-label="Settings"
    onclick={() => (app.showSettings = !app.showSettings)}
  >
    ⚙
  </button>
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
