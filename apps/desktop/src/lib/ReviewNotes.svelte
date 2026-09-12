<script lang="ts">
  /**
   * Review → Notes (3.5): a tree over the flat `notes/` listing on the left,
   * the selected file in the middle — rendered as `.ns-prose` for a `.md`,
   * mono `<pre>` otherwise — and on the right the file's path/size/modified,
   * Reveal, and an "On this page" list built straight from the markdown
   * source's `## `/`### ` lines (no id injection into the rendered HTML;
   * `renderMarkdown` is a sanitizing renderer and stays untouched).
   */
  import {
    app,
    openNote,
    paneWidth,
    setPaneWidth,
  } from "./state.svelte";
  import * as api from "./api";
  import { renderMarkdown } from "./markdown";
  import { kib, notesTree, plain, type NoteNode } from "./nightshift";
  import { relativeTime } from "./time";
  import Grip from "./Grip.svelte";
  import Icon from "./Icon.svelte";

  let listWidth = $state(paneWidth("notes.list", 280));
  let asideWidth = $state(paneWidth("notes.aside", 280));

  let search = $state("");

  const baseTree = $derived(notesTree(app.nightshift.notes));
  const filteredEntries = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return app.nightshift.notes;
    return app.nightshift.notes.filter((e) => !e.is_dir && e.path.toLowerCase().includes(q));
  });
  const tree = $derived(search.trim() ? notesTree(filteredEntries) : baseTree);

  /** Which directories are expanded, by path. Reset when the project changes;
   *  seeded with the top-level dirs the first time notes for it arrive. */
  let openDirs = $state<Set<string>>(new Set());
  $effect(() => {
    void app.nightshift.selected;
    openDirs = new Set();
  });
  $effect(() => {
    if (openDirs.size === 0 && baseTree.length > 0) {
      openDirs = new Set(baseTree.filter((n) => n.is_dir).map((n) => n.path));
    }
  });

  function toggle(path: string) {
    const next = new Set(openDirs);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    openDirs = next;
  }

  /** While searching, every directory shows open so matches are visible. */
  function isOpen(node: NoteNode): boolean {
    return search.trim().length > 0 || openDirs.has(node.path);
  }

  interface FlatRow {
    node: NoteNode;
    depth: number;
  }
  function flatten(nodes: NoteNode[], depth: number, out: FlatRow[]): FlatRow[] {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.is_dir && isOpen(n) && n.children.length > 0) flatten(n.children, depth + 1, out);
    }
    return out;
  }
  const rows = $derived(flatten(tree, 0, []));

  const selectedEntry = $derived(
    app.nightshift.notes.find((e) => e.path === app.nightshift.selectedNote) ?? null,
  );
  const isMd = $derived((app.nightshift.selectedNote ?? "").toLowerCase().endsWith(".md"));

  const row = $derived(
    app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null,
  );
  /** Root-relative paths only tell the backend where a file is; Reveal needs
   *  an absolute one, built from the contract root on the selected row. */
  const absolutePath = $derived(
    row?.nightshift && app.nightshift.selectedNote
      ? `${row.nightshift.contract_root}/${app.nightshift.selectedNote}`
      : null,
  );

  /** `## `/`### ` lines of the open markdown file, in source order. Not ids
   *  in the rendered HTML — just a list that scrolls the nth `h2`/`h3` in the
   *  prose container into view, in document order. */
  const headings = $derived.by(() => {
    if (!isMd || !app.nightshift.noteText) return [];
    const out: { level: number; text: string }[] = [];
    for (const line of app.nightshift.noteText.split("\n")) {
      const m = /^(##|###)\s+(.+?)\s*$/.exec(line);
      if (m) out.push({ level: m[1].length, text: plain(m[2]) });
    }
    return out;
  });

  let proseEl = $state<HTMLElement | null>(null);
  function jumpToHeading(i: number) {
    const el = proseEl?.querySelectorAll("h2, h3")[i] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
</script>

<div class="notes" style:grid-template-columns="{listWidth}px 7px minmax(0,1fr) 7px {asideWidth}px">
  <div class="list-col">
    {#if app.nightshift.notes.length === 0}
      <p class="hint">No notes — nothing under notes/.</p>
    {:else}
      <div class="search-wrap">
        <input class="ns-fld search" placeholder="Filter by path…" bind:value={search} />
      </div>
      <div class="scroll">
        {#if rows.length === 0}
          <p class="hint">No matches.</p>
        {:else}
          <div class="ns-list">
            {#each rows as r (r.node.path)}
              <button
                class="ns-row tree-row"
                class:on={!r.node.is_dir && r.node.path === app.nightshift.selectedNote}
                onclick={() => (r.node.is_dir ? toggle(r.node.path) : void openNote(r.node.path))}
              >
                <span class="line" style:padding-left="{r.depth * 14}px">
                  {#if r.node.is_dir}
                    <Icon name={isOpen(r.node) ? "chev" : "chevr"} />
                  {:else}
                    <span class="ico-slot"></span>
                  {/if}
                  <span class="name ns-mono">{r.node.name}</span>
                  {#if !r.node.is_dir}<span class="size">{kib(r.node.size)}</span>{/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
  <Grip width={listWidth} min={220} max={460} edge="left" onchange={(w) => { listWidth = w; setPaneWidth("notes.list", w); }} />

  <div class="main">
    {#if !app.nightshift.selectedNote}
      <p class="hint">Select a file.</p>
    {:else if app.nightshift.noteText === null}
      <p class="hint">Reading…</p>
    {:else if isMd}
      <div class="ns-prose body" bind:this={proseEl}>{@html renderMarkdown(app.nightshift.noteText)}</div>
    {:else}
      <pre class="viewer-body">{app.nightshift.noteText}</pre>
    {/if}
  </div>
  <Grip width={asideWidth} min={220} max={420} edge="right" onchange={(w) => { asideWidth = w; setPaneWidth("notes.aside", w); }} />

  <aside class="aside">
    {#if app.nightshift.selectedNote}
      <div>
        <div class="ns-k mb">File</div>
        <div class="ns-card note-card">
          <span class="ns-mono path">{app.nightshift.selectedNote}</span>
        </div>
      </div>
      <div class="fields">
        <div class="ns-k">Size</div>
        <div class="val">{selectedEntry ? kib(selectedEntry.size) : "—"}</div>
        <div class="ns-k">Modified</div>
        <div class="val">{selectedEntry ? relativeTime(selectedEntry.modified) : "—"}</div>
      </div>
      <button class="ns-btn small" disabled={!absolutePath} onclick={() => absolutePath && void api.reveal(absolutePath)}>
        <Icon name="ext" />Reveal
      </button>
      {#if headings.length > 0}
        <div>
          <div class="ns-k mb">On this page</div>
          <div class="stack">
            {#each headings as h, i (i)}
              <button class="ns-link toc" class:sub={h.level === 3} onclick={() => jumpToHeading(i)}>{h.text}</button>
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <p class="hint nopad">Select a file to see its details.</p>
    {/if}
  </aside>
</div>

<style>
  .notes {
    flex: 1;
    min-height: 0;
    display: grid;
    overflow: hidden;
  }
  .list-col {
    border-right: 1px solid var(--line);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .search-wrap {
    padding: 12px 12px 8px;
    flex: none;
  }
  .search {
    font-size: 12.5px;
    padding: 6px 9px;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
    padding-bottom: 12px;
  }
  /* Beats app.css's `.ns-list .ns-row` padding: the line carries its own. */
  .ns-list .tree-row {
    padding: 0;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    width: 100%;
  }
  .ico-slot {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
  }
  .size {
    font-size: 11px;
    color: var(--dim);
    flex: none;
  }
  .hint {
    margin: 0;
    font-size: 13px;
    color: var(--dim);
    padding: 12px 20px;
  }
  .hint.nopad {
    padding: 0;
  }

  .main {
    overflow-y: auto;
    padding: 26px 36px;
    min-height: 0;
  }
  .body {
    max-width: 680px;
  }
  .viewer-body {
    margin: 0;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--ink2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .aside {
    border-left: 1px solid var(--line);
    background: var(--sheet);
    padding: 26px 22px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    font-size: 13px;
    overflow-y: auto;
    min-height: 0;
  }
  .mb {
    margin-bottom: 6px;
  }
  .note-card {
    padding: 10px 12px;
    background: var(--paper);
  }
  .path {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .fields {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    align-items: baseline;
  }
  .val {
    font-size: 13px;
    color: var(--ink2);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
  }
  .toc {
    font-size: 12.5px;
    text-align: left;
  }
  .toc.sub {
    padding-left: 14px;
    color: var(--dim);
  }
</style>
