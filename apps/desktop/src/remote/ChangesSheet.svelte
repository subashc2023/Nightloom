<script lang="ts">
  /**
   * A reply's file changes on the phone (item 742): one page per file, a
   * swipe (native scroll-snap) moves between them, the file strip above
   * jumps to one. Each page is the file's lines as the call asked for them,
   * one column at the phone's width — long lines wrap, never scroll the
   * page sideways. Read-only: nothing here can lose his work.
   *
   * The page he was on and each file opened to every line are kept by the
   * caller (`at`, `all`), so closing and opening the sheet again lands where
   * he left it (practices §7: every view keeps its state).
   */
  import { onMount, tick } from "svelte";
  import { reducedMotion } from "../lib/sendMotion";
  import { capLines, changesLine, pageAt, type FileChange } from "./turnChanges";

  interface Props {
    files: FileChange[];
    /** The page to open on. */
    at: number;
    /** Paths opened to every line. */
    all: ReadonlySet<string>;
    onpage: (i: number) => void;
    onall: (path: string) => void;
  }
  let { files, at, all, onpage, onall }: Props = $props();

  let pager = $state<HTMLDivElement | null>(null);
  let strip = $state<HTMLDivElement | null>(null);
  // Seeded from `at` once: from here on the pager's scroll decides it.
  // svelte-ignore state_referenced_locally
  let page = $state(Math.min(at, Math.max(0, files.length - 1)));

  function go(i: number, smooth = true) {
    if (!pager) return;
    pager.scrollTo({ left: i * pager.clientWidth, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }

  function onscroll() {
    if (!pager) return;
    const i = pageAt(pager.scrollLeft, pager.clientWidth, files.length);
    if (i !== page) {
      page = i;
      onpage(i);
    }
  }

  // The strip keeps the open file's tab in view.
  $effect(() => {
    const el = strip?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
  });

  onMount(() => {
    void tick().then(() => go(page, false));
  });
</script>

<div class="cg-title">Changes</div>
<div class="cg-sub">{changesLine(files)}</div>

{#if files.length > 1}
  <div class="cg-strip" role="tablist" aria-label="Changed files" bind:this={strip}>
    {#each files as f, i (f.path)}
      <button role="tab" class="cg-tab" class:on={i === page} aria-selected={i === page} data-page={i} onclick={() => go(i)}>
        <span class="cg-tab-name">{f.name}</span>
        <span class="cg-tab-pm">{#if f.added}<span class="add">+{f.added}</span>{/if}{#if f.removed}<span class="del">−{f.removed}</span>{/if}</span>
      </button>
    {/each}
  </div>
{/if}

<div class="cg-pager" bind:this={pager} {onscroll} data-changes-pager>
  {#each files as f, i (f.path)}
    {@const view = capLines(f.lines, all.has(f.path))}
    <section class="cg-page" aria-label={`Changes to ${f.path}`} aria-hidden={i !== page}>
      <div class="cg-head">
        <span class="cg-path"><span class="cg-dir">{f.dir}</span><span class="cg-name">{f.name}</span></span>
        <span class="cg-notes">
          {#if f.added}<span class="add">+{f.added}</span>{/if}
          {#if f.removed}<span class="del">−{f.removed}</span>{/if}
          {#if f.whole}<span class="cg-note">whole file</span>{/if}
          {#if f.everyMatch}<span class="cg-note">every match</span>{/if}
          {#if f.edits > 1}<span class="cg-note">{f.edits} edits</span>{/if}
        </span>
      </div>
      {#if f.lines.length === 0}
        <div class="cg-empty">No change.</div>
      {:else}
        <div class="cg-body" role="table" aria-label={`Lines of ${f.name}`}>
          {#each view.shown as line, k (k)}
            {#if line.sep}
              <div class="cg-sep" role="row">next edit</div>
            {:else}
              <div class="cg-line {line.kind}" role="row"><span class="cg-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</span><span class="cg-text">{line.text || " "}</span></div>
            {/if}
          {/each}
          {#if view.hidden > 0}
            <button class="cg-more" onclick={() => onall(f.path)}>Show all · {view.hidden} more {view.hidden === 1 ? "line" : "lines"}</button>
          {/if}
        </div>
      {/if}
    </section>
  {/each}
</div>

{#if files.length > 1}
  <div class="cg-foot" aria-live="polite">
    {#if files.length <= 12}<span class="cg-dots" aria-hidden="true">{#each files as f, i (f.path)}<i class:on={i === page}></i>{/each}</span>{/if}
    <span>File {page + 1} of {files.length} · {page < files.length - 1 ? "swipe for the next" : "swipe back for the others"}</span>
  </div>
{/if}

<style>
  .cg-title {
    font-weight: 600;
    font-size: 17px;
    flex: none;
  }
  .cg-sub {
    color: var(--dim);
    font-size: 13px;
    margin-top: -6px;
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .add {
    color: var(--done);
  }
  .del {
    color: var(--failed);
  }
  .cg-strip {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    flex: none;
    scrollbar-width: none;
    margin: 0 -16px;
    padding: 0 16px;
  }
  .cg-strip::-webkit-scrollbar {
    display: none;
  }
  .cg-tab {
    flex: none;
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    max-width: 70%;
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--ink2, var(--ink));
    font: inherit;
    font-size: 13px;
  }
  .cg-tab.on {
    border-color: var(--line2, var(--line));
    background: var(--well, var(--paper));
    color: var(--ink);
  }
  .cg-tab-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cg-tab-pm {
    display: inline-flex;
    gap: 4px;
    font-family: var(--mono, monospace);
    font-size: 11px;
  }
  .cg-pager {
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    margin: 0 -16px;
    flex: 1 1 auto;
    min-height: 0;
  }
  .cg-pager::-webkit-scrollbar {
    display: none;
  }
  .cg-page {
    flex: 0 0 100%;
    width: 100%;
    box-sizing: border-box;
    padding: 0 16px;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    /* Each file scrolls on its own; the sheet's own head stays put. */
    max-height: calc(min(94dvh, var(--sheet-cap, 100dvh)) - 210px);
    overflow-y: auto;
    overscroll-behavior-y: contain;
    min-width: 0;
  }
  .cg-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    padding: 4px 0 8px;
    position: sticky;
    top: 0;
    background: var(--sheet);
    z-index: 1;
  }
  /* Jarvis draws the sheet on --raised (Remote.svelte's gated .sheet rule). */
  :global(:where(:root:not([data-layout="classic"]))) .cg-head {
    background: var(--raised);
  }
  .cg-path {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 14px;
  }
  .cg-dir {
    color: var(--dim);
  }
  .cg-name {
    font-weight: 600;
  }
  .cg-notes {
    display: inline-flex;
    gap: 8px;
    font-family: var(--mono, monospace);
    font-size: 12px;
  }
  .cg-note {
    color: var(--dim);
    font-family: inherit;
  }
  .cg-body {
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
    background: var(--paper);
    font: 12px/1.5 var(--mono, monospace);
  }
  .cg-line {
    display: flex;
    min-width: 0;
  }
  .cg-sign {
    flex: none;
    width: 18px;
    text-align: center;
    color: var(--dim);
    user-select: none;
  }
  .cg-text {
    flex: 1 1 auto;
    min-width: 0;
    padding-right: 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 2;
  }
  .cg-line.add {
    background: color-mix(in srgb, var(--done) 15%, transparent);
  }
  .cg-line.add .cg-sign {
    color: var(--done);
  }
  .cg-line.del {
    background: color-mix(in srgb, var(--failed) 15%, transparent);
  }
  .cg-line.del .cg-sign {
    color: var(--failed);
  }
  .cg-sep {
    padding: 2px 10px;
    border-top: 1px dashed var(--line2, var(--line));
    border-bottom: 1px dashed var(--line2, var(--line));
    color: var(--dim);
    font-size: 11px;
    font-family: var(--sans, inherit);
  }
  .cg-more {
    display: block;
    width: 100%;
    padding: 10px;
    border: 0;
    border-top: 1px solid var(--line);
    background: transparent;
    color: var(--accent-ink, var(--accent));
    font: inherit;
    font-size: 13px;
  }
  .cg-empty {
    color: var(--dim);
    font-size: 13px;
    padding: 8px 0;
  }
  .cg-foot {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--dim);
    font-size: 12px;
  }
  .cg-dots {
    display: inline-flex;
    gap: 5px;
  }
  .cg-dots i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--line2, var(--line));
  }
  .cg-dots i.on {
    background: var(--ink);
  }
</style>
