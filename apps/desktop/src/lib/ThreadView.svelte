<script lang="ts">
  /*
   * The thread view (nightshift backlog 292): what a research thread
   * stores, opened by clicking its name in the sidebar. thread.md a
   * section at a time — the list on the left, Start here first — and
   * log.md / archive.md whole, scrolled to their newest end. Read-only;
   * "Open in the editor" is the note editor, the existing edit path.
   * The logic is in `threadPanel.svelte.ts`; panel, not tab: blocker 1020.
   */
  import { tick } from "svelte";
  import { app, newChatInThread } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import { THREAD_FILES, newInThreadTip } from "./thread";
  import {
    closeThreadView,
    editThreadFile,
    showThreadFile,
    showThreadSection,
    threadView,
  } from "./threadPanel.svelte";
  import { tip } from "./tip";
  import Icon from "./Icon.svelte";

  const v = $derived(threadView.open);
  const shown = $derived(v && v.file === "thread.md" ? (v.sections[v.section] ?? null) : null);
  let body = $state<HTMLElement | null>(null);

  // log.md and archive.md open at their end, where the newest entry is;
  // a thread.md section opens at its top.
  $effect(() => {
    const at = v ? `${v.slug}/${v.file}/${v.section}/${v.text === null ? 0 : v.text.length}` : "";
    if (!at || !body) return;
    const el = body;
    const end = v!.file !== "thread.md";
    void tick().then(() => {
      el.scrollTop = end ? el.scrollHeight : 0;
    });
  });

  function key(e: KeyboardEvent): void {
    if (!threadView.open || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeThreadView();
  }

  function missingText(file: string): string {
    if (file === "log.md") return "No log.md yet — a wrap-up or an aside fold appends the first entry.";
    if (file === "archive.md") return "No archive.md yet — the daily upkeep moves struck lines here once they are old.";
    return "thread.md could not be read.";
  }
</script>

<svelte:window onkeydown={key} />

{#if v}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="tv-scrim" role="presentation" onclick={(e) => e.target === e.currentTarget && closeThreadView()}>
    <div class="ns-card tv" role="dialog" aria-modal="true" aria-labelledby="thread-view-title" tabindex="-1">
      <div class="tv-head">
        <div class="tv-title">
          <h2 id="thread-view-title"><span class="tv-mark" aria-hidden="true">◇</span> {v.title}</h2>
          <span class="tv-path mono">.agents/threads/{v.slug}/</span>
        </div>
        <button class="tv-close" aria-label="Close the thread view" use:tip={"Close (Esc)"} onclick={closeThreadView}
          ><Icon name="x" size={14} /></button
        >
      </div>
      <div class="tv-bar">
        <div class="tv-files" role="tablist" aria-label="The thread's files">
          {#each THREAD_FILES as f (f)}
            <button
              class="tv-file mono"
              class:on={v.file === f}
              role="tab"
              aria-selected={v.file === f}
              onclick={() => void showThreadFile(f)}>{f}</button
            >
          {/each}
        </div>
        <span class="tv-ro">read-only</span>
        <span class="tv-gap"></span>
        <button
          class="ns-btn small"
          disabled={v.text === null}
          use:tip={`Open ${v.file} in the note editor — the one place it is changed by hand`}
          onclick={editThreadFile}>Open in the editor</button
        >
        <button
          class="ns-btn small"
          disabled={app.busy || app.connecting}
          use:tip={newInThreadTip(v.slug)}
          onclick={() => {
            const slug = v.slug;
            closeThreadView();
            void newChatInThread(slug);
          }}>+ New chat in this thread</button
        >
      </div>
      <div class="tv-main">
        {#if v.file === "thread.md" && v.sections.length > 0}
          <nav class="tv-sections" aria-label="thread.md sections">
            {#each v.sections as s, i (i)}
              <button class="tv-sec" class:on={i === v.section} onclick={() => showThreadSection(i)}>
                {s.heading}{#if !s.body}<span class="tv-empty-mark">empty</span>{/if}
              </button>
            {/each}
          </nav>
        {/if}
        <div class="tv-body" bind:this={body}>
          {#if v.error}
            <p class="tv-note">{missingText(v.file)}</p>
            <p class="tv-note dim mono">{v.error}</p>
          {:else if v.text === null}
            <p class="tv-note dim">Reading {v.file}…</p>
          {:else if shown}
            <h3 class="tv-sec-title">{shown.heading}</h3>
            {#if shown.body}
              <div class="markdown">{@html renderMarkdown(shown.body)}</div>
            {:else}
              <p class="tv-note dim">Nothing under this heading yet.</p>
            {/if}
          {:else if v.text.trim()}
            <div class="markdown">{@html renderMarkdown(v.text)}</div>
          {:else}
            <p class="tv-note dim">{v.file} is empty.</p>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .tv-scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    z-index: 39;
  }
  .tv {
    width: 880px;
    max-width: 100%;
    height: min(720px, 100%);
    display: flex;
    flex-direction: column;
    padding: 0;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    border-color: var(--line2);
    font-family: var(--sans);
    color: var(--ink);
  }
  .tv-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 18px 20px 10px;
  }
  .tv-title {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  h2 {
    margin: 0;
    font-family: var(--serif);
    font-size: 21px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tv-mark {
    color: var(--accent);
  }
  .tv-path {
    font-size: 11.5px;
    color: var(--dim);
  }
  .tv-close {
    flex: none;
    display: inline-flex;
    padding: 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--dim);
    cursor: pointer;
  }
  .tv-close:hover {
    border-color: var(--line2);
    color: var(--ink);
  }
  .tv-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 20px 12px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .tv-files {
    display: inline-flex;
    border: 1px solid var(--line2);
    border-radius: 7px;
    overflow: hidden;
  }
  .tv-file {
    padding: 5px 11px;
    border: none;
    background: transparent;
    color: var(--ink2);
    font-size: 12px;
    cursor: pointer;
  }
  .tv-file + .tv-file {
    border-left: 1px solid var(--line2);
  }
  .tv-file.on {
    background: var(--well);
    color: var(--ink);
  }
  .tv-ro {
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .tv-gap {
    flex: 1;
  }
  .tv-main {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .tv-sections {
    flex: none;
    width: 200px;
    overflow-y: auto;
    padding: 10px 8px;
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .tv-sec {
    padding: 6px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--ink2);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .tv-sec:hover {
    background: var(--well);
  }
  .tv-sec.on {
    background: var(--well);
    color: var(--ink);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .tv-empty-mark {
    display: block;
    color: var(--dim);
    font-size: 11.5px;
  }
  /* Queue and Claims ids ("Q-4", "C-12") stay on one line. */
  .tv-body :global(td:first-child) {
    white-space: nowrap;
  }
  .tv-body {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 16px 24px 24px;
  }
  .tv-sec-title {
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .tv-note {
    margin: 0 0 6px;
    font-size: 13px;
    color: var(--ink2);
  }
  .tv-note.dim {
    color: var(--dim);
  }
  .mono {
    font-family: var(--mono);
  }
</style>
