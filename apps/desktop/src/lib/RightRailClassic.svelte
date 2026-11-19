<script lang="ts">
  import ProviderRail from "./ProviderRail.svelte";
  import { tabPlace } from "./tabPlace"; // Item 715: the view keeps its scroll across close and reopen.
  import TaskPanel from "./TaskPanel.svelte";
  import { currentTodos, type Aside } from "./state.svelte";

  type Tab = "connection" | "tasks";

  // Item 856 (from RightRail's item 657): an aside's settings card, from
  // its top bar's chip — its model and effort its own; no Tasks (the to-do
  // list is the chat's session's).
  let { aside = null, asideChat = null }: { aside?: Aside | null; asideChat?: string | null } = $props();

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
</script>

<aside class="rail" use:tabPlace={`rail:pop:classic:${tab}`}>
  <div class="tabs" role="tablist">
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
