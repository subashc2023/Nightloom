<script lang="ts">
  /**
   * A side-by-side diff: old on the left, new on the right, line numbers,
   * red and green line fills, hatched padding where a side has no line. A
   * file strip above it with each file's +/−; the view scrolls inside its
   * own box and never fits-to-page. The text is whatever `git` printed;
   * `diff.ts` pairs it.
   */
  import { diffTotals, parseDiff } from "./diff";
  import Icon from "./Icon.svelte";

  let {
    text,
    leftLabel = "",
    rightLabel = "",
    loading = false,
    error = null,
  }: {
    text: string;
    leftLabel?: string;
    rightLabel?: string;
    loading?: boolean;
    error?: string | null;
  } = $props();

  const files = $derived(parseDiff(text));
  const totals = $derived(diffTotals(files));
  let selected = $state(0);
  // A new diff starts at its first file.
  $effect(() => {
    void text;
    selected = 0;
  });
  const file = $derived(files[selected] ?? null);
</script>

<div class="diffview">
  <div class="head">
    <span class="ns-chip"><Icon name="cols" />side by side</span>
    <span class="spacer"></span>
    {#if files.length > 0}
      <span class="ns-mono totals">
        <span class="plus">+{totals.added}</span>
        <span class="minus">−{totals.removed}</span>
        · {totals.files} file{totals.files === 1 ? "" : "s"}
      </span>
    {/if}
  </div>

  {#if loading}
    <p class="empty">Reading the diff…</p>
  {:else if error}
    <p class="empty err">{error}</p>
  {:else if files.length === 0}
    <p class="empty">{text.trim() ? "Nothing git could show as a diff." : "No changes."}</p>
  {:else}
    <div class="filestrip">
      {#each files as f, i (f.path + i)}
        <button class="file" class:on={i === selected} onclick={() => (selected = i)}>
          {f.path}
          <span class="pm">
            {#if f.binary}binary{:else}
              <span class="plus">+{f.added}</span>
              {#if f.removed > 0}<span class="minus">−{f.removed}</span>{/if}
            {/if}
          </span>
        </button>
      {/each}
    </div>
    {#if file}
      <div class="cols">
        <span>{file.oldPath ?? "(new file)"}{leftLabel ? ` · ${leftLabel}` : ""}</span>
        <span></span>
        <span class="r">{file.newPath ?? "(deleted)"}{rightLabel ? ` · ${rightLabel}` : ""}</span>
      </div>
      <div class="scroll">
        {#if file.binary}
          <p class="empty">Binary file; nothing to show line by line.</p>
        {:else}
          {#each file.hunks as h, hi (hi)}
            <div class="row hunk">
              <div class="cell hunk"><span class="no"></span><span class="txt">{h.header}</span></div>
              <div class="vsep"></div>
              <div class="cell hunk"><span class="no"></span><span class="txt">{h.header}</span></div>
            </div>
            {#each h.rows as r, ri (ri)}
              <div class="row">
                <div class="cell {r.left.kind}">
                  <span class="no">{r.left.no ?? ""}</span><span class="txt">{r.left.text}</span>
                </div>
                <div class="vsep"></div>
                <div class="cell {r.right.kind}">
                  <span class="no">{r.right.no ?? ""}</span><span class="txt">{r.right.text}</span>
                </div>
              </div>
            {/each}
          {/each}
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .diffview {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }
  .head {
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
  }
  .head .ns-chip {
    font-size: 11px;
  }
  .spacer {
    flex: 1;
  }
  .totals {
    font-size: 11px;
    color: var(--dim);
  }
  .plus {
    color: var(--done);
  }
  .minus {
    color: var(--failed);
  }
  .empty {
    margin: 0;
    padding: 18px 14px;
    font-size: 13px;
    color: var(--dim);
  }
  .empty.err {
    color: var(--failed);
    font-family: var(--mono);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .filestrip {
    display: flex;
    gap: 4px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
    flex: none;
  }
  .file {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 6px;
    border: none;
    background: transparent;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink2);
    white-space: nowrap;
    cursor: pointer;
  }
  .file:hover {
    background: var(--well);
  }
  .file.on {
    background: var(--well);
    color: var(--ink);
  }
  .pm {
    display: inline-flex;
    gap: 4px;
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr);
    font-size: 11px;
    color: var(--dim);
    padding: 4px 12px;
    border-bottom: 1px solid var(--line);
    font-family: var(--mono);
    flex: none;
  }
  .cols .r {
    padding-left: 12px;
  }
  .cols span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scroll {
    overflow: auto;
    min-height: 0;
    flex: 1;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.6;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr);
  }
  .vsep {
    background: var(--line2);
  }
  .cell {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    min-width: 0;
  }
  .cell .no {
    color: var(--dim);
    text-align: right;
    padding-right: 10px;
    user-select: none;
    opacity: 0.8;
  }
  .cell .txt {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding-right: 12px;
  }
  .cell.add {
    background: var(--add-bg);
    color: var(--add-fg);
  }
  .cell.del {
    background: var(--del-bg);
    color: var(--del-fg);
  }
  .cell.pad {
    background: repeating-linear-gradient(
      45deg,
      transparent 0 4px,
      var(--well) 4px 5px
    );
  }
  .cell.hunk {
    color: var(--live);
    background: var(--well);
  }
</style>
