<script lang="ts">
  import type { Snippet } from "svelte";
  import { tip } from "./tip";
  import { badgeOf } from "./attachKinds";
  import { decodeText, pastedLabel } from "./pasteAttach";
  import { splitQuotes } from "./replyQuote.svelte";

  /**
   * His message's bubble (nightshift backlog 283, 2026-10-02): the chat's
   * user turn — its images, its files (a text one unfolds in place, item
   * 284), his words with the `> ` quotes he placed drawn as quotes (215) —
   * moved out of `Transcript.svelte` so an aside's questions are drawn by
   * the same piece, and a change to how the chat draws his message reaches
   * the asides with no second edit. The class names are the transcript's
   * (`.user-bubble`, `.user-text` …): the selection pill and the find bar
   * look for them.
   *
   * The transcript passes `custom` with a `body` snippet where it draws
   * the words its own way (an edit's diff, an adopted agent's run); `extra`
   * is drawn under the words (the council chip).
   */
  interface Img {
    media_type: string;
    data: string;
  }
  interface Doc {
    media_type: string;
    name: string;
    data: string;
  }
  let {
    images = [],
    documents = [],
    text = "",
    custom = false,
    body,
    extra,
    onopenimage = null,
    onopendoc = null,
  }: {
    images?: readonly Img[];
    documents?: readonly Doc[];
    text?: string;
    /** Draw `body` instead of the words. */
    custom?: boolean;
    body?: Snippet;
    extra?: Snippet;
    /** A click on a thumbnail: its index, the button's rect, the image's
     *  decoded size. Null: the thumbnail is a picture, not a button. */
    onopenimage?: ((j: number, rect: DOMRect, size: { width: number; height: number } | null) => void) | null;
    /** A click on a file chip: its index and rect. Null: a plain chip. */
    onopendoc?: ((j: number, rect: DOMRect) => void) | null;
  } = $props();

  let textOpen = $state<Record<number, boolean>>({});
  /** A document with bytes to show: a text one unfolds (284). */
  const isText = (d: Doc) => d.media_type.startsWith("text/") && d.data !== "";
</script>

<div class="user-bubble">
  <!-- A click on an attachment opens it in front (nightshift backlog 145):
       the floating tab zooms up from the thumbnail's rect, so the rect and
       the image's decoded size go with the click. -->
  {#if images.length > 0}
    <div class="user-images">
      {#each images as img, j (j)}
        {#if onopenimage}
          <button
            class="user-image-btn"
            use:tip={"Open in front"}
            onclick={(e) => {
              const el = e.currentTarget.querySelector("img");
              onopenimage?.(
                j,
                e.currentTarget.getBoundingClientRect(),
                el && el.naturalWidth > 0 ? { width: el.naturalWidth, height: el.naturalHeight } : null,
              );
            }}
          >
            <img class="user-image" src={`data:${img.media_type};base64,${img.data}`} alt="attachment" />
          </button>
        {:else}
          <img class="user-image" src={`data:${img.media_type};base64,${img.data}`} alt="attachment" />
        {/if}
      {/each}
    </div>
  {/if}
  {#if documents.length > 0}
    <div class="user-files">
      {#each documents as doc, j (j)}
        {#if onopendoc}
          <button
            class="user-file"
            use:tip={`${doc.media_type} — open in front`}
            onclick={(e) => onopendoc?.(j, e.currentTarget.getBoundingClientRect())}
          >
            <span class="user-file-ext">{badgeOf({ kind: "document", ...doc })}</span>
            {doc.name}
          </button>
        {:else}
          <span class="user-file" use:tip={doc.media_type || doc.name}>
            <span class="user-file-ext">{badgeOf({ kind: "document", ...doc })}</span>
            {doc.name}
          </span>
        {/if}
        {#if isText(doc)}
          <button
            class="user-file-toggle"
            aria-expanded={!!textOpen[j]}
            use:tip={textOpen[j] ? "Fold the text away" : "Show the text here"}
            onclick={() => (textOpen[j] = !textOpen[j])}
            >{textOpen[j] ? "▾ hide" : `▸ ${pastedLabel(decodeText(doc.data))}`}</button
          >
        {/if}
      {/each}
    </div>
    {#each documents as doc, j (j)}
      {#if textOpen[j] && isText(doc)}
        <pre class="user-file-text">{decodeText(doc.data)}</pre>
      {/if}
    {/each}
  {/if}
  {#if custom && body}
    {@render body()}
  {:else if text}
    <!-- `> ` lines are quotes he placed with Reply (backlog 215), drawn as
         quotes where they sit in his words. -->
    <div class="user-text">{#each splitQuotes(text) as seg, k (k)}{#if seg.kind === "quote"}<blockquote class="user-quote">{seg.text}</blockquote>{:else}{seg.text}{/if}{/each}</div>
  {/if}
  {@render extra?.()}
</div>

<style>
  .user-bubble {
    /* A rounded, borderless tint, the way claude.ai draws the user's turn
       (nightshift backlog 126): the old 1px line and near-square corner
       read as a box. The tint is the sheet lifted a step toward the ink so
       it holds on every palette without a token of its own. */
    background: var(--user-bubble-bg, color-mix(in srgb, var(--sheet) 88%, var(--ink)));
    border: 1px solid transparent;
    border-radius: 18px;
    padding: 12px 18px;
    max-width: var(--user-bubble-max, 560px);
    box-sizing: border-box;
    /* The reply's face, one size down: the two sides of a conversation in
       one type, with the question a little quieter than the answer. */
    font-family: var(--transcript-font, var(--sans));
    font-size: calc(var(--transcript-size, 16px) - 1px);
    line-height: 1.5;
  }
  /* pre-wrap sits on the text, not the bubble: with it on the bubble the
     markup's own newlines around the image strip would render as blank lines. */
  .user-bubble :global(.user-text) {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .user-quote {
    margin: 0.3rem 0;
    padding: 0.1rem 0 0.1rem 0.7rem;
    border-left: 3px solid var(--accent);
    color: var(--dim);
  }
  .user-images {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  .user-images:last-child {
    margin-bottom: 0;
  }
  .user-image {
    max-width: 12rem;
    max-height: 12rem;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: 8px;
    display: block;
  }
  /* The thumbnail is a button since backlog 145 (a click opens it in
     front); the button is invisible, the image is the control. */
  .user-image-btn {
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
    display: block;
    border-radius: 8px;
  }
  .user-image-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* Nothing to render of a PDF, so the turn shows what was attached rather
     than nothing at all — a caption asking about a file the transcript does
     not mention reads as a question about nothing. */
  .user-files {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
  }
  .user-files:last-child {
    margin-bottom: 0;
  }
  .user-file {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.8rem;
    word-break: break-all;
    /* A button since backlog 145 (a click opens the PDF in front), in
       the chip's own face. */
    background: none;
    color: inherit;
    font-family: inherit;
    text-align: left;
  }
  button.user-file {
    cursor: pointer;
  }
  button.user-file:hover {
    border-color: var(--line2);
  }
  /* Item 284: a text attachment's fold — its word count, a click opens it. */
  .user-file-toggle {
    align-self: center;
    padding: 0.1rem 0.35rem;
    border: none;
    background: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .user-file-toggle:hover {
    color: var(--ink);
  }
  .user-file-text {
    max-height: 24rem;
    overflow: auto;
    margin: 0 0 0.4rem;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: var(--mono);
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .user-file-ext {
    font-size: 0.62rem;
    letter-spacing: 0.05em;
    color: var(--dim);
  }
</style>
