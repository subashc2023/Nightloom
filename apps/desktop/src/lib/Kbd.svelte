<script lang="ts">
  /** A key cap: `⌘K`, `↵`, `esc`. Drawn, never a font glyph, so every palette colours it. */
  let { keys, dim = false }: { keys: string; dim?: boolean } = $props();
</script>

<kbd class="kbd" class:dim>{keys}</kbd>

<style>
  .kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 19px;
    padding: 0 5px;
    border: 1px solid var(--line2);
    border-bottom-width: 2px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink2);
    background: var(--sheet);
    white-space: nowrap;
    flex: none;
  }
  .kbd.dim {
    opacity: 0.45;
  }
</style>
