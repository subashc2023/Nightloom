<script lang="ts">
  /**
   * A message's edit box's attachments (item 336, his "being able to attach
   * an image while editing a previous message"): the turn's own images and
   * documents as chips the moment the editor opens, × on each to remove
   * it, and an Attach button feeding the composer's own attach code
   * (`acceptFiles`) — paste and drop on the textarea feed the same code
   * from `Transcript.svelte`. The chips live in the drafts store under the
   * chat's `editDraftKey`, so they survive what the box's chips survive.
   * Drawn in the composer's chip face (same sizes and badges).
   */
  import Icon from "./Icon.svelte";
  import { app } from "./state.svelte";
  import { tip } from "./tip";
  import { badgeOf, extOf } from "./attachKinds";
  import { acceptFiles } from "./attachFiles.svelte";
  import { readDraft, removeAttachment } from "./drafts.svelte";

  let { key }: { key: string } = $props();

  const chips = $derived(readDraft(key).attachments);
  let picker = $state<HTMLInputElement | null>(null);

  function onpick(): void {
    const files = Array.from(picker?.files ?? []);
    if (picker) picker.value = "";
    if (files.length > 0) void acceptFiles(key, files);
  }
</script>

<div class="edit-attach" data-edit-attachments>
  {#each chips as a (a.id)}
    <div class="face">
      {#if a.kind === "image"}
        <img src={`data:${a.media_type};base64,${a.data}`} alt={a.name} />
      {:else}
        <span
          class="file"
          class:pending={a.pending}
          use:tip={a.label ? `${a.name} — ${a.pending ? "converting; Send waits for it" : a.label}` : a.name}
        >
          <span class="file-ext">{a.pending ? extOf(a.name).toUpperCase() : badgeOf(a)}</span>
          <span class="file-name">{a.name}</span>
          {#if a.label}<span class="file-label">{a.label}</span>{/if}
        </span>
      {/if}
      <button
        class="remove"
        type="button"
        use:tip={`remove ${a.name} from this message`}
        aria-label="remove {a.name}"
        onclick={() => removeAttachment(key, a.id)}>×</button
      >
    </div>
  {/each}
  <input bind:this={picker} type="file" accept="*/*" multiple hidden onchange={onpick} />
  <button
    class="ns-btn ghost small attach"
    type="button"
    use:tip={"Attach images or files to this message (or paste or drop them in the box)"}
    disabled={!app.connection}
    onclick={() => picker?.click()}
  >
    <Icon name="plus" /><span>Attach</span>
  </button>
</div>

<style>
  .edit-attach {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .face {
    position: relative;
    line-height: 0;
  }
  img {
    width: 4rem;
    height: 4rem;
    object-fit: cover;
    border: 1px solid var(--border);
    border-radius: 8px;
    display: block;
  }
  .file {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.2rem;
    width: 7rem;
    height: 4rem;
    padding: 0 0.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    line-height: 1.2;
  }
  .file-ext {
    font-size: 0.65rem;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .file-name,
  .file-label {
    font-size: 0.7rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-label {
    font-size: 0.62rem;
    color: var(--muted);
  }
  .file.pending .file-label {
    animation: converting 1.2s ease-in-out infinite;
  }
  @keyframes converting {
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .file.pending .file-label {
      animation: none;
    }
  }
  .remove {
    position: absolute;
    top: -0.35rem;
    right: -0.35rem;
    width: 1.15rem;
    height: 1.15rem;
    padding: 0;
    background: var(--panel);
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 50%;
    font-size: 0.8rem;
    line-height: 1;
    cursor: pointer;
  }
  .remove:hover {
    color: var(--failed);
    border-color: var(--failed);
  }
</style>
