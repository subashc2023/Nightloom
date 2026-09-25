<script lang="ts">
  /**
   * A file as a tab (nightshift backlog 161, 2026-09-25): the file card's
   * *Open* under a reply. Read-only, whatever the file is — the card's path
   * is the model's choice, so this view shows and never writes (a `.md`
   * outside the notes folder is read-only too: guess pass 2026-09-25,
   * question 18; a note inside it opens in the note view instead, and never
   * reaches here). An image or a PDF draws as 145's attachment viewer does,
   * Markdown formatted with a Plain switch, any other text as it is. The
   * backend decides whether the file may be read at all (`read_file_tab`:
   * inside the chat's folders, or written by its own tools) and its refusal
   * is shown here in its own words, with Reveal beside it.
   */
  import * as api from "./api";
  import { addToast, app } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import { fmtSize } from "./cards";
  import type { TabContent } from "./tabs";

  let { content }: { content: Extract<TabContent, { kind: "file" }> } = $props();

  let file = $state<api.FileTabData | null>(null);
  let error = $state<string | null>(null);
  let plain = $state(false);
  let full = $state(false);
  let reads = $state(0);

  $effect(() => {
    const path = content.path;
    const chat = content.session ?? app.activeSessionId;
    void reads;
    let stale = false;
    file = null;
    error = null;
    api
      .readFileTab(path, chat)
      .then((f) => {
        if (!stale) file = f;
      })
      .catch((e) => {
        if (!stale) error = String(e);
      });
    return () => {
      stale = true;
    };
  });

  const src = $derived(file?.data ? `data:${file.media_type};base64,${file.data}` : null);

  async function reveal(): Promise<void> {
    try {
      await api.revealFile(content.path);
    } catch (e) {
      addToast(`Could not reveal: ${String(e)}`);
    }
  }
  async function openWithApp(): Promise<void> {
    try {
      await api.openFile(content.path);
    } catch (e) {
      addToast(`Could not open: ${String(e)}`);
    }
  }
</script>

<div class="file-view">
  <header class="head">
    <span class="path mono" title={content.path}>{content.path}</span>
    {#if file}
      <span class="meta mono">
        {fmtSize(file.size)} · read-only{file.via === "written" ? " · written by this chat's tools, outside its folders" : ""}
      </span>
    {/if}
    <span class="spacer"></span>
    {#if file?.kind === "markdown"}
      <button class="ns-btn ghost small" onclick={() => (plain = !plain)} title="Show the Markdown source or the formatted text"
        >{plain ? "Formatted" : "Plain"}</button
      >
    {/if}
    <button class="ns-btn ghost small" onclick={() => reads++} title="Read the file again">Reload</button>
    <button class="ns-btn ghost small" onclick={() => void reveal()} title="Show in the file manager">Reveal</button>
  </header>
  {#if error}
    <div class="note-card">
      <p>{error}</p>
      <button class="ns-btn small" onclick={() => void reveal()}>Reveal in the Finder</button>
    </div>
  {:else if !file}
    <p class="dim">Reading…</p>
  {:else if file.kind === "image" && src}
    <div class="media" class:scroll={full}>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <img
        class="img"
        class:full
        {src}
        alt={content.path}
        title={full ? "Click to fit the pane" : "Click for the image's own size"}
        onclick={() => (full = !full)}
      />
    </div>
  {:else if file.kind === "pdf" && src}
    <div class="media">
      <embed class="pdf" {src} type={file.media_type} title={content.path} />
    </div>
  {:else if file.kind === "markdown" && !plain}
    <div class="body markdown">{@html renderMarkdown(file.text ?? "")}</div>
  {:else if file.kind === "markdown" || file.kind === "text"}
    <pre class="body text mono">{file.text ?? ""}</pre>
  {:else}
    <div class="note-card">
      <p>Nightloom does not draw this kind of file. Its own application can open it.</p>
      <button class="ns-btn small" onclick={() => void openWithApp()}>Open with its application</button>
    </div>
  {/if}
</div>

<style>
  .file-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    flex: none;
    min-width: 0;
  }
  .path {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .meta {
    font-size: 11.5px;
    color: var(--dim);
    white-space: nowrap;
    flex: none;
  }
  .spacer {
    flex: 1;
  }
  .mono {
    font-family: var(--mono);
  }
  .dim {
    color: var(--dim);
    padding: 16px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 16px 24px 40px;
  }
  .text {
    font-size: 12.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .media {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: var(--well);
    overflow: hidden;
  }
  .media.scroll {
    display: block;
    overflow: auto;
  }
  .img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: zoom-in;
    display: block;
  }
  .img.full {
    max-width: none;
    max-height: none;
    cursor: zoom-out;
  }
  .pdf {
    width: 100%;
    height: 100%;
    border: none;
  }
  .note-card {
    margin: 32px auto;
    max-width: 440px;
    padding: 20px 24px;
    border: 1px dashed var(--line2);
    border-radius: 10px;
    color: var(--dim);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
