<script lang="ts">
  import {
    app,
    closeNightshift,
    enableNightshift,
    selectNightshiftProject,
  } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import type { NightshiftInfo, NightshiftRow } from "./types";

  /** Projects Nightshift detection accepted — the left list's top section. */
  const enabledRows = $derived(
    app.nightshift.rows.filter(
      (r): r is NightshiftRow & { nightshift: NightshiftInfo } =>
        r.nightshift !== null,
    ),
  );
  /** Everything else — candidates for **Enable Nightshift**. */
  const otherRows = $derived(
    app.nightshift.rows.filter((r) => r.nightshift === null),
  );
  const selectedRow = $derived(
    app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null,
  );

  /** The two conditions worth a dim warning under a row, joined into one line. */
  function rowHints(info: NightshiftInfo): string {
    const h: string[] = [];
    if (!info.git) h.push("no git repo");
    if (!info.runner_present) h.push(`no runner at ${info.runner}`);
    return h.join(" · ");
  }

  /**
   * The Enable form: which row it is open on and the runner path typed into
   * it. Prefilled with the one install a registered project shows (the
   * nightshift repo, when it is a project here); an empty path enables with
   * no `runner` key. Item 038 / blocker 024: one install, named by path.
   */
  let enabling = $state<string | null>(null);
  let runnerPath = $state("");

  function openEnable(id: string): void {
    enabling = id;
    runnerPath = app.nightshift.defaultRunner ?? "";
  }

  async function confirmEnable(): Promise<void> {
    const id = enabling;
    if (!id) return;
    enabling = null;
    await enableNightshift(id, runnerPath.trim() || undefined);
  }
</script>

