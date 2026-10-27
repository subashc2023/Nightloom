<script lang="ts">
  // A tool result's images under its row (nightshift backlog 434): what a
  // browser screenshot showed the model, as thumbnails; a click opens one
  // full size over the window, a click or Esc closes it.
  import { tip } from "./tip";
  import { imageSrc, toolImages } from "./toolImages.svelte";

  let { session, id, name }: { session: string | null; id: string; name: string } = $props();

  const info = $derived(toolImages(session, id));
  let big = $state<string | null>(null);

  // Drawn on <body>: a row's entrance animation leaves a transform on an
  // ancestor, and a fixed layer inside a transform is fixed to it.
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
</script>

<svelte:window onkeydown={onkey} />

{#if info.status === "loading"}
  <div class="ti-wait">Loading the image…</div>
{:else if info.status === "done"}
  <div class="ti-row">
    {#each info.images as img, k (k)}
      {@const src = imageSrc(img)}
      <button
        class="ti-thumb"
        use:tip={"Click to enlarge"}
        aria-label={`Enlarge image ${k + 1} from ${name}`}
        onclick={() => (big = src)}
      >
        <img {src} alt={`What ${name} returned, image ${k + 1}`} />
      </button>
    {/each}
  </div>
  {#if info.skipped > 0}
    <div class="ti-wait">
      {info.skipped} more image{info.skipped === 1 ? "" : "s"} not shown (too large, too many, or not stored in the session).
    </div>
  {/if}
{/if}

{#if big}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="ti-over" use:portal role="dialog" aria-modal="true" aria-label="Image, full size" tabindex="-1" onclick={() => (big = null)}>
    <img src={big} alt="Full size" />
    <span class="ti-hint">Click or press Esc to close</span>
  </div>
{/if}

<style>
  .ti-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 12px 8px 40px;
  }
  .ti-thumb {
    padding: 0;
    border: 1px solid var(--line2, var(--border));
    border-radius: 8px;
    background: var(--well, var(--bg));
    overflow: hidden;
    cursor: zoom-in;
    max-width: min(100%, 520px);
    line-height: 0;
  }
  .ti-thumb:hover {
    border-color: var(--accent);
  }
  .ti-thumb img {
    display: block;
    max-width: 100%;
    max-height: 300px;
    object-fit: contain;
  }
  .ti-wait {
    margin: 0 12px 8px 40px;
    font-size: 0.75rem;
    color: var(--dim);
  }
  .ti-over {
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
  .ti-over img {
    max-width: calc(100vw - 80px);
    max-height: calc(100vh - 100px);
    object-fit: contain;
    border-radius: 6px;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.5);
  }
  .ti-hint {
    font-size: 0.75rem;
    color: rgb(255 255 255 / 0.7);
  }
</style>
