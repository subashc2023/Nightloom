<script lang="ts">
  import Icon from "./Icon.svelte";
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

  /**
   * How tall the box may grow before it scrolls inside itself (item 039 in
   * the nightshift repo). Unset, it is 40% of the column, so the transcript
   * keeps the other 60% however long the draft; the handle on the top edge
   * sets it by hand, and the setting is kept per machine. The floating
   * composer on the new-chat page has no transcript to balance against and
   * keeps a fixed cap.
   */
  const FLOATING_MAX = 200; // ~8 rows
  const CAP_FRACTION = 0.4;
  const CAP_MIN = 72;
  const CAP_KEY = "nightloom.composer.max";

  function loadCap(): number | null {
    try {
      const raw = localStorage.getItem(CAP_KEY);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) && n >= CAP_MIN ? n : null;
    } catch {
      return null;
    }
  }
  function saveCap(n: number | null): void {
    try {
      if (n === null) localStorage.removeItem(CAP_KEY);
      else localStorage.setItem(CAP_KEY, String(Math.round(n)));
    } catch {
      // best-effort
    }
  }

  /** The cap set by hand, or null for the 40% rule. */
  let capPx = $state<number | null>(loadCap());
  let dragging = $state(false);

  /** The column the composer shares with the transcript. */
  function columnHeight(): number {
    const col = ta?.closest(".main") as HTMLElement | null;
    return col?.clientHeight ?? window.innerHeight;
  }

  function maxHeight(): number {
    if (floating) return FLOATING_MAX;
    const auto = Math.round(columnHeight() * CAP_FRACTION);
    return Math.max(CAP_MIN, capPx ?? auto);
  }

  /**
   * The handle. Dragging up raises the cap and the box grows into it as far
   * as the draft needs; dragging down lowers it and the box scrolls sooner.
   * Double-click returns to the 40% rule.
   */
  function handleDown(e: PointerEvent) {
    if (e.button !== 0 || !ta) return;
    e.preventDefault();
    const startY = e.clientY;
    const startCap = maxHeight();
    const limit = Math.round(columnHeight() * 0.85);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (ev: PointerEvent) => {
      const next = Math.min(limit, Math.max(CAP_MIN, startCap + (startY - ev.clientY)));
      capPx = next;
      autogrow();
    };
    const up = () => {
      dragging = false;
      saveCap(capPx);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  function handleReset() {
    capPx = null;
    saveCap(null);
    autogrow();
  }

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
    const max = maxHeight();
    ta.style.maxHeight = max + "px";
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  }

  // A resized window moves the 40% line.
  $effect(() => {
    const onresize = () => autogrow();
    window.addEventListener("resize", onresize);
    return () => window.removeEventListener("resize", onresize);
  });

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

  // The Attach button: a hidden picker feeding the same `accept` the paste
  // and drop paths use. Same media types the drop accepts.
  let picker = $state<HTMLInputElement | null>(null);
  function onpick(): void {
    const files = Array.from(picker?.files ?? []);
    if (picker) picker.value = "";
    if (files.length > 0) void accept(files);
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
  {#if !floating}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="handle"
      class:dragging
      role="separator"
      aria-orientation="horizontal"
      aria-label="Composer height"
      title={capPx === null ? "Drag to set how tall the message box may grow (double-click: automatic, 40% of the column)" : `Message box may grow to ${capPx}px — double-click for automatic`}
      onpointerdown={handleDown}
      ondblclick={handleReset}
    ></div>
  {/if}
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
  <div class="card">
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
    <div class="row">
      <input
        bind:this={picker}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        onchange={onpick}
      />
      <button class="ns-btn ghost small" disabled={!app.connection} onclick={() => picker?.click()}>
        <Icon name="plus" />Attach
      </button>
      <span class="ns-chip mono keys">↵ to send · ⇧↵ newline</span>
      <span class="spacer"></span>
      {#if app.busy}
        <button class="ns-btn danger small" onclick={() => void cancelTurn()}>Stop</button>
      {:else}
        <button
          class="ns-btn accent send"
          onclick={() => void submit()}
          disabled={!app.connection || (!text.trim() && attachments.length === 0)}
        >
          Send
        </button>
      {/if}
    </div>
  </div>
  {#if !app.connection}
    <div class="hint">connect a provider to start</div>
  {:else if dragDepth > 0}
    <div class="hint">drop images or PDFs to attach</div>
  {/if}
</div>

<style>
  .composer {
    position: relative;
    background: var(--paper);
    padding: 12px 20px 22px;
  }
  /* The drag handle sits on the top edge, over the border. */
  .handle {
    position: absolute;
    top: -4px;
    left: 0;
    right: 0;
    height: 9px;
    cursor: row-resize;
    touch-action: none;
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2;
  }
  .handle::after {
    content: "";
    width: 36px;
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
    transition: background 0.12s;
  }
  .handle:hover::after,
  .handle.dragging::after {
    background: var(--accent);
  }
  .composer.floating {
    background: transparent;
    border-top: none;
    padding: 0;
    width: 100%;
  }
  .composer.dropping .card {
    border-color: var(--accent);
  }
  .composer.floating.dropping {
    background: transparent;
  }
  .composer.floating .card,
  .composer.floating .attachments,
  .composer.floating .hint {
    max-width: none;
  }
  .composer.floating textarea {
    font-size: 15.5px;
  }
  .attachments {
    max-width: 760px;
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
    color: var(--failed);
    border-color: var(--failed);
  }
  /* The mock-up's composer card: the text on top, the toolbar under it. */
  .card {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    transition: border-color 0.12s;
  }
  .card:focus-within {
    border-color: var(--accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .keys {
    font-size: 11px;
    padding: 2px 8px;
  }
  textarea {
    width: 100%;
    background: transparent;
    color: var(--ink);
    border: none;
    padding: 2px 0;
    font-size: 15px;
    font-family: inherit;
    line-height: 1.5;
    resize: none;
    overflow-y: auto;
  }
  textarea::placeholder {
    color: var(--dim);
  }
  textarea:focus {
    outline: none;
  }
  textarea:disabled {
    opacity: 0.5;
  }
  .send {
    padding: 6px 16px;
  }
  .hint {
    max-width: 760px;
    margin: 0.4rem auto 0;
    color: var(--dim);
    font-size: 0.75rem;
  }
</style>
