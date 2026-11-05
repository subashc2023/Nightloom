<script lang="ts">
  // Sort inbox (nightshift backlog 488): an optional instruction, then a
  // throwaway Haiku turn proposes a move per inbox entry; he unticks or
  // edits a destination and Apply moves the ticked ones. The state lives in
  // `inboxSort.svelte.ts`, so closing the sheet loses nothing.
  import {
    applyPlan,
    closeInboxSort,
    inboxSort,
    reloadInbox,
    resetSort,
    runSort,
    stopSort,
  } from "./inboxSort.svelte";
  import { tip } from "./tip";
  import { appliedWords, checkDest, keptAt, leafOf, movesOf } from "./inboxSort";

  let sureReset = $state(false);
  const running = $derived(inboxSort.phase === "running");
  const applying = $derived(inboxSort.phase === "applying");
  const items = $derived(inboxSort.digest?.items ?? []);
  const ticked = $derived(movesOf(inboxSort.rows, inboxSort.folders).length);
  const where = $derived(inboxSort.scope === "knowledge" ? "Knowledge" : "Project");

  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (running) void stopSort();
      else closeInboxSort();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !running && !applying) {
      e.preventDefault();
      if (inboxSort.phase === "plan" && ticked) void applyPlan();
      else if (items.length) void runSort();
    }
  }

  function startOver() {
    if (!sureReset) {
      sureReset = true;
      return;
    }
    sureReset = false;
    resetSort();
    void reloadInbox();
  }

  function focusIn(el: HTMLElement) {
    el.focus();
  }
</script>

