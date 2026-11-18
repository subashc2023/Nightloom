<script lang="ts">
  // Pictures and video a reply names, under its text (item 820): a plot a
  // chat saved shows here without him opening anything. Every picture —
  // an SVG included — is drawn by <img> (an SVG from a data: URL, the rest
  // from a blob URL; replyMediaStore says why), never as markup
  // in the page, so an SVG's scripts never run; a video is a player with
  // controls. A click on a picture shows it full size over the window;
  // Esc or a click closes it. The Mac and the phone share this component;
  // the loader behind `mediaState` is each one's own.
  import { tip } from "./tip";
  import { fmtSize } from "./cards";
  import type { MediaCandidate } from "./replyMedia";
  import { forgetMedia, mediaState } from "./replyMediaStore.svelte";

  let {
    items,
    chat,
    label = (c: MediaCandidate) => c.written,
    onopen,
  }: {
    items: MediaCandidate[];
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

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  function onkey(e: KeyboardEvent): void {
    if (big && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      big = null;
    }
  }

  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
</script>

<svelte:window onkeydown={onkey} />

{#if shown.length > 0}
  <div class="rm-strip" data-reply-media>
    {#each shown as { c, s } (c.path)}
      <figure class="rm-item" class:svg={/\.svg$/i.test(c.path)}>
        {#if s.status === "loading"}
          <div class="rm-wait">Loading {nameOf(c.written)}…</div>
        {:else if s.status === "done" && s.kind === "image"}
          <button class="rm-thumb" use:tip={"Click to see it full size"} aria-label={`Show ${nameOf(c.written)} full size`} onclick={() => (big = { url: s.url, c })}>
            <img src={s.url} alt={label(c)} loading="lazy" decoding="async" />
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
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="rm-over" use:portal role="dialog" aria-modal="true" aria-label="Picture, full size" tabindex="-1" onclick={() => (big = null)}>
    <img class:svg={/\.svg$/i.test(big.c.path)} src={big.url} alt={label(big.c)} />
    <span class="rm-hint">
      {label(big.c)} · Click or press Esc to close
      {#if onopen}
        {@const p = big.c.path}
        <button
          class="ns-btn small"
          onclick={(e) => {
            e.stopPropagation();
            big = null;
            onopen?.(p, e);
          }}>Open as a tab</button
        >
      {/if}
    </span>
  </div>
{/if}

<style>
  .rm-strip {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    margin: 6px 0 10px;
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
  .rm-item.svg .rm-thumb,
  .rm-over img.svg {
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
  .rm-over {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: color-mix(in srgb, black 78%, transparent);
    cursor: zoom-out;
  }
  .rm-over img {
    max-width: calc(100vw - 80px);
    max-height: calc(100vh - 110px);
    object-fit: contain;
    border-radius: 6px;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.5);
  }
  .rm-hint {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.75rem;
    color: rgb(255 255 255 / 0.75);
  }
</style>
