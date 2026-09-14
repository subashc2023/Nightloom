<script lang="ts">
  /**
   * The `?` beside a control: its explanation, shown on hover or focus rather
   * than printed under it. Swaraag's call for the model popover (nightshift
   * blocker 031, 2026-09-13): "less text is better". The text is what used to
   * be the control's `title=`, so nothing is explained less — it is explained
   * on demand. A button rather than a span so the keyboard reaches it.
   */
  let { text, side = "left" }: { text: string; side?: "left" | "right" } = $props();
  let open = $state(false);
  const id = `hint-${Math.random().toString(36).slice(2, 8)}`;
</script>

<span class="hint" class:right={side === "right"}>
  <button
    type="button"
    class="q"
    class:open
    aria-label="What this does"
    aria-describedby={open ? id : undefined}
    onmouseenter={() => (open = true)}
    onmouseleave={() => (open = false)}
    onfocus={() => (open = true)}
    onblur={() => (open = false)}
    onclick={(e) => {
      e.preventDefault();
      open = !open;
    }}
  >
    ?
  </button>
  {#if open}
    <span class="tip" role="tooltip" {id}>{text}</span>
  {/if}
</span>

<style>
  .hint {
    position: relative;
    display: inline-flex;
    flex: none;
  }
  .q {
    width: 15px;
    height: 15px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--dim);
    font-size: 10px;
    line-height: 1;
    font-family: var(--sans);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: help;
  }
  .q:hover,
  .q.open {
    border-color: var(--accent);
    color: var(--accent);
  }
  .q:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  .tip {
    position: absolute;
    right: 22px;
    top: -8px;
    width: 220px;
    padding: 7px 9px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 6px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    font-size: 11px;
    color: var(--ink2);
    line-height: 1.4;
    text-align: left;
    white-space: pre-line;
    z-index: 5;
    pointer-events: none;
  }
  .hint.right .tip {
    right: auto;
    left: 22px;
  }
</style>
