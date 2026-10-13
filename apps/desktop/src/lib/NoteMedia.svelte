<script lang="ts">
  /**
   * A note that is not text (nightshift backlog 307): a PDF or an image
   * dropped in a project's files, drawn as the file tab draws them (an
   * `<embed>` of the PDF, which the webview shows as pages; the image at the
   * pane's width), and anything else — a `.pptx`, a zip — as a card with
   * Open and Reveal. Read-only: there is no text to edit, so the note
   * view's Plain / Formatted / Preview / Edit / Save are not offered.
   */
  import { tip } from "./tip";
  import * as api from "./api";
  import { addToast } from "./state.svelte";
  import { fmtSize } from "./cards";
  import { noteMediaShape } from "./noteMedia";

  let { file, name }: { file: api.FileTabData; name: string } = $props();

  let full = $state(false);
  const shape = $derived(noteMediaShape(file));
  const src = $derived(file.data ? `data:${file.media_type};base64,${file.data}` : null);

  async function reveal(): Promise<void> {
    try {
      await api.revealFile(file.path);
    } catch (e) {
      addToast(`Could not reveal: ${String(e)}`);
    }
  }
  async function openWithApp(): Promise<void> {
    try {
      await api.openFile(file.path);
    } catch (e) {
      addToast(`Could not open: ${String(e)}`);
    }
  }
</script>

<div class="note-media">
  <div class="bar">
    <span class="meta mono">{shape.label} · {fmtSize(file.size)} · read-only</span>
    <span class="spacer"></span>
    {#if shape.view !== "card"}
      <button class="ns-btn ghost small" onclick={() => void openWithApp()} use:tip={"Open in the application the Mac pairs it with"}
        >Open</button
      >
      <button class="ns-btn ghost small" onclick={() => void reveal()} use:tip={"Show it in the Finder"}
        >Reveal in Finder</button
      >
    {/if}
  </div>
  {#if shape.view === "pdf" && src}
    <div class="media">
      <embed class="pdf" {src} type={file.media_type} title={name} />
    </div>
  {:else if shape.view === "image" && src}
    <div class="media" class:scroll={full}>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <img
        class="img"
        class:full
        {src}
        alt={name}
        use:tip={full ? "Click to fit the pane" : "Click for the image's own size"}
        onclick={() => (full = !full)}
      />
    </div>
  {:else}
    <div class="card">
      <p class="lead">This file isn't text</p>
      <p class="dim">
        {shape.label}, {fmtSize(file.size)}. Nightloom doesn't draw this kind of file; its own application
        can open it.
      </p>
      <div class="actions">
        <button class="ns-btn small" onclick={() => void openWithApp()}>Open</button>
        <button class="ns-btn ghost small" onclick={() => void reveal()}>Reveal in Finder</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .note-media {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.2));
  }
  .spacer {
    flex: 1;
  }
  .meta {
    font-size: 12px;
    opacity: 0.7;
  }
  .media {
    flex: 1;
    min-height: 0;
    display: flex;
    justify-content: center;
    overflow: hidden;
  }
  .media.scroll {
    overflow: auto;
    justify-content: flex-start;
  }
  .pdf {
    width: 100%;
    height: 100%;
    border: 0;
  }
  .img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: zoom-in;
  }
  .img.full {
    max-width: none;
    max-height: none;
    cursor: zoom-out;
  }
  .card {
    margin: 24px;
    padding: 16px 18px;
    border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
    border-radius: 8px;
    max-width: 520px;
  }
  .lead {
    margin: 0 0 6px;
    font-weight: 600;
  }
  .dim {
    margin: 0 0 12px;
    opacity: 0.75;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
</style>
