<script lang="ts">
  /**
   * Item 871: the recovered drafts — kept note drafts whose note is gone
   * (deleted outside Nightloom, or while it was quit). Open puts the text
   * in the editor at the note's old name; Save there writes it back as a
   * new note under that name, and 870's check refuses to write over a file
   * that has appeared there since. Discard drops a draft, after a confirm.
   * Nothing here writes a file.
   */
  import { app, showNote } from "./state.svelte";
  import { recoveredDrafts, preview, type Recovered } from "./recoveredDrafts";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  const list = $derived(
    recoveredDrafts(app.noteDrafts, {
      projectId: app.project?.id ?? null,
      notes: app.notes,
      vault: app.vault,
      listed: app.notesListed,
      complete: app.notesComplete,
    }),
  );
  let discarding = $state<Recovered | null>(null);

  function open(d: Recovered) {
    app.showRecoveredDrafts = false;
    showNote(d.scope, d.name);
  }

  function discard(d: Recovered) {
    delete app.noteDrafts[d.key];
    delete app.noteDraftBases[d.key];
    discarding = null;
  }
</script>

<div class="recovered" role="dialog" aria-label="Recovered drafts">
  <div class="head">
    <h2>Recovered drafts</h2>
    <button class="ghost" onclick={() => (app.showRecoveredDrafts = false)}>Close</button>
  </div>
  {#if list.length === 0}
    <p class="none">None. Every kept draft's note is still there; those notes are marked unsaved.</p>
  {:else}
    <p class="lead">Unsaved edits whose note is gone. Open one to read it; Save there puts it back as a note under its old name.</p>
    <ul>
      {#each list as d (d.key)}
        <li>
          <div class="what">
            <span class="name">{d.name}</span>
            <span class="where">{d.scope === "knowledge" ? "Knowledge" : (app.project?.name ?? "Project")}</span>
            <span class="pre">{preview(d.text)}</span>
          </div>
          <button class="ghost" onclick={() => open(d)}>Open</button>
          <button class="ghost revert" onclick={() => (discarding = d)}>Discard</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if discarding}
  {@const d = discarding}
  <ConfirmDialog
    title="Discard this recovered draft?"
    lead="Its note is gone and this is the only copy of these edits. Discarding cannot be undone."
    facts={[["note", d.name], ["starts", preview(d.text)]]}
    confirmLabel="Discard"
    onconfirm={() => discard(d)}
    onclose={() => (discarding = null)}
  />
{/if}

<style>
  .recovered {
    width: min(560px, 92vw);
    max-height: 70vh;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.9rem 1rem;
    color: var(--text);
    box-sizing: border-box;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 0.95rem;
  }
  .lead,
  .none {
    color: var(--dim);
    font-size: 0.8rem;
    margin: 0.5rem 0 0.7rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0;
    border-top: 1px solid var(--border);
  }
  .what {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .name {
    font-size: 0.84rem;
  }
  .where,
  .pre {
    font-size: 0.74rem;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ghost {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .ghost:hover {
    color: var(--text);
    border-color: var(--dim);
  }
  .ghost.revert {
    color: var(--failed);
  }
  /* Jarvis: the sheet, its lines and radius, as the note's own boxes. */
  :global(:where(:root:not([data-layout="classic"]))) .recovered {
    background: var(--sheet);
    border-color: var(--line);
    border-radius: var(--r1);
  }
  :global(:where(:root:not([data-layout="classic"]))) li {
    border-top-color: var(--line);
  }
  :global(:where(:root:not([data-layout="classic"]))) .ghost {
    min-height: 28px;
    border-radius: var(--r1);
    font-size: 12.5px;
    background: var(--well);
    border-color: var(--line2);
  }
</style>
