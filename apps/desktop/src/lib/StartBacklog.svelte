<script lang="ts">
  /**
   * Start → Backlog (3.6): the ordered backlog on the left (drag to
   * reorder, locked while a shift is live), the selected item's full text
   * on the right — frontmatter facts, preface, each `## ` section, and the
   * Progress lines the runner appended.
   */
  import { app, paneWidth, reorderItems, selectItem, setPaneWidth } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import { itemStatusPill } from "./nightshift";
  import BacklogList from "./BacklogList.svelte";
  import Grip from "./Grip.svelte";

  let listWidth = $state(paneWidth("start.list", 340));
  let filterText = $state("");

  const itemList = $derived(app.nightshift.items);
  const items = $derived(itemList?.items ?? []);
  const order = $derived(itemList?.order ?? []);
  const errors = $derived(itemList?.errors ?? []);
  const row = $derived(app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null);
  const locked = $derived(row?.nightshift?.live ?? false);
  const selected = $derived(items.find((i) => i.id === app.nightshift.selectedItem) ?? null);
</script>

<div class="backlog" style:grid-template-columns="{listWidth}px 7px minmax(0,1fr)">
  <div class="list-col">
    {#if locked}
      <div class="lock">
        <span class="ns-pill live"><span class="dot"></span>locked while a shift runs</span>
      </div>
    {/if}
    <div class="filter-row">
      <input class="ns-fld" placeholder="filter…" bind:value={filterText} aria-label="Filter the backlog" />
    </div>
    <div class="scroll">
      <BacklogList
        {items}
        {order}
        selectedId={app.nightshift.selectedItem}
        onSelect={selectItem}
        {locked}
        onReorder={(o) => void reorderItems(o)}
        {filterText}
      />
      {#each errors as e (e)}
        <p class="hint err">{e}</p>
      {/each}
    </div>
  </div>
  <Grip width={listWidth} min={240} max={520} edge="left" onchange={(w) => { listWidth = w; setPaneWidth("start.list", w); }} />

  <div class="main">
    {#if !selected}
      <p class="hint">Select an item.</p>
    {:else}
      <div class="head">
        <span class="ns-mono">{selected.id}</span>
        <span class="ns-pill {itemStatusPill(selected.status)}">{selected.status || "todo"}</span>
        <span class="ns-chip">{selected.kind}</span>
      </div>
      <div class="ns-prose title"><h1>{selected.title}</h1></div>
      <div class="facts">
        <div class="fact"><span class="ns-k">Kind</span><span>{selected.kind}</span></div>
        <div class="fact"><span class="ns-k">Status</span><span>{selected.status || "—"}</span></div>
        <div class="fact"><span class="ns-k">Created</span><span class="ns-mono">{selected.created || "—"}</span></div>
        <div class="fact"><span class="ns-k">Source</span><span class="ns-mono">{selected.source || "—"}</span></div>
        <div class="fact"><span class="ns-k">Max passes</span><span class="ns-mono">{selected.max_passes}</span></div>
        <div class="fact"><span class="ns-k">Model</span><span class="ns-mono">{selected.model ?? "project default"}</span></div>
      </div>
      {#if selected.preface}
        <div class="ns-prose">{@html renderMarkdown(selected.preface)}</div>
      {/if}
      {#each selected.sections as sec (sec.title)}
        <div class="section">
          <div class="ns-k mb">{sec.title}</div>
          <div class="ns-prose">{@html renderMarkdown(sec.text)}</div>
        </div>
      {/each}
      {#if selected.progress.length > 0}
        <div class="section">
          <div class="ns-k mb">Progress</div>
          <ul class="progress ns-mono">
            {#each selected.progress as p, i (i)}<li>{p}</li>{/each}
          </ul>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .backlog {
    flex: 1;
    min-height: 0;
    display: grid;
    overflow: hidden;
  }
  .list-col {
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .lock {
    padding: 10px 14px 0;
  }
  .filter-row {
    padding: 12px 14px 8px;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
  }
  .hint {
    margin: 0;
    padding: 12px 20px;
    font-size: 13px;
    color: var(--dim);
  }
  .hint.err {
    color: var(--failed);
    font-family: var(--mono);
    font-size: 12px;
  }

  .main {
    overflow-y: auto;
    padding: 26px 36px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .title {
    margin: 0;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px 20px;
    padding: 14px 16px;
    background: var(--sheet);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 13px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mb {
    margin-bottom: 6px;
  }
  .section {
    display: flex;
    flex-direction: column;
  }
  .progress {
    margin: 0;
    padding-left: 1.2em;
    font-size: 12.5px;
    color: var(--ink2);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
</style>
