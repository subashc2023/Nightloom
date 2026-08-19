<script lang="ts">
  import { app, currentTodos } from "./state.svelte";

  // Projected from the log rather than tracked separately, so the panel and
  // the copy the model sees in its sidecar can never drift apart.
  const todos = $derived(currentTodos());
  const done = $derived(todos.filter((t) => t.status === "completed").length);

  const mark = (status: string) =>
    status === "completed" ? "✓" : status === "in_progress" ? "▸" : "○";
</script>

<div class="panel">
  {#if todos.length === 0}
    <p
      class="empty"
      title="The model writes one with todo_write when the work runs to three or more steps, and it is read back to it every turn."
    >
      No tasks yet.
    </p>
    {#if app.connection && !app.connection.tools}
      <p class="empty warn">Tools are off.</p>
    {/if}
  {:else}
    <div class="head">
      <span class="count">{done}/{todos.length}</span>
      <div class="bar"><div class="fill" style="width: {(done / todos.length) * 100}%"></div></div>
    </div>
    <ol class="list">
      {#each todos as t, i (i)}
        <li class={t.status}>
          <span class="mark">{mark(t.status)}</span>
          <span class="text">{t.content}</span>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.7rem;
    overflow-y: auto;
    min-height: 0;
    flex: 1;
  }
  .empty {
    margin: 0;
    font-size: 0.74rem;
    color: var(--dim);
  }
  .warn {
    color: var(--error);
    opacity: 0.85;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .count {
    font-size: 0.7rem;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .bar {
    flex: 1;
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  li {
    display: flex;
    gap: 0.4rem;
    font-size: 0.76rem;
    line-height: 1.35;
    align-items: baseline;
  }
  .mark {
    flex-shrink: 0;
    width: 0.8rem;
    color: var(--dim);
    font-size: 0.7rem;
  }
  .text {
    word-break: break-word;
  }
  li.in_progress .mark,
  li.in_progress .text {
    color: var(--accent);
  }
  li.completed .text {
    color: var(--dim);
    text-decoration: line-through;
    opacity: 0.7;
  }
</style>
