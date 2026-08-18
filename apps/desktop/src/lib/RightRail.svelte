<script lang="ts">
  import ProviderRail from "./ProviderRail.svelte";
  import TaskPanel from "./TaskPanel.svelte";
  import { currentTodos } from "./state.svelte";

  let tab = $state<"connection" | "tasks">("connection");

  const open = $derived(
    currentTodos().filter((t) => t.status !== "completed").length,
  );
</script>

<aside class="rail">
  <div class="tabs" role="tablist">
    <button
      role="tab"
      aria-selected={tab === "connection"}
      class:active={tab === "connection"}
      onclick={() => (tab = "connection")}
    >
      Connection
    </button>
    <button
      role="tab"
      aria-selected={tab === "tasks"}
      class:active={tab === "tasks"}
      onclick={() => (tab = "tasks")}
    >
      Tasks
      {#if open > 0}<span class="badge">{open}</span>{/if}
    </button>
  </div>

  {#if tab === "connection"}
    <ProviderRail />
  {:else}
    <TaskPanel />
  {/if}
</aside>

<style>
  .rail {
    background: var(--panel);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .tabs {
    display: flex;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    flex: 1;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.75rem;
    padding: 0.5rem 0.4rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.active {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .badge {
    background: var(--accent);
    color: var(--bg);
    border-radius: 999px;
    font-size: 0.62rem;
    line-height: 1;
    padding: 0.15rem 0.32rem;
    font-variant-numeric: tabular-nums;
  }
</style>
