<script lang="ts">
  import { tip } from "./tip";
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
    grouped = false,
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
    /** Plan a shift: two sections — the selected items first, in the order
     *  the shift will run them (that is what drag and the arrows reorder),
     *  then the rest. `order` is then the plan's own order, not order.json's. */
    grouped?: boolean;
  } = $props();

  const rows = $derived(orderedBacklog(items, order));
  // Grouped: the selected rows keep their relative order and are numbered
  // 1..N within the section; the rest follow. `idsInOrder` yields the same
  // sequence, so a reorder among the selected never disturbs the others.
  const groupedRows = $derived.by(() => {
    if (!grouped) return rows;
    const sel = rows.filter((r) => selectedIds.has(r.item.id)).map((r, i) => ({ ...r, order: i + 1 }));
    const rest = rows.filter((r) => !selectedIds.has(r.item.id)).map((r) => ({ ...r, order: null }));
    return [...sel, ...rest];
  });
  const selectedCount = $derived(grouped ? rows.filter((r) => selectedIds.has(r.item.id)).length : 0);
  const filtering = $derived(filterText.trim().length > 0);
  const visible = $derived.by(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return groupedRows;
    return groupedRows.filter(
      (r) => r.item.id.toLowerCase().includes(q) || r.item.title.toLowerCase().includes(q),
    );
  });
  // Reordering always acts on the full (unfiltered) list — a filtered view
  // has no well-defined position to drop into or swap with.
  const canReorder = $derived(!locked && !filtering);

  function idsInOrder(): string[] {
    return groupedRows.map((r) => r.item.id);
  }
  /** Grouped: only a selected row moves, and only within its section. */
  function movable(id: string): boolean {
    return canReorder && (!grouped || selectedIds.has(id));
  }

  function move(id: string, dir: -1 | 1) {
    const ids = idsInOrder();
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    if (grouped && (j >= selectedCount || i >= selectedCount)) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onReorder(ids);
  }

  let dragId = $state<string | null>(null);
  // The list's own width: under `NARROW` the kind chip is dropped so the
  // status pill stays whole and the title keeps its room.
  let width = $state(0);
  const NARROW = 420;

  /**
   * While a row is dragged, the row under the pointer opens a gap on the
   * side the pointer is on (top half: above it; bottom half: below), so the
   * list shows where the drop will land — the static space moving around
   * Swaraag asked for (2026-09-11 review). The gap is a margin with a
   * transition; the dragged row is dimmed in place.
   */
  let over = $state<{ id: string; before: boolean } | null>(null);

  function dragStart(id: string, e: DragEvent) {
    dragId = id;
    over = null;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    }
  }
  function dragOver(id: string, e: DragEvent) {
    if (!dragId) return;
    if (grouped && !selectedIds.has(id)) {
      over = null;
      return;
    }
    e.preventDefault();
    if (id === dragId) {
      over = null;
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    if (!over || over.id !== id || over.before !== before) over = { id, before };
  }
  function dragEnd() {
    dragId = null;
    over = null;
  }
  function listLeave(e: DragEvent) {
    // Leaving the list altogether (not moving between its rows) closes the gap.
    const to = e.relatedTarget as Node | null;
    if (!to || !(e.currentTarget as HTMLElement).contains(to)) over = null;
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    const source = dragId;
    const target = over;
    dragId = null;
    over = null;
    if (!source || !target || source === target.id) return;
    const ids = idsInOrder().filter((x) => x !== source);
    const at = ids.indexOf(target.id);
    if (at < 0) return;
    ids.splice(at + (target.before ? 0 : 1), 0, source);
    onReorder(ids);
  }
</script>

{#if items.length === 0}
  <p class="hint">No items — nothing under backlog/.</p>
{:else if visible.length === 0}
  <p class="hint">No items match "{filterText}".</p>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="rows" class:narrow={width > 0 && width < NARROW} bind:clientWidth={width} ondragleave={listLeave} ondrop={drop} ondragover={(e) => { if (dragId) e.preventDefault(); }}>
    {#each visible as row, i (row.item.id)}
      {#if grouped && !filtering && i === 0}
        <div class="section ns-k">{selectedCount > 0 ? `Selected · ${selectedCount} — in the order the shift runs them` : "Nothing selected"}</div>
      {/if}
      {#if grouped && !filtering && i === selectedCount && i > 0}
        <div class="section ns-k rest">Not selected</div>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="row"
        class:on={row.item.id === selectedId}
        class:unlisted={row.unlisted}
        class:dragging={row.item.id === dragId}
        class:gap-before={over?.id === row.item.id && over.before}
        class:gap-after={over?.id === row.item.id && !over.before}
        draggable={movable(row.item.id)}
        ondragstart={(e) => dragStart(row.item.id, e)}
        ondragover={(e) => dragOver(row.item.id, e)}
        ondragend={dragEnd}
      >
        {#if selectable}
          <input
            type="checkbox"
            checked={selectedIds.has(row.item.id)}
            aria-label="Include {row.item.title} in this shift"
            onclick={() => onToggle?.(row.item.id)}
          />
        {/if}
        <span class="ns-mono ord">{row.order ?? (grouped ? "·" : "—")}</span>
        <span class="ns-mono id">{row.item.id}</span>
        <button
          class="titlebtn"
          onclick={() => (selectable ? onToggle?.(row.item.id) : onSelect?.(row.item.id))}
        >
          {row.item.title}
        </button>
        <span class="ns-chip small">{row.item.kind}</span>
        <span class="ns-pill {itemStatusPill(row.item.status)}">{row.item.status || "todo"}</span>
        {#if movable(row.item.id)}
          <span class="reorder">
            <button class="ns-btn small ghost" use:tip={"Move up"} aria-label="Move {row.item.title} up" onclick={() => move(row.item.id, -1)}>&uarr;</button>
            <button class="ns-btn small ghost" use:tip={"Move down"} aria-label="Move {row.item.title} down" onclick={() => move(row.item.id, 1)}>&darr;</button>
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
  .row {
    transition: margin 130ms ease, opacity 130ms ease;
  }
  .row.dragging {
    opacity: 0.35;
  }
  .row.gap-before {
    margin-top: 38px;
  }
  .row.gap-after {
    margin-bottom: 38px;
  }
  /* The gap draws the landing line. */
  .row.gap-before::before,
  .row.gap-after::after {
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .row.gap-before::before {
    top: -20px;
  }
  .row.gap-after::after {
    bottom: -20px;
  }
  .row.on {
    background: var(--sheet);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .row.unlisted {
    opacity: 0.7;
  }
  .section {
    padding: 10px 8px 4px;
    color: var(--dim);
  }
  .section.rest {
    margin-top: 8px;
    border-top: 1px solid var(--line);
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
