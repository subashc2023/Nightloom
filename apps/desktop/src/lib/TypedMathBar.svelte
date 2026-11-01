<script lang="ts">
  /*
   * Item 456: typed maths offered back as LaTeX, a slim bar just above the
   * message box. Each formula shows as typed → rendered; "Use maths" (or Tab)
   * takes them all, × (or Esc) declines them all, and with several each one
   * has its own ✓ and × on hover. Nothing here edits the draft: the owner
   * (`Composer.svelte`) does, as one undo step.
   */
  import { tip } from "./tip";
  import { renderMathHtml } from "./markdown";
  import { groupTypedMath, type TypedMathSpan } from "./typedMath";

  let {
    spans,
    onaccept,
    ondeny,
  }: {
    spans: TypedMathSpan[];
    /** null: all of them. */
    onaccept: (one: TypedMathSpan | null) => void;
    ondeny: (one: TypedMathSpan | null) => void;
  } = $props();

  /** Item 490: one chip per distinct formula; it acts on every occurrence. */
  const groups = $derived(groupTypedMath(spans));
  const many = $derived(groups.length > 1);
  const several = $derived(spans.length > 1);
  /** The chip shows exactly the text it changes: a line break or tab drawn, never collapsed. */
  const shown = (src: string) => src.replace(/\n/g, "⏎").replace(/\t/g, "⇥");
  /** Item 479: every offer is LaTeX already, typed without its dollars —
   *  the offer is to wrap it, not to convert it. */
  const allBare = $derived(spans.length > 0 && spans.every((s) => s.bare));
  const wraps = $derived(spans.some((s) => s.display) ? "$…$, or $$…$$ for a whole line" : "$…$");
</script>

{#if spans.length > 0}
  <div class="tm-bar" role="status" aria-label="Typed maths can be shown as formulas">
    <span class="tm-label dim">{allBare ? "Wrap as maths" : "Show as maths"}</span>
    <ul class="tm-list">
      {#each groups as g (g.span.src + "\u0000" + g.span.tex)}
        {@const s = g.span}
        <li class="tm-item" class:many>
          <span class="tm-src mono">{shown(s.src)}</span>
          {#if g.count > 1}<span class="tm-count dim" aria-label={`${g.count} times`}>×{g.count}</span>{/if}
          <span class="tm-arrow dim" aria-hidden="true">→</span>
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- KaTeX output, sanitised by renderMathHtml -->
          <span class="tm-tex">{@html renderMathHtml(s.tex, false)}</span>
          {#if many}
            <span class="tm-one">
              <button
                type="button"
                class="tm-mini yes"
                aria-label={`Use maths for ${s.src}`}
                use:tip={s.close ? "Close this formula with $" : g.count > 1 ? `Use maths for all ${g.count}` : "Use maths for this one"}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => onaccept(s)}>✓</button
              >
              <button
                type="button"
                class="tm-mini no"
                aria-label={`Keep ${s.src} as typed`}
                use:tip={g.count > 1 ? `Keep all ${g.count} as typed` : "Keep this one as typed"}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => ondeny(s)}>×</button
              >
            </span>
          {/if}
        </li>
      {/each}
    </ul>
    <span class="tm-spacer"></span>
    <button
      type="button"
      class="ns-btn small tm-use"
      use:tip={several ? `Wrap every formula as LaTeX (${wraps}) — ⌘Z undoes it` : `Wrap it as LaTeX (${wraps}) — ⌘Z undoes it`}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => onaccept(null)}
      >{allBare ? (several ? "Wrap all as maths" : "Wrap as maths") : several ? "Use maths for all" : "Use maths"}
      <span class="tm-key">Tab</span></button
    >
    <button
      type="button"
      class="tm-x"
      aria-label="Keep as typed"
      use:tip={"Keep as typed (Esc) — not offered again in this draft"}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => ondeny(null)}>×</button
    >
  </div>
{/if}

<style>
  .tm-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 6px;
    padding: 4px 6px 4px 10px;
    font-size: 12px;
    background: var(--panel, var(--bg));
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 0;
    animation: tm-in 140ms ease-out;
  }
  /* A slide only, no fade: a window whose animations are not running
     (offscreen, backgrounded) would hold the first frame, and a bar held
     at opacity 0 is a bar he cannot see. Held 4px low is still a bar. */
  @keyframes tm-in {
    from {
      transform: translateY(4px);
    }
    to {
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tm-bar {
      animation: none;
    }
  }
  .tm-label {
    flex: none;
    white-space: nowrap;
  }
  .tm-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin: 0;
    padding: 0;
    list-style: none;
    min-width: 0;
  }
  .tm-item {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 1px 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .tm-src {
    color: var(--dim);
    font-size: 11.5px;
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tm-count {
    font-size: 11px;
  }
  .tm-tex {
    color: var(--text);
    font-size: 14px;
  }
  .tm-one {
    display: inline-flex;
    gap: 2px;
    margin-left: 2px;
    opacity: 0;
  }
  .tm-item:hover .tm-one,
  .tm-item:focus-within .tm-one {
    opacity: 1;
  }
  .tm-mini {
    width: 1.1rem;
    height: 1.1rem;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--bg);
    color: var(--dim);
    font-size: 0.7rem;
    line-height: 1;
    cursor: pointer;
  }
  .tm-mini.yes:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .tm-mini.no:hover {
    color: var(--text);
  }
  .tm-spacer {
    flex: 1;
  }
  .tm-use {
    flex: none;
    white-space: nowrap;
  }
  .tm-key {
    margin-left: 0.3rem;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 10.5px;
    color: var(--dim);
  }
  .tm-x {
    flex: none;
    width: 1.3rem;
    height: 1.3rem;
    padding: 0;
    background: none;
    color: var(--dim);
    border: 1px solid transparent;
    border-radius: 50%;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
  }
  .tm-x:hover {
    color: var(--text);
    border-color: var(--border);
  }
</style>