<div class="nightshift">
  <header class="ns-header">
    <h2>Nightshift</h2>
    <div class="tabs" role="tablist">
      <button
        role="tab"
        aria-selected={app.nightshift.tab === "start"}
        class:active={app.nightshift.tab === "start"}
        onclick={() => (app.nightshift.tab = "start")}
      >
        Start
      </button>
      <button
        role="tab"
        aria-selected={app.nightshift.tab === "review"}
        class:active={app.nightshift.tab === "review"}
        onclick={() => (app.nightshift.tab = "review")}
      >
        Review
      </button>
    </div>
    <button class="link back" onclick={() => closeNightshift()}>
      Back to chat
    </button>
  </header>

  <div class="body">
    <aside class="list">
      {#if app.nightshift.rows.length === 0}
        <p class="hint">No projects yet — open a folder as a project first.</p>
      {:else}
        <div class="section-head">Projects</div>
        {#if enabledRows.length === 0}
          <p class="hint">No project has Nightshift enabled yet.</p>
        {:else}
          <ul class="rows">
            {#each enabledRows as row (row.id)}
              <li>
                <button
                  class="row"
                  class:active={row.id === app.nightshift.selected}
                  onclick={() => void selectNightshiftProject(row.id)}
                >
                  <span class="row-top">
                    <span class="row-name">{row.name}</span>
                    <span class="badge kind">{row.nightshift.config.kind}</span>
                    {#if row.nightshift.live}
                      <span
                        class="badge live"
                        title="A shift is running; editing is locked"
                        >live</span
                      >
                    {/if}
                  </span>
                  <span class="row-meta">
                    {row.nightshift.items} items · {row.nightshift.open_blockers}
                    open blockers · {row.nightshift.newest_morning ??
                      "no page yet"}
                  </span>
                  {#if row.nightshift.config_error}
                    <span class="row-error">{row.nightshift.config_error}</span>
                  {/if}
                  {#if rowHints(row.nightshift)}
                    <span class="row-hint">{rowHints(row.nightshift)}</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        {#if otherRows.length > 0}
          <div class="section-head">Other projects</div>
          <ul class="rows">
            {#each otherRows as row (row.id)}
              <li class="other-row" class:enabling={enabling === row.id}>
                <span class="other-top">
                  <span class="row-name">
                    {row.name}
                    {#if !row.exists}<span class="missing">folder missing</span
                      >{/if}
                  </span>
                  {#if enabling !== row.id}
                    <button
                      class="enable"
                      disabled={!row.exists || row.workspace === null}
                      title={!row.exists
                        ? "folder missing"
                        : row.workspace === null
                          ? "This project has no folder"
                          : undefined}
                      onclick={() => openEnable(row.id)}
                    >
                      Enable Nightshift
                    </button>
                  {/if}
                </span>
                {#if enabling === row.id}
                  <form
                    class="enable-form"
                    onsubmit={(e) => {
                      e.preventDefault();
                      void confirmEnable();
                    }}
                  >
                    <label class="enable-label" for="ns-runner-{row.id}">
                      Runner — the folder holding bin/nightshift.sh
                    </label>
                    <input
                      id="ns-runner-{row.id}"
                      class="enable-input"
                      type="text"
                      bind:value={runnerPath}
                      placeholder="leave empty to set it later in nightshift.json"
                      spellcheck="false"
                    />
                    <span class="enable-actions">
                      <button class="enable" type="submit">Enable</button>
                      <button
                        class="link"
                        type="button"
                        onclick={() => (enabling = null)}>Cancel</button
                      >
                    </span>
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </aside>

    <main class="pane">
      {#if app.nightshift.tab === "review"}
        {#if !selectedRow}
          <p class="hint">Select a project.</p>
        {:else if !app.nightshift.morning}
          <p class="hint">No morning page yet for {selectedRow.name}.</p>
        {:else}
          <div class="morning-head">
            Morning page · {app.nightshift.morning.name}
          </div>
          <div class="morning-body markdown">
            {@html renderMarkdown(app.nightshift.morning.text)}
          </div>
        {/if}
      {:else}
        <p class="hint">Backlog, plan and launch come in the next phase.</p>
        {#if selectedRow?.nightshift}
          <p class="hint dim">
            {selectedRow.nightshift.items} items in the backlog · latest shift
            {selectedRow.nightshift.latest_shift ?? "none"}
          </p>
        {/if}
      {/if}
    </main>
  </div>
</div>

<style>
  .nightshift {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    color: var(--text);
  }
  .ns-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .ns-header h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .tabs {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .tabs button {
    background: transparent;
    border: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.78rem;
    padding: 0.3rem 0.8rem;
    cursor: pointer;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.active {
    color: var(--text);
    background: var(--panel);
  }
  .back {
    margin-left: auto;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.78rem;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }

  .body {
    display: grid;
    grid-template-columns: 260px 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .list {
    border-right: 1px solid var(--border);
    background: var(--panel);
    padding: 0.6rem 0.5rem;
    overflow-y: auto;
    min-height: 0;
  }
  .section-head {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--dim);
    padding: 0.4rem 0.4rem 0.3rem;
  }
  .rows {
    list-style: none;
    margin: 0 0 0.4rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 0.4rem 0.5rem;
    cursor: pointer;
    color: var(--text);
    text-align: left;
    font-family: inherit;
  }
  .row:hover {
    background: #1b1830;
  }
  .row.active {
    background: #211d38;
    border-color: var(--accent);
  }
  .row-top {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
  }
  .row-name {
    font-size: 0.82rem;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    font-size: 0.62rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--dim);
    flex-shrink: 0;
  }
  .badge.live {
    color: var(--error);
    border-color: var(--error);
  }
  .row-meta {
    font-size: 0.68rem;
    color: var(--dim);
  }
  .row-error {
    font-size: 0.68rem;
    color: var(--error);
  }
  .row-hint {
    font-size: 0.66rem;
    color: var(--dim);
    opacity: 0.75;
  }
  .missing {
    color: var(--error);
    font-size: 0.66rem;
    margin-left: 0.35rem;
  }
  .other-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.35rem 0.4rem;
  }
  .other-row.enabling {
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .other-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .other-row .row-name {
    font-size: 0.8rem;
  }
  .enable-form {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .enable-label {
    font-size: 0.66rem;
    color: var(--dim);
  }
  .enable-input {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.7rem;
    padding: 0.3rem 0.4rem;
  }
  .enable-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .enable-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .enable {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.68rem;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .enable:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .enable:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .pane {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .hint {
    margin: 0;
    font-size: 0.8rem;
    color: var(--dim);
    line-height: 1.5;
  }
  .hint.dim {
    font-size: 0.72rem;
    opacity: 0.85;
  }
  .morning-head {
    font-size: 0.72rem;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }
  .morning-body {
    overflow-y: auto;
    min-height: 0;
  }
</style>
