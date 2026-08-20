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

  // The four image types every provider we speak to accepts.
  const IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  // PDF is the only document type every vendor that takes documents at all
  // agrees on. A .txt or .md needs no envelope — paste it, or point the file
  // tools at it — so widening this would buy a second path to the same place.
  const DOCUMENTS = ["application/pdf"];

  // Anthropic rejects a base64 image over ~10 MB and a PDF over ~32 MB, and
  // nothing checks either before the wire, so the refusal has to happen here.
  // base64 inflates by 4/3, and the caps apply to the encoded payload.
  const MAX_IMAGE_BASE64 = 10 * 1024 * 1024;
  const MAX_DOCUMENT_BASE64 = 32 * 1024 * 1024;
  const encodedLimit = (n: number) => Math.floor((n / 4) * 3);

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
    return (
      file.name ||
      (file.type.startsWith("image/") ? "pasted image" : "pasted file")
    );
  }

  function kindOf(type: string): "image" | "document" | null {
    if (IMAGES.includes(type)) return "image";
    if (DOCUMENTS.includes(type)) return "document";
    return null;
  }

  async function accept(files: Iterable<File>): Promise<void> {
    // Refused here rather than at send: Claude Code takes a prompt on argv
    // and reads no attachments from us, and a chip sitting in the composer
    // is a promise the send would have to break. Named, like every other
    // refusal in here, so it does not read as a drop that silently failed.
    if (app.connection?.engine === "claude-code") {
      addToast("Claude Code takes text only — attachments are not sent on this engine");
      return;
    }
    for (const file of files) {
      const kind = kindOf(file.type);
      if (!kind) {
        addToast(
          `${describe(file)}: ${file.type || "unknown type"} not supported — png, jpeg, webp, gif or pdf only`,
        );
        continue;
      }
      const cap = kind === "image" ? MAX_IMAGE_BASE64 : MAX_DOCUMENT_BASE64;
      if (file.size > encodedLimit(cap)) {
        addToast(
          `${describe(file)} is too large — the limit is ${cap / 1024 / 1024} MB once base64-encoded (about ${Math.round(encodedLimit(cap) / 1024 / 1024)} MB of file)`,
        );
        continue;
      }
      try {
        const data = await readBase64(file);
        attachments.push({
          id: ++attachSeq,
          kind,
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
    const images = attachments
      .filter((a) => a.kind === "image")
      .map(({ media_type, data }) => ({ media_type, data }));
    const documents = attachments
      .filter((a) => a.kind === "document")
      .map(({ media_type, name, data }) => ({ media_type, name, data }));
    const empty = !t && attachments.length === 0;
    if (empty || !app.connection || app.busy) return;
    const pending = attachments;
    text = "";
    attachments = [];
    requestAnimationFrame(autogrow);
    await send(t, images, documents);
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
          {#if a.kind === "image"}
            <img src={`data:${a.media_type};base64,${a.data}`} alt={a.name} />
          {:else}
            <span class="file" title={a.name}>
              <span class="file-ext">PDF</span>
              <span class="file-name">{a.name}</span>
            </span>
          {/if}
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
    <div class="hint">drop images or PDFs to attach</div>
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
  /* A document has no thumbnail to show, so the chip carries its name — the
     one thing that tells three attachments apart. */
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
  .file-name {
    font-size: 0.7rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
