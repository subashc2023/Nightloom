<script lang="ts">
  import { app, addToast, send, cancelTurn } from "./state.svelte";
  import type { Attachment } from "./types";

  /**
   * `floating` drops the docked chrome (top border, panel fill) for the
   * new-chat page, where the composer sits in the middle of the pane rather
   * than at the bottom of a transcript. One component either way: a second
   * composer would be a second place to fix a paste bug.
   */
  let { floating = false }: { floating?: boolean } = $props();

  let text = $state("");
  let attachments = $state<Attachment[]>([]);
  let ta = $state<HTMLTextAreaElement | null>(null);
  // Drag events fire per element, so a boolean flickers as the pointer crosses
  // children; count enters against leaves instead.
  let dragDepth = $state(0);

  const MAX_HEIGHT = 200; // ~8 rows

  // The four types every provider we speak to accepts.
  const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  // Anthropic rejects a base64 image over ~10 MB and nothing checks it before
  // the wire, so the refusal has to happen here. base64 inflates by 4/3, and
  // the cap applies to the encoded payload.
  const MAX_BASE64_BYTES = 10 * 1024 * 1024;
  const MAX_FILE_BYTES = Math.floor((MAX_BASE64_BYTES / 4) * 3);

  let attachSeq = 0;

  function autogrow() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, MAX_HEIGHT) + "px";
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function readBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        const comma = url.indexOf(",");
        // The backend stores raw base64 and builds its own data URLs.
        resolve(comma >= 0 ? url.slice(comma + 1) : url);
      };
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function describe(file: File): string {
    return file.name || "pasted image";
  }

  async function accept(files: Iterable<File>): Promise<void> {
    for (const file of files) {
      if (!ACCEPTED.includes(file.type)) {
        addToast(
          `${describe(file)}: ${file.type || "unknown type"} not supported — png, jpeg, webp or gif only`,
        );
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        addToast(
          `${describe(file)} is too large — the limit is 10 MB once base64-encoded (about 7.5 MB of file)`,
        );
        continue;
      }
      try {
        const data = await readBase64(file);
        attachments.push({
          id: ++attachSeq,
          name: describe(file),
          media_type: file.type,
          data,
        });
      } catch (e) {
        addToast(`${describe(file)}: ${String(e)}`);
      }
    }
  }

  function onpaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    // Only swallow the paste when it carries no text of its own; some sources
    // put a screenshot and its caption on the clipboard together.
    if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
    void accept(files);
  }

  function ondragenter(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    dragDepth++;
  }

  function ondragover(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  function ondragleave() {
    if (dragDepth > 0) dragDepth--;
  }

  function ondrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    dragDepth = 0;
    void accept(files);
  }

  function remove(id: number) {
    const i = attachments.findIndex((a) => a.id === id);
    if (i >= 0) attachments.splice(i, 1);
  }

  async function submit() {
    const t = text.trim();
    const images = attachments.map(({ media_type, data }) => ({
      media_type,
      data,
    }));
    if ((!t && images.length === 0) || !app.connection || app.busy) return;
    const pending = attachments;
    text = "";
    attachments = [];
    requestAnimationFrame(autogrow);
    await send(t, images);
    // send() reports failures on app.error instead of throwing, and a turn
    // that never reached the model should not cost the user its attachments.
    if (app.error) attachments = pending;
  }
</script>

<div
  class="composer"
  class:floating
  class:dropping={dragDepth > 0}
  role="group"
  aria-label="message composer"
  {ondragenter}
  {ondragover}
  {ondragleave}
  {ondrop}
>
  {#if attachments.length > 0}
    <div class="attachments">
      {#each attachments as a (a.id)}
        <div class="attachment">
          <img src={`data:${a.media_type};base64,${a.data}`} alt={a.name} />
          <button
            class="remove"
            title="remove {a.name}"
            aria-label="remove {a.name}"
            onclick={() => remove(a.id)}>×</button
          >
        </div>
      {/each}
    </div>
  {/if}
  <div class="row">
    <textarea
      bind:this={ta}
      bind:value={text}
      rows="1"
      placeholder={app.connection ? "Message…" : ""}
      disabled={!app.connection}
      oninput={autogrow}
      {onpaste}
      {onkeydown}
    ></textarea>
    {#if app.busy}
      <button class="action stop" onclick={() => void cancelTurn()}>
        Stop
      </button>
    {:else}
      <button
        class="action"
        onclick={() => void submit()}
        disabled={!app.connection || (!text.trim() && attachments.length === 0)}
      >
        Send
      </button>
    {/if}
  </div>
  {#if !app.connection}
    <div class="hint">connect a provider to start</div>
  {:else if dragDepth > 0}
    <div class="hint">drop images to attach</div>
  {/if}
</div>

<style>
  .composer {
    background: var(--panel);
    border-top: 1px solid var(--border);
    padding: 0.75rem 1rem;
  }
  .composer.floating {
    background: transparent;
    border-top: none;
    padding: 0;
    width: 100%;
  }
  .composer.dropping {
    background: #8b7cf60f;
  }
  .composer.floating.dropping {
    background: transparent;
  }
  .composer.floating .row,
  .composer.floating .attachments,
  .composer.floating .hint {
    max-width: none;
  }
  .composer.floating textarea {
    background: var(--panel);
    padding: 0.7rem 0.9rem;
    font-size: 0.95rem;
  }
  .attachments {
    max-width: 46rem;
    margin: 0 auto 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .attachment {
    position: relative;
    line-height: 0;
  }
  .attachment img {
    width: 4rem;
    height: 4rem;
    object-fit: cover;
    border: 1px solid var(--border);
    border-radius: 8px;
    display: block;
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
    color: var(--error);
    border-color: rgba(246, 109, 124, 0.4);
  }
  .row {
    max-width: 46rem;
    margin: 0 auto;
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
  }
  textarea {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.55rem 0.75rem;
    font-size: 0.92rem;
    font-family: inherit;
    line-height: 1.45;
    resize: none;
    max-height: 200px;
    overflow-y: auto;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  textarea:disabled {
    opacity: 0.5;
  }
  .action {
    background: var(--accent);
    color: #0d0d14;
    border: none;
    border-radius: 10px;
    padding: 0.55rem 1rem;
    font-size: 0.88rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }
  .action:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .action:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .action.stop {
    background: transparent;
    color: var(--error);
    border: 1px solid rgba(246, 109, 124, 0.4);
  }
  .hint {
    max-width: 46rem;
    margin: 0.4rem auto 0;
    color: var(--dim);
    font-size: 0.75rem;
  }
</style>
