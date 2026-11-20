<script lang="ts">
  // A tool result's images under its row (nightshift backlog 434): what a
  // browser screenshot showed the model, as thumbnails; a click opens one
  // full size over the window (PictureViewer, item 885); a click outside it, Esc or Close closes it.
  import { tip } from "./tip";
  import { imageSrc, toolImages } from "./toolImages.svelte";
  // Item 879: a transparent PNG/GIF/WebP with dark ink sits on white paper, readable on the dark looks.
  import { paperIfDarkInk } from "./rasterBacking";
  // Item 885: full size is the shared viewer (click zooms at the spot, pinch zooms; outside/Esc/Close leaves).
  import PictureViewer from "./PictureViewer.svelte";

  let { session, id, name }: { session: string | null; id: string; name: string } = $props();

  const info = $derived(toolImages(session, id));
  let big = $state<string | null>(null);

</script>

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
        <img {src} alt={`What ${name} returned, image ${k + 1}`} use:paperIfDarkInk />
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
  <PictureViewer src={big} alt={`What ${name} returned, full size`} label={name} onclose={() => (big = null)} />
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
</style>
