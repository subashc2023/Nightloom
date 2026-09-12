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
  // The list's own width: under `NARROW` the kind chip is dropped so the
  // status pill stays whole and the title keeps its room.
  let width = $state(0);
  const NARROW = 420;

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
  <div class="rows" class:narrow={width > 0 && width < NARROW} bind:clientWidth={width}>
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
  /* A narrow list (the Plan screen's column, a squeezed Backlog) drops the
     kind chip — it is in the item's detail — so the status stays whole and
     the title keeps its room. */
  .rows.narrow .ns-chip.small {
    display: none;
  }
  .rows.narrow .row :global(.ns-pill) {
    flex: none;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    border-radius: 6px;
  }
  /* Every other row a shade darker, so a long list reads as rows. */
  .row:nth-child(even) {
    background: color-mix(in srgb, var(--sheet) 55%, transparent);
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
  /* The title never collapses to nothing: it keeps at least a third of the
     row (a blank, unclickable row was the bug), and the chips give way
     first — they truncate rather than push the title out. */
  .titlebtn {
    flex: 1 1 40%;
    min-width: 96px;
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
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-block;
  }
  .row :global(.ns-pill) {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-block;
    white-space: nowrap;
  }
  /* Floats over the row's right edge on hover, on the row's own background,
     so at rest it reserves no width. */
  .reorder {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    padding-left: 10px;
    background: linear-gradient(to right, transparent, var(--well) 22%);
    border-radius: 6px;
  }
  .row.on .reorder {
    background: linear-gradient(to right, transparent, var(--sheet) 22%);
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
    pointer-events: none;
    transition: opacity 0.12s;
  }
  .row:hover .reorder,
  .reorder:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
  input[type="checkbox"] {
    flex: none;
    width: 15px;
    height: 15px;
  }
</style>
