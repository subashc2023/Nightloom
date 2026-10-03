<script lang="ts">
  /*
   * The thread view (nightshift backlog 292): what a research thread
   * stores, as a tab — opened by clicking its name in the sidebar, and
   * like any tab draggable into a split beside the chat. thread.md a
   * section at a time — the list on the left (above, in a narrow pane),
   * Start here first — and log.md / archive.md whole, scrolled to their
   * newest end. Read-only; "Open in the editor" is the note editor, the
   * existing edit path. ~~A panel over the window~~ (2026-10-03, blocker
   * 1020 answered "tab"). The logic is in `threadPanel.svelte.ts`.
   */
  import { tick } from "svelte";
  import { app, newChatInThread } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import { THREAD_FILES, fileSections, newInThreadTip, openingSection, type ThreadFile } from "./thread";
  import { editThreadFile, readThreadFile, setThreadPlace, threadPlace, threadRead } from "./threadPanel.svelte";
  import type { TabContent } from "./tabs";
  import { tip } from "./tip";

  let { content }: { content: Extract<TabContent, { kind: "thread" }> } = $props();

  const slug = $derived(content.slug);
  const name = $derived(content.title?.trim() || content.slug);
  const place = $derived(threadPlace(slug));
  const file = $derived(place.file);

  let reloads = $state(0);
  let body = $state<HTMLElement | null>(null);

  // What was last read is shown at once; a fresh read follows whenever the
  // tab shows a file (and on Reload), and replaces it when it lands.
  const got = $derived(threadRead(slug, file));
  const text = $derived(got && "text" in got ? got.text : null);
  const error = $derived(got && "error" in got ? got.error : null);
  $effect(() => {
    const s = slug;
    const f = file;
    void reloads;
    void readThreadFile(s, f);
  });

  const sections = $derived(file === "thread.md" && text !== null ? fileSections(text) : []);
  const section = $derived(
    sections.length === 0 ? -1 : place.section >= 0 && place.section < sections.length ? place.section : openingSection(sections),
  );
  const shown = $derived(section >= 0 ? sections[section] : null);

  // log.md and archive.md open at their end, where the newest entry is;
  // a thread.md section opens at its top.
  $effect(() => {
    const at = `${slug}/${file}/${section}/${text === null ? -1 : text.length}`;
    if (!body || text === null || !at) return;
    const el = body;
    const end = file !== "thread.md";
    void tick().then(() => {
      el.scrollTop = end ? el.scrollHeight : 0;
    });
  });

  function showFile(f: ThreadFile): void {
    if (f !== file) setThreadPlace(slug, { file: f });
  }

  function missingText(f: string): string {
    if (f === "log.md") return "No log.md yet — a wrap-up or an aside fold appends the first entry.";
    if (f === "archive.md") return "No archive.md yet — the daily upkeep moves struck lines here once they are old.";
    return "thread.md could not be read — the thread may have been moved or deleted.";
  }
</script>

<div class="thread-view">
  <header class="tv-head">
    <div class="tv-title">
      <h2><span class="tv-mark" aria-hidden="true">◇</span> {name}</h2>
      <span class="tv-path mono">.agents/threads/{slug}/ · read-only</span>
    </div>
  </header>
  <div class="tv-bar">
    <div class="tv-files" role="tablist" aria-label="The thread's files">
      {#each THREAD_FILES as f (f)}
        <button class="tv-file mono" class:on={file === f} role="tab" aria-selected={file === f} onclick={() => showFile(f)}
          >{f}</button
        >
      {/each}
    </div>
    <span class="tv-gap"></span>
    <button class="ns-btn ghost small" use:tip={`Read ${file} again`} onclick={() => reloads++}>Reload</button>
    <button
      class="ns-btn ghost small"
      disabled={text === null}
      use:tip={`Open ${file} in the note editor — the one place it is changed by hand`}
      onclick={() => editThreadFile(slug, file)}>Open in the editor</button
    >
    <button
      class="ns-btn small"
      disabled={app.busy || app.connecting}
      use:tip={newInThreadTip(slug)}
      onclick={() => void newChatInThread(slug)}>+ New chat in this thread</button
    >
  </div>
  <div class="tv-main">
    {#if sections.length > 0}
      <nav class="tv-sections" aria-label="thread.md sections">
        {#each sections as s, i (i)}
          <button class="tv-sec" class:on={i === section} onclick={() => setThreadPlace(slug, { section: i })}>
            {s.heading}{#if !s.body}<span class="tv-empty-mark">empty</span>{/if}
          </button>
        {/each}
      </nav>
    {/if}
    <div class="tv-body" bind:this={body}>
      {#if error}
        <p class="tv-note">{missingText(file)}</p>
        <p class="tv-note dim mono">{error}</p>
      {:else if text === null}
        <p class="tv-note dim">Reading {file}…</p>
      {:else if shown}
        <h3 class="tv-sec-title">{shown.heading}</h3>
        {#if shown.body}
          <div class="markdown">{@html renderMarkdown(shown.body)}</div>
        {:else}
          <p class="tv-note dim">Nothing under this heading yet.</p>
        {/if}
      {:else if text.trim()}
        <div class="markdown">{@html renderMarkdown(text)}</div>
      {:else}
        <p class="tv-note dim">{file} is empty.</p>
      {/if}
    </div>
  </div>
</div>

<style>
  .thread-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
    container-type: inline-size;
    font-family: var(--sans);
    color: var(--ink);
  }
  .tv-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 20px 8px;
    flex: none;
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
    font-size: 20px;
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tv-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 20px 10px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
    flex: none;
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
    width: 190px;
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
  .tv-body {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: 16px 24px 40px;
  }
  /* Queue and Claims ids ("Q-4", "C-12") stay on one line. */
  .tv-body :global(td:first-child) {
    white-space: nowrap;
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
  /* A narrow pane (a split beside the chat): the sections wrap above the text. */
  @container (max-width: 620px) {
    .tv-main {
      flex-direction: column;
    }
    .tv-sections {
      width: auto;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 2px 4px;
      padding: 8px 12px;
      border-right: none;
      border-bottom: 1px solid var(--line);
      overflow: visible;
    }
    .tv-sec {
      padding: 3px 8px;
      font-size: 12px;
    }
    .tv-sec.on {
      box-shadow: inset 0 -2px 0 var(--accent);
    }
    .tv-empty-mark {
      display: none;
    }
    .tv-body {
      padding: 12px 16px 32px;
    }
  }
</style>
