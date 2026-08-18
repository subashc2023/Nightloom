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
    <p class="empty">
      No task list yet. The model writes one with <code>todo_write</code> when
      the work runs to three or more steps, and it is read back to it every
      turn.
      {#if app.connection && !app.connection.tools}
        <br /><span class="warn">Tools are off for this connection.</span>
      {/if}
    </p>
  {:else}
    <div class="count">{done}/{todos.length} done</div>
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
    padding: 0.75rem;
    overflow-y: auto;
    min-height: 0;
    flex: 1;
  }
  .empty {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--dim);
  }
  .empty code {
    font-size: 0.72rem;
  }
  .warn {
    color: var(--error);
  }
  .count {
    font-size: 0.72rem;
    color: var(--dim);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  li {
    display: flex;
    gap: 0.45rem;
    font-size: 0.78rem;
    line-height: 1.35;
    align-items: baseline;
  }
  .mark {
    flex-shrink: 0;
    width: 0.9rem;
    color: var(--dim);
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
  }
</style>
