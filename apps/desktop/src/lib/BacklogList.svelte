<script lang="ts">
  /**
   * The backlog list shared by Start → Backlog (3.6, plain) and Start →
   * Plan a shift (3.7, `selectable`): order number, id, title, status pill,
   * kind chip, and — while the backlog is not locked by a live shift — a
   * drag handle plus up/down buttons that reorder it.
   *
   * Reordering by mouse is native HTML5 drag-and-drop on the row (no
   * library); the up/down buttons are the keyboard/no-pointer equivalent,
   * since drag-and-drop has none of its own. Both end up calling the same
   * `onReorder` with the full id list in its new order — `reorderItems`
   * writes that straight to `order.json`.
   */
  import type { Item } from "./types";
  import { itemStatusPill, orderedBacklog } from "./nightshift";

  let {
    items,
    order,
    selectedId = null,
    onSelect,
    locked = false,
    onReorder,
    selectable = false,
    selectedIds = new Set<string>(),
    onToggle,
    filterText = "",
  }: {
    items: Item[];
    order: string[];
    selectedId?: string | null;
    onSelect?: (id: string) => void;
    locked?: boolean;
    onReorder: (order: string[]) => void;
    selectable?: boolean;
    selectedIds?: Set<string>;
    onToggle?: (id: string) => void;
    filterText?: string;
  } = $props();

  const rows = $derived(orderedBacklog(items, order));
  const filtering = $derived(filterText.trim().length > 0);
  const visible = $derived.by(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.item.id.toLowerCase().includes(q) || r.item.title.toLowerCase().includes(q),
    );
  });
  // Reordering always acts on the full (unfiltered) list — a filtered view
  // has no well-defined position to drop into or swap with.
  const canReorder = $derived(!locked && !filtering);

  function idsInOrder(): string[] {
    return rows.map((r) => r.item.id);
  }

  function move(id: string, dir: -1 | 1) {
    const ids = idsInOrder();
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onReorder(ids);
  }

  let dragId = $state<string | null>(null);

  function dragStart(id: string, e: DragEvent) {
    dragId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    }
  }
  function dragOver(e: DragEvent) {
    if (dragId) e.preventDefault();
  }
  function drop(targetId: string, e: DragEvent) {
    e.preventDefault();
    const source = dragId;
    dragId = null;
    if (!source || source === targetId) return;
    const ids = idsInOrder();
    const from = ids.indexOf(source);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, source);
    onReorder(ids);
  }
</script>

{#if items.length === 0}
  <p class="hint">No items — nothing under backlog/.</p>
{:else if visible.length === 0}
  <p class="hint">No items match "{filterText}".</p>
{:else}
  <div class="rows">
    {#each visible as row (row.item.id)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="row"
        class:on={row.item.id === selectedId}
        class:unlisted={row.unlisted}
        draggable={canReorder}
        ondragstart={(e) => dragStart(row.item.id, e)}
        ondragover={dragOver}
        ondrop={(e) => drop(row.item.id, e)}
      >
        {#if selectable}
          <input
            type="checkbox"
            checked={selectedIds.has(row.item.id)}
            aria-label="Include {row.item.title} in this shift"
            onclick={() => onToggle?.(row.item.id)}
          />
        {/if}
        <span class="ns-mono ord">{row.order ?? "—"}</span>
        <span class="ns-mono id">{row.item.id}</span>
        <button
          class="titlebtn"
          onclick={() => (selectable ? onToggle?.(row.item.id) : onSelect?.(row.item.id))}
        >
          {row.item.title}
        </button>
        <span class="ns-chip small">{row.item.kind}</span>
        <span class="ns-pill {itemStatusPill(row.item.status)}">{row.item.status || "todo"}</span>
        {#if canReorder}
          <span class="reorder">
            <button class="ns-btn small ghost" title="Move up" aria-label="Move {row.item.title} up" onclick={() => move(row.item.id, -1)}>&uarr;</button>
            <button class="ns-btn small ghost" title="Move down" aria-label="Move {row.item.title} down" onclick={() => move(row.item.id, 1)}>&darr;</button>
            <span class="handle" aria-hidden="true">&#8942;&#8942;</span>
          </span>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .hint {
    margin: 0;
    padding: 12px 20px;
    font-size: 13px;
    color: var(--dim);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 0 10px 10px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    border-radius: 6px;
  }
  .row:hover {
    background: var(--well);
  }
  .row.on {
    background: var(--sheet);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .row.unlisted {
    opacity: 0.7;
  }
  .ord {
    width: 22px;
    flex: none;
    color: var(--dim);
    font-size: 12px;
    text-align: right;
  }
  .id {
    flex: none;
    color: var(--dim);
    font-size: 12px;
  }
  .titlebtn {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--ink);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ns-chip.small {
    padding: 2px 8px;
    font-size: 11px;
    flex: none;
  }
  .reorder {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .handle {
    color: var(--dim);
    cursor: grab;
    padding: 0 2px;
    line-height: 1;
  }
  /* The move controls appear on hover; at rest the title has the width. */
  .reorder {
    opacity: 0;
    transition: opacity 0.12s;
  }
  .row:hover .reorder,
  .reorder:focus-within {
    opacity: 1;
  }
  input[type="checkbox"] {
    flex: none;
    width: 15px;
    height: 15px;
  }
</style>
