<script lang="ts">
  import { tip } from "./tip";
  import { app, activateTab } from "./state.svelte";
  import { attachmentBytes, type AttachmentContent } from "./attachments.svelte";
  import * as tabs from "./tabs";

  /**
   * An attachment kept as an ordinary tab (nightshift backlog 145 pass 2):
   * the floating tab dragged onto a strip or a pane's half lands here,
   * in the pane, drawn from the same address into the chat's log. The
   * bytes are the open chat's; a tab whose chat is not the open one is a
   * card until that chat is brought forward (the log is the backend's
   * one session, blocker 182), like a chat tab that is not the live one.
   * An image fits the pane and shows at its own size on a click; a PDF
   * fills it.
   */
  let { content }: { content: AttachmentContent } = $props();

  const bytes = $derived(attachmentBytes(content));
  const src = $derived(bytes ? `data:${bytes.media_type};base64,${bytes.data}` : null);
  const open = $derived(content.session === app.activeSessionId);
  const chatName = $derived.by(() => {
    const s = app.sessions.find((x) => x.id === content.session);
    return s?.title ?? s?.first_user ?? content.session.slice(0, 8);
  });
  let full = $state(false);

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
    <button class="ns-btn small" onclick={() => void openChat()} disabled={app.busy}
      >{app.busy ? "Opens when the running turn ends" : "Open the chat"}</button
    >
  </div>
{:else if !bytes || !src}
  <div class="attach-note">
    <div class="attach-note-title">{content.name}</div>
    <p>This attachment is no longer in the chat's log — the message was rewound or removed.</p>
  </div>
{:else if content.media === "image"}
  <div class="attach-view" class:scroll={full}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <img
      class="attach-view-img"
      class:full
      {src}
      alt={bytes.name}
      use:tip={full ? "Click to fit the pane" : "Click for the image's own size"}
      onclick={() => (full = !full)}
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
  .attach-view.scroll {
    display: block;
    overflow: auto;
  }
  .attach-view-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: zoom-in;
    display: block;
  }
  .attach-view-img.full {
    max-width: none;
    max-height: none;
    cursor: zoom-out;
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
