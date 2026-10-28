<script lang="ts">
  // A file-editing call as a diff under its row (nightshift backlog 433):
  // the file, the removed and added lines, folded past EDIT_DIFF_FOLD with
  // a *Show all*. Drawn from the call's input (`editDiff.ts`).
  import { tip } from "./tip";
  import { foldDiff, shortPath, type EditDiff } from "./editDiff";

  let { diff, denied = false }: { diff: EditDiff; denied?: boolean } = $props();

  let all = $state(false);
  const view = $derived(foldDiff(diff.lines, all));
  const where = $derived(shortPath(diff.path));
</script>

<div class="edit-diff" class:denied>
  <div class="ed-head">
    <span class="ed-verb">{diff.verb}</span>
    <span class="ed-path" use:tip={diff.path}
      ><span class="ed-dir">{where.dir}</span><span class="ed-name">{where.name}</span></span
    >
    <span class="ed-counts">
      {#if diff.added}<span class="ed-add">+{diff.added}</span>{/if}
      {#if diff.removed}<span class="ed-del">−{diff.removed}</span>{/if}
    </span>
    {#if diff.whole}<span class="ed-note">whole file</span>{/if}
    {#if diff.everyMatch}<span class="ed-note">every match</span>{/if}
    {#if denied}<span class="ed-note">not applied</span>{/if}
  </div>
  {#if diff.lines.length === 0}
    <div class="ed-empty">No change.</div>
  {:else}
    <div class="ed-body" role="table" aria-label={`Changes to ${diff.path}`}>
      {#each view.shown as line, k (k)}
        {#if line.sep}
          <div class="ed-line sep" aria-hidden="true">⋯</div>
        {:else}
          <div class="ed-line {line.kind}" role="row">
            <span class="ed-mark" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span
            ><span class="ed-text">{line.text}</span>
          </div>
        {/if}
      {/each}
    </div>
    {#if view.hidden > 0}
      <button class="ed-more" onclick={() => (all = true)}>
        Show all {diff.lines.length} lines ({view.hidden} more)
      </button>
    {:else if all}
      <button class="ed-more" onclick={() => (all = false)}>Show fewer</button>
    {/if}
  {/if}
</div>

<style>
  .edit-diff {
    margin: 0 12px 8px 40px;
    border: 1px solid var(--line2, var(--border));
    border-radius: 8px;
    background: var(--well, var(--bg));
    overflow: hidden;
    min-width: 0;
  }
  .edit-diff.denied {
    opacity: 0.6;
  }
  .ed-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--line, var(--border));
    font-size: 0.75rem;
    color: var(--dim);
    min-width: 0;
  }
  .ed-verb {
    color: var(--ink2, var(--ink));
    font-weight: 600;
    flex: none;
  }
  .ed-path {
    font-family: var(--mono);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ed-dir {
    color: var(--dim);
  }
  .ed-name {
    color: var(--ink);
  }
  .ed-counts {
    font-family: var(--mono);
    display: flex;
    gap: 6px;
    flex: none;
  }
  .ed-add {
    color: var(--done);
  }
  .ed-del {
    color: var(--failed);
  }
  .ed-note {
    flex: none;
    font-size: 0.7rem;
    color: var(--dim);
    border: 1px solid var(--line, var(--border));
    border-radius: 4px;
    padding: 0 5px;
  }
  .ed-body {
    font-family: var(--mono);
    font-size: 0.75rem;
    line-height: 1.45;
    overflow-x: auto;
    max-height: 32rem;
    overflow-y: auto;
  }
  .ed-line {
    display: flex;
    white-space: pre;
    min-width: max-content;
    width: 100%;
    color: var(--ink2, var(--ink));
  }
  .ed-line.add {
    background: var(--add-bg);
    color: var(--add-fg);
  }
  .ed-line.del {
    background: var(--del-bg);
    color: var(--del-fg);
  }
  .ed-line.sep {
    color: var(--dim);
    justify-content: center;
    border-top: 1px dashed var(--line, var(--border));
    border-bottom: 1px dashed var(--line, var(--border));
  }
  .ed-mark {
    flex: none;
    width: 1.6em;
    text-align: center;
    user-select: none;
    opacity: 0.8;
  }
  .ed-text {
    padding-right: 12px;
  }
  .ed-empty {
    padding: 6px 10px;
    font-size: 0.75rem;
    color: var(--dim);
  }
  .ed-more {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 10px;
    font-size: 0.75rem;
    color: var(--accent);
    background: transparent;
    border: 0;
    border-top: 1px solid var(--line, var(--border));
    cursor: pointer;
  }
  .ed-more:hover {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
</style>
