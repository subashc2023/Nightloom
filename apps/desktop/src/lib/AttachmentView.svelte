<script lang="ts">
  import { tip } from "./tip";
  import { app, activateTab, browseFree } from "./state.svelte";
  import { attachmentBytes, type AttachmentContent } from "./attachments.svelte";
  import * as tabs from "./tabs";
  import { viewGet, viewSet } from "./viewState";
  // Item 879: a transparent PNG/GIF/WebP with dark ink sits on white paper, readable on the dark looks.
  import { paperIfDarkInk } from "./rasterBacking";
  // Item 885: a click zooms in at that spot (again: back to fit), pinch / ctrl-wheel zoom, a drag pans; kept per tab.
  import { zoomable } from "./pictureZoomAction";

  /**
   * An attachment kept as an ordinary tab (nightshift backlog 145 pass 2):
   * the floating tab dragged onto a strip or a pane's half lands here,
   * in the pane, drawn from the same address into the chat's log. The
   * bytes are the open chat's; a tab whose chat is not the open one is a
   * card until that chat is brought forward (the log is the backend's
   * one session, blocker 182), like a chat tab that is not the live one.
   * An image fits the pane; ~~shows at its own size on a click~~ (item 885,
   * 2026-11-19) a click zooms in at that spot, a second click back to fit,
   * pinch zooms, a drag pans — kept per tab; a PDF fills it.
   */
  let { content }: { content: AttachmentContent } = $props();

  const bytes = $derived(attachmentBytes(content));
  const src = $derived(bytes ? `data:${bytes.media_type}${bytes.media_type.startsWith("text/") ? ";charset=utf-8" : ""};base64,${bytes.data}` : null);
  const open = $derived(content.session === app.activeSessionId);
  const chatName = $derived.by(() => {
    const s = app.sessions.find((x) => x.id === content.session);
    return s?.title ?? s?.first_user ?? content.session.slice(0, 8);
  });
  // Item 495, as a zoom since item 885: the zoom and pan, kept per attachment past this view.
  const zoomKey = $derived(`attachment.zoom:${content.session}:${content.turn}:${content.media}:${content.index}`);
  const kept = $derived(viewGet(zoomKey, ""));

  /** Bring the attachment's chat forward: its chat tab if there is one,
   *  else the chat lands in this pane's active tab. */
  async function openChat(): Promise<void> {
    const t = tabs.allTabs(app.tabs).find((x) => x.content.kind === "chat" && x.content.session === content.session);
    if (t) await activateTab(t.id);
    else {
      const pane = tabs.focusedPane(app.tabs);
      const landed = tabs.land(app.tabs, pane, { kind: "chat", session: content.session }, "new");
      await activateTab(landed.id);
    }
  }
</script>

{#if !open}
  <div class="attach-note">
    <div class="attach-note-title">{content.name}</div>
    <p>An attachment of <em>{chatName}</em>, which is not the open chat. Its bytes are in that chat's log.</p>
    <button class="ns-btn small" onclick={() => void openChat()} disabled={app.busy && !browseFree()}
      >{app.busy && !browseFree() ? "Opens when the running turn ends" : "Open the chat"}</button
    >
  </div>
{:else if !bytes || !src}
  <div class="attach-note">
    <div class="attach-note-title">{content.name}</div>
    <p>This attachment is no longer in the chat's log — the message was rewound or removed.</p>
  </div>
{:else if content.media === "image"}
  <div class="attach-view" data-picture-viewer use:zoomable={{ initial: kept, onchange: (v) => viewSet(zoomKey, v, "") }}>
    <img
      class="attach-view-img"
      {src}
      use:paperIfDarkInk
      alt={bytes.name}
      draggable="false"
      use:tip={"Click to zoom in there (again to fit) · pinch to zoom · drag to pan"}
    />
  </div>
{:else}
  <div class="attach-view">
    <embed class="attach-view-pdf" {src} type={bytes.media_type} title={bytes.name} />
  </div>
{/if}

<style>
  .attach-view {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: var(--well);
    overflow: hidden;
  }
  .attach-view-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: zoom-in;
    display: block;
    user-select: none;
    -webkit-user-select: none;
    -webkit-user-drag: none;
  }
  .attach-view-pdf {
    width: 100%;
    height: 100%;
    border: none;
  }
  /* The card for a tab whose bytes are not at hand: the shape of
     `App.svelte`'s `.tab-card` (a chat that is not the open one). */
  .attach-note {
    margin: auto;
    max-width: 380px;
    padding: 20px 24px;
    border: 1px dashed var(--line2);
    border-radius: 10px;
    color: var(--dim);
    font-size: 13px;
    line-height: 1.5;
  }
  .attach-note-title {
    color: var(--ink);
    font-size: 15px;
    margin-bottom: 6px;
  }
</style>
