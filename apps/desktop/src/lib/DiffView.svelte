<script lang="ts">
  /**
   * A side-by-side diff: old on the left, new on the right, line numbers,
   * red and green line fills, hatched padding where a side has no line. A
   * file strip above it with each file's +/−; the view scrolls inside its
   * own box and never fits-to-page. The text is whatever `git` printed;
   * `diff.ts` pairs it.
   */
  import { diffTotals, parseDiff } from "./diff";

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
  {#if loading}
    <p class="empty">Reading the diff…</p>
  {:else if error}
    <p class="empty err">{error}</p>
  {:else if files.length === 0}
    <p class="empty">{text.trim() ? "Nothing git could show as a diff." : "No changes."}</p>
  {:else}
    <!-- The files as tabs: an underline strip, the open file lit, the
         totals pinned at the right end. (Was a row of plain text that read
         as prose — 2026-09-11 review.) -->
    <div class="filestrip" role="tablist" aria-label="Changed files">
      <div class="files">
        {#each files as f, i (f.path + i)}
          <button role="tab" aria-selected={i === selected} class="file" class:on={i === selected} onclick={() => (selected = i)} title={f.path}>
            <span class="name">{f.path}</span>
            <span class="pm">
              {#if f.binary}binary{:else}
                <span class="plus">+{f.added}</span>
                {#if f.removed > 0}<span class="minus">−{f.removed}</span>{/if}
              {/if}
            </span>
          </button>
        {/each}
      </div>
      <span class="ns-mono totals">
        <span class="plus">+{totals.added}</span>
        <span class="minus">−{totals.removed}</span>
        · {totals.files} file{totals.files === 1 ? "" : "s"}
      </span>
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
  .totals {
    font-size: 11px;
    color: var(--dim);
    flex: none;
    padding: 0 12px 0 16px;
    white-space: nowrap;
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
    align-items: stretch;
    border-bottom: 1px solid var(--line2);
    background: var(--well);
    flex: none;
  }
  .files {
    display: flex;
    gap: 0;
    overflow-x: auto;
    flex: 1;
    min-width: 0;
    scrollbar-width: thin;
  }
  .file {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 8px 12px;
    border: none;
    border-right: 1px solid var(--line);
    border-bottom: 2px solid transparent;
    background: transparent;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    cursor: pointer;
    max-width: 320px;
  }
  .file .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file:hover {
    color: var(--ink2);
    background: color-mix(in srgb, var(--sheet) 60%, transparent);
  }
  .file.on {
    background: var(--sheet);
    color: var(--ink);
    border-bottom-color: var(--accent);
    cursor: default;
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
