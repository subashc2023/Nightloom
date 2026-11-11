<script lang="ts">
  import { tip } from "./tip";
  import { app, currentTodos, openChatSubagents } from "./state.svelte";
  import { allRunning } from "./running.svelte";
  import { openTasksOn } from "./tasksFocus.svelte";
  import { helperRows } from "./railTasks";

  // Projected from the log rather than tracked separately, so the panel and
  // the copy the model sees in its sidecar can never drift apart.
  const todos = $derived(currentTodos());
  const done = $derived(todos.filter((t) => t.status === "completed").length);

  const mark = (status: string) =>
    status === "completed" ? "✓" : status === "in_progress" ? "▸" : "○";

  interface Props {
    /** Item 533: the right column's foot — a ruled title with "2 of 5" and
     *  the list as drawn (f4x-chat.png): done ticked green, the step under
     *  way in the signal blue, the rest dim. */
    column?: boolean;
  }
  let { column = false }: Props = $props();

  /**
   * Item 600: this chat's helpers beside its to-do list — every subagent,
   * council seat and aside still running, then the latest send's finished
   * ones (railTasks.ts). Re-read each second while any runs, as the Running
   * tasks panel does.
   */
  let now = $state(Date.now());
  const subs = $derived(column ? openChatSubagents() : []);
  const runs = $derived(column ? allRunning(now) : []);
  const helpers = $derived(helperRows(subs, runs, app.activeSessionId));
  $effect(() => {
    if (!column || helpers.running === 0) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const STATE_WORD = { running: "running", done: "done", failed: "failed" } as const;
</script>

{#if column}
  <div class="tcol">
    <h4>
      Tasks
      {#if todos.length > 0}<span>{done} of {todos.length}</span>{:else if helpers.running > 0}<span class="sig">{helpers.running} running</span>{/if}
    </h4>
    {#if todos.length === 0 && helpers.rows.length === 0}
      <!-- Item 600: what the section is for, in one line, when it has nothing to show. -->
      <p
        class="tnone"
        use:tip={"Claude writes a to-do list when the work runs to three or more steps; subagents, council seats and asides show here while they run, and the last send's after."}
      >
        {app.connection && !app.connection.tools
          ? "Tools are off: no to-do list or helpers"
          : "Nothing running. Claude's to-do list and its helpers show here."}
      </p>
    {/if}
    {#if todos.length > 0}
      <ol class="tlist">
        {#each todos as t, i (i)}
          <li class={t.status}><i aria-hidden="true">{mark(t.status)}</i><span>{t.content}</span></li>
        {/each}
      </ol>
    {/if}
    {#if helpers.rows.length > 0}
      {#if todos.length > 0}<div class="tsub">Helpers</div>{/if}
      <ul class="thelp" aria-label="This chat's helpers">
        {#each helpers.rows as h (h.id)}
          <li class={h.state}>
            <button
              type="button"
              disabled={!h.focus}
              use:tip={h.focus ? `${h.label} · ${h.kind} · ${STATE_WORD[h.state]} — open it in Running tasks` : `${h.label} · ${h.kind} · running`}
              onclick={() => h.focus && openTasksOn(h.focus)}
            >
              <i aria-hidden="true"></i><span class="hl">{h.label}</span><span class="hk">{h.state === "running" ? h.kind : STATE_WORD[h.state]}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if helpers.more > 0}
        <button type="button" class="tmore" onclick={() => openTasksOn(null)}>+{helpers.more} more in Running tasks</button>
      {/if}
    {/if}
  </div>
{:else}

<div class="panel">
  {#if todos.length === 0}
    <p
      class="empty"
      use:tip={"The model writes one with todo_write when the work runs to three or more steps, and it is read back to it every turn."}
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
{/if}

<style>
  /* ---- the right column's Tasks (item 533) */
  .tcol h4 {
    margin: 0 0 8px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  :global([data-light="calm"]) .tcol h4 {
    font: 600 12px var(--sans);
    letter-spacing: 0;
    text-transform: none;
  }
  .tcol h4 span {
    font: 11px var(--mono);
    letter-spacing: 0;
    text-transform: none;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .tnone {
    margin: 0;
    font-size: 12px;
    color: var(--dim);
  }
  .tlist {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .tlist li {
    display: flex;
    gap: 8px;
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--ink2);
    padding: 2px 0;
    align-items: baseline;
  }
  .tlist li i {
    font-style: normal;
    flex: none;
    width: 10px;
    color: var(--dim);
  }
  .tlist li.completed i {
    color: var(--done);
  }
  .tlist li.in_progress {
    color: var(--ink);
  }
  .tlist li.in_progress i {
    color: var(--signal);
  }
  .tlist li span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* ---- item 600: this chat's helpers, under the to-do list */
  .tcol h4 span.sig {
    color: var(--signal);
  }
  .tsub {
    margin: 10px 0 4px;
    font: 500 10px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .thelp {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .thelp button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 3px 0;
    background: none;
    border: 0;
    font: inherit;
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--ink2);
    text-align: left;
    cursor: pointer;
  }
  .thelp button:disabled {
    cursor: default;
  }
  .thelp button:not(:disabled):hover .hl {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .thelp i {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--dim);
  }
  .thelp li.running i {
    background: var(--signal);
  }
  .thelp li.done i {
    background: var(--done);
  }
  .thelp li.failed i {
    background: var(--error);
  }
  .thelp .hl {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thelp .hk {
    flex: none;
    font: 10.5px var(--mono);
    color: var(--dim);
  }
  .thelp li.running .hk {
    color: var(--signal);
  }
  .tmore {
    margin-top: 4px;
    padding: 0;
    background: none;
    border: 0;
    font: 11px var(--mono);
    color: var(--dim);
    cursor: pointer;
  }
  .tmore:hover {
    color: var(--ink);
  }
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
