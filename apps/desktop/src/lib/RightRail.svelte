<script lang="ts">
  import ProviderRail from "./ProviderRail.svelte";
  import TaskPanel from "./TaskPanel.svelte";
  import ContextPanel from "./ContextPanel.svelte";
  import { currentTodos } from "./state.svelte";

  type Tab = "connection" | "tasks" | "context";

  let tab = $state<Tab>("connection");

  const open = $derived(
    currentTodos().filter((t) => t.status !== "completed").length,
  );

  const TABS: { id: Tab; label: string }[] = [
    { id: "connection", label: "Model" },
    { id: "tasks", label: "Tasks" },
    { id: "context", label: "Context" },
  ];
</script>

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
  {:else if tab === "tasks"}
    <TaskPanel />
  {:else}
    <ContextPanel />
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
</style>
