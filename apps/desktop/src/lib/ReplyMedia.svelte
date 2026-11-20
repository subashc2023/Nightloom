<script lang="ts">
  // Pictures and video a reply names, under its text (item 820): a plot a
  // chat saved shows here without him opening anything. Every picture —
  // an SVG included — is drawn by <img> (an SVG from a data: URL, the rest
  // from a blob URL; replyMediaStore says why), never as markup
  // in the page, so an SVG's scripts never run; a video is a player with
  // controls. A click on a picture shows it full size over the window
  // (PictureViewer, item 885); Esc, Close or a click outside it closes it. The Mac and the phone share this component;
  // the loader behind `mediaState` is each one's own.
  import { tip } from "./tip";
  import { fmtSize } from "./cards";
  import type { MediaCandidate } from "./replyMedia";
  import { forgetMedia, mediaState } from "./replyMediaStore.svelte";
  // Item 879: a transparent picture with dark ink sits on white paper (the SVGs here already do).
  import { paperIfDarkInk } from "./rasterBacking";
  // Item 885: full size is the shared viewer — a click on the picture zooms there, pinch zooms, only outside/Esc/Close leaves.
  import PictureViewer from "./PictureViewer.svelte";

  let {
    items,
    chat,
    label = (c: MediaCandidate) => c.written,
    onopen,
    inline = false,
  }: {
    items: MediaCandidate[];
    /** Item 875: drawn where the reply placed it (one picture, inside the text), not in the strip under it. */
    inline?: boolean;
    chat: string | null;
    label?: (c: MediaCandidate) => string;
    /** Open the file as a tab (the Mac); absent on the phone. */
    onopen?: (path: string, e?: MouseEvent) => void;
  } = $props();

  const rows = $derived(items.map((c) => ({ c, s: mediaState(c.path, chat) })));
  // A bare path that is not there, or that the Mac would not read, is just
  // text in the reply; only a markdown image says it meant to be shown.
  const shown = $derived(rows.filter(({ c, s }) => s.status !== "failed" || c.explicit));
  let big = $state<{ url: string; c: MediaCandidate } | null>(null);

  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
</script>

{#if shown.length > 0}
  <div class="rm-strip" class:inline data-reply-media={inline ? "inline" : "strip"}>
    {#each shown as { c, s } (c.path)}
      <figure class="rm-item" class:svg={/\.svg$/i.test(c.path)}>
        {#if s.status === "loading"}
          <div class="rm-wait">Loading {nameOf(c.written)}…</div>
        {:else if s.status === "done" && s.kind === "image"}
          <button class="rm-thumb" use:tip={"Click to see it full size"} aria-label={`Show ${nameOf(c.written)} full size`} onclick={() => (big = { url: s.url, c })}>
            <img src={s.url} alt={label(c)} loading="lazy" decoding="async" use:paperIfDarkInk />
          </button>
        {:else if s.status === "done"}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video class="rm-video" src={s.url} controls preload="metadata" playsinline></video>
        {:else if s.status === "big"}
          <div class="rm-line">{nameOf(c.written)} is {fmtSize(s.size)} — too large to show here.</div>
        {:else if s.status === "failed"}
          <div class="rm-line">
            {nameOf(c.written)}: {s.message}
            <button class="ns-btn ghost small" onclick={() => forgetMedia(c.path, chat)}>Retry</button>
          </div>
        {/if}
        {#if s.status === "done" || s.status === "big"}
          <figcaption class="rm-cap">
            <span class="rm-name" use:tip={c.path}>{label(c)}</span>
            <span class="rm-size">{fmtSize(s.size)}</span>
            {#if onopen}
              <button class="ns-btn ghost small" use:tip={"Open as a tab here — ⌘-click opens it with its application"} onclick={(e) => onopen?.(c.path, e)}>Open</button>
            {/if}
          </figcaption>
        {/if}
      </figure>
    {/each}
  </div>
{/if}

{#if big}
  {@const p = big.c.path}
  <PictureViewer src={big.url} alt={label(big.c)} label={label(big.c)} svg={/\.svg$/i.test(p)} onclose={() => (big = null)}>
    {#snippet actions()}
      {#if onopen}
        <button
          class="ns-btn small"
          onclick={(e) => {
            e.stopPropagation();
            big = null;
            onopen?.(p, e);
          }}>Open as a tab</button
        >
      {/if}
    {/snippet}
  </PictureViewer>
{/if}

<style>
  .rm-strip {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    margin: 6px 0 10px;
  }
  /* Item 875: in place, inside the reply's paragraph. */
  .rm-strip.inline {
    margin: 6px 0;
  }
  .rm-item {
    margin: 0;
    max-width: min(100%, 640px);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .rm-thumb {
    padding: 0;
    border: 1px solid var(--line2, var(--border));
    border-radius: 8px;
    background: var(--well, var(--bg));
    overflow: hidden;
    cursor: zoom-in;
    line-height: 0;
    max-width: 100%;
  }
  /* A plot's SVG is usually drawn on no background at all: on the dark
     look its black axes would vanish, so it sits on paper. */
  .rm-item.svg .rm-thumb {
    background: #fff;
  }
  .rm-thumb:hover {
    border-color: var(--accent);
  }
  .rm-thumb img {
    display: block;
    max-width: 100%;
    max-height: 360px;
    object-fit: contain;
  }
  .rm-video {
    display: block;
    max-width: 100%;
    max-height: 360px;
    border-radius: 8px;
    border: 1px solid var(--line2, var(--border));
    background: black;
  }
  .rm-cap {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.75rem;
    color: var(--dim);
    min-width: 0;
  }
  .rm-name {
    font-family: var(--mono, ui-monospace, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .rm-wait,
  .rm-line {
    font-size: 0.75rem;
    color: var(--dim);
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