{#if inboxSort.open}
  <div class="sort-scrim" aria-hidden="true"></div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="sort" role="dialog" aria-modal="true" aria-label="Sort inbox" tabindex="-1" onkeydown={keys}>
    <header>
      <h2>Sort inbox <span class="scope">· {where}</span></h2>
      <button class="x" aria-label="Close (the plan is kept)" use:tip={"Close — the plan is kept"} onclick={closeInboxSort}>×</button>
    </header>

    {#if inboxSort.phase === "idle" || running}
      <p class="lead">
        {#if items.length}
          {items.length} {items.length === 1 ? "entry" : "entries"} in Inbox/{#if inboxSort.digest?.left_out}, and {inboxSort.digest.left_out} more for a later sort{/if}.
          A separate, throwaway Haiku chat reads their names and first lines and proposes where each goes. Nothing moves until you Apply; your chat is not touched.
        {:else}
          Inbox/ is empty. Drop files or folders on the Inbox folder in the Notes panel, then sort.
        {/if}
      </p>
      <label class="ask">
        <span>Instructions (optional)</span>
        <textarea
          rows="2"
          placeholder="e.g. course files go under courses/, one folder per course"
          bind:value={inboxSort.instruction}
          disabled={running}
          use:focusIn
        ></textarea>
      </label>
      <div class="actions">
        {#if running}
          <span class="busy">Haiku is reading the inbox…</span>
          <button onclick={() => void stopSort()}>Stop</button>
        {:else}
          <button class="primary" disabled={!items.length} onclick={() => void runSort()}>Propose a plan</button>
          <button onclick={closeInboxSort}>Close</button>
        {/if}
      </div>
    {:else}
      {#if inboxSort.rows.length}
        <p class="lead">{#if inboxSort.savedAt && keptAt(inboxSort.savedAt)}Plan from {keptAt(inboxSort.savedAt)}, kept until you apply it or start over.{" "}{/if}Untick what should stay, or edit a destination. A name already taken is kept as “name (2)”; nothing is deleted.</p>
        <datalist id="inbox-sort-folders">
          <option value="">top of the notes</option>
          {#each inboxSort.folders as f (f)}<option value={f}></option>{/each}
        </datalist>
        <ul class="plan">
          {#each inboxSort.rows as row (row.item)}
            {@const c = checkDest(row.to, inboxSort.folders)}
            {@const stays = !row.tick}
            <li class:stays>
              <input type="checkbox" bind:checked={row.tick} disabled={applying} aria-label={"Move " + leafOf(row.item)} />
              <div class="what">
                <div class="line">
                  <span class="leaf" use:tip={row.item}>{leafOf(row.item)}{row.folder ? "/" : ""}</span>
                  <span class="arrow">→</span>
                  {#if row.tick}
                    <input
                      class="dest"
                      class:bad={!c.ok}
                      list="inbox-sort-folders"
                      bind:value={row.to}
                      disabled={applying}
                      aria-label={"Destination for " + leafOf(row.item)}
                      placeholder="top of the notes"
                    />
                    {#if c.ok && c.isNew}<span class="new">new folder</span>{/if}
                  {:else}
                    <span class="stay">stays in Inbox/</span>
                  {/if}
                </div>
                <div class="why">{row.tick && !c.ok ? c.why : row.reason}</div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
      {#if inboxSort.results.length}
        <p class="done">{appliedWords(inboxSort.results)}</p>
        <ul class="results">
          {#each inboxSort.results.filter((r) => r.error || r.renamed) as r (r.item)}
            <li>{leafOf(r.item)}: {r.error ?? "kept as " + (r.landed ?? "")}</li>
          {/each}
        </ul>
      {/if}
      <div class="actions">
        {#if inboxSort.phase === "plan"}
          <button class="primary" disabled={!ticked || applying} onclick={() => void applyPlan()}>
            {applying ? "Moving…" : `Apply — move ${ticked}`}
          </button>
        {/if}
        <button disabled={applying} onclick={() => void runSort()} use:tip={"Ask again with the instructions below"}>Propose again</button>
        <button class:sure={sureReset} disabled={applying} onclick={startOver} onblur={() => (sureReset = false)}>
          {sureReset ? "Start over — forget this plan" : "Start over"}
        </button>
        <button disabled={applying} onclick={closeInboxSort}>Close</button>
      </div>
      <label class="ask small">
        <span>Instructions</span>
        <textarea rows="1" bind:value={inboxSort.instruction} disabled={applying}></textarea>
      </label>
      {#if inboxSort.cost}<p class="cost" use:tip={"The Claude Code CLI's estimate at API prices; a subscription is not billed per token"}>{inboxSort.cost}</p>{/if}
    {/if}
    {#if inboxSort.notice}<p class="notice">{inboxSort.notice}</p>{/if}
    {#if inboxSort.error}<p class="err" role="alert">{inboxSort.error}</p>{/if}
  </div>
{/if}

<style>
  .sort-scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.25);
  }
  .sort {
    position: fixed;
    z-index: 41;
    left: 50%;
    top: 12%;
    transform: translateX(-50%);
    width: min(620px, calc(100vw - 32px));
    max-height: 76vh;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px 12px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
    color: var(--text);
    font-size: 13px;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .scope {
    color: var(--muted, var(--ink2, var(--text)));
    font-weight: 400;
  }
  .x {
    font: inherit;
    font-size: 18px;
    line-height: 1;
    background: transparent;
    border: 0;
    color: var(--text);
    cursor: pointer;
    padding: 2px 6px;
  }
  .lead,
  .done,
  .cost,
  .err {
    margin: 0;
    line-height: 1.4;
  }
  .cost {
    font-size: 11.5px;
    color: var(--muted, var(--ink2, var(--text)));
  }
  .notice {
    margin: 0;
    font-size: 12px;
    color: var(--accent);
  }
  .err {
    color: var(--error);
    overflow-wrap: anywhere;
  }
  .ask {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ask span {
    font-size: 12px;
    color: var(--muted, var(--ink2, var(--text)));
  }
  textarea,
  .dest {
    font: inherit;
    font-size: 12.5px;
    color: var(--text);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 6px 8px;
    resize: vertical;
  }
  .plan,
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    min-height: 0;
  }
  .plan {
    flex: 1;
    border-top: 1px solid var(--line2);
  }
  .plan li {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 7px 2px;
    border-bottom: 1px solid var(--line2);
  }
  .plan li.stays .leaf {
    opacity: 0.6;
  }
  .plan input[type="checkbox"] {
    margin-top: 5px;
    accent-color: var(--accent);
  }
  .what {
    flex: 1;
    min-width: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .leaf {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .arrow {
    color: var(--muted, var(--ink2, var(--text)));
  }
  .dest {
    flex: 1;
    min-width: 140px;
    padding: 3px 6px;
  }
  .dest.bad {
    border-color: var(--error);
  }
  .new {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    color: var(--accent);
  }
  .stay {
    color: var(--muted, var(--ink2, var(--text)));
  }
  .why {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--muted, var(--ink2, var(--text)));
    overflow-wrap: anywhere;
  }
  .results li {
    font-size: 12px;
    padding: 2px 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .actions button {
    font: inherit;
    font-size: 12.5px;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--text);
    cursor: pointer;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .actions .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--paper);
  }
  .actions .sure {
    border-color: var(--error);
    color: var(--error);
  }
  .busy {
    color: var(--muted, var(--ink2, var(--text)));
  }
  .ask.small textarea {
    resize: none;
  }
</style>
