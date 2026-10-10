<script lang="ts">
  import { tip } from "./tip";
  /**
   * The ⌘⇧V list (nightshift backlog 173): the in-app clipboard ring,
   * newest first, joined to the composer's top the way the `/` picker is.
   * A text row shows its first lines, an image row a thumbnail; each says
   * where it came from (copied, pasted, sent) and when. The composer keeps
   * the keyboard — ↑↓ move, ↵ pastes, Esc closes — and a click pastes too.
   */
  import type { ClipEntry } from "./clipRing.svelte";
  import { exactTime, relativeTime } from "./time";

  let {
    entries,
    index,
    onpick,
  }: { entries: ClipEntry[]; index: number; onpick: (i: number) => void } = $props();

  let list = $state<HTMLElement | null>(null);
  // The row the keys are on stays in view.
  $effect(() => {
    const row = list?.querySelectorAll<HTMLElement>(".clip-row")[index];
    row?.scrollIntoView({ block: "nearest" });
  });
</script>

<div class="clip" role="listbox" aria-label="Clipboard history" bind:this={list}>
  {#if entries.length === 0}
    <div class="clip-foot">
      Nothing copied or pasted in Nightloom yet — what you copy, paste or send here is listed, newest first · Esc closes
    </div>
  {:else}
    {#each entries as e, i (e.at + i)}
      <button
        type="button"
        role="option"
        class="clip-row"
        class:on={i === index}
        aria-selected={i === index}
        use:tip={e.kind === "text" ? "Paste this at the caret" : "Attach this image again"}
        onmousedown={(ev) => ev.preventDefault()}
        onclick={() => onpick(i)}
      >
        <span class="src {e.source}">{e.source}</span>
        {#if e.kind === "text"}
          <span class="txt">{e.text}</span>
        {:else}
          <img class="thumb" src={`data:${e.media_type};base64,${e.data}`} alt={e.name} />
          <span class="txt name">{e.name}</span>
        {/if}
        <span class="when" use:tip={exactTime(e.at)}>{relativeTime(e.at)}</span>
      </button>
    {/each}
    <div class="clip-foot">↑↓ move · ↵ paste · Esc close · only what passed through Nightloom; incognito chats add nothing</div>
  {/if}
</div>

<style>
  .clip {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    background: var(--sheet);
    max-height: 18rem;
    overflow-y: auto;
  }
  .clip-row {
    display: grid;
    grid-template-columns: 58px auto 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 6px 10px;
    font-size: 12.5px;
    text-align: left;
    background: transparent;
    border: none;
    color: var(--ink);
    font-family: var(--sans);
    cursor: pointer;
    flex: none;
  }
  .clip-row.on {
    background: var(--well);
  }
  /* A text row has no thumbnail: its text takes both middle columns. */
  .clip-row .txt:not(.name) {
    grid-column: 2 / 4;
  }
  .txt {
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.35;
  }
  .txt.name {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
  }
  .thumb {
    height: 34px;
    max-width: 64px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid var(--line);
    background: var(--well);
  }
  .src {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 1px 5px;
    text-align: center;
  }
  .src.sent {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .when {
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
  }
  .clip-foot {
    padding: 5px 10px;
    color: var(--dim);
    font-size: 11.5px;
  }
</style>
