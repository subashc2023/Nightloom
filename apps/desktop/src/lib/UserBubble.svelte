<script lang="ts">
  import type { Snippet } from "svelte";
  import { tip } from "./tip";
  import { badgeOf } from "./attachKinds";
  import { decodeText, pastedLabel } from "./pasteAttach";
  import { quoteNeedsRender, splitQuotes } from "./replyQuote.svelte";
  import { renderReply } from "./markdown";
  import { splitFences } from "./codeDetect";
  import { languageOf, segments } from "./codeHighlight";
  import KeepButton from "./KeepButton.svelte";
  import { imageName, keepKey, splitAttachNote } from "./keep";
  import { extOf } from "./attachKinds";
  import { keptGet, keptSet } from "./keptFolds.svelte";
  import RanCard from "./RanCard.svelte";
  import { parseRan } from "./shellRun";

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
    keep = null,
    sending = [],
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
    /** Where a text attachment's fold is kept past a chat switch (item 495
     *  part 2: the chat + turn); null, the bubble's own. */
    keep?: string | null;
    /** Item 515: the names of files for Claude Code this message carries
     *  while the backend saves them — the optimistic message has no note
     *  yet, and without these a file-only send drew an empty pill. */
    sending?: readonly string[];
  } = $props();
  /** Item 515: the note the CLI reads (`[Attached a file — saved for you
   *  …]`) is drawn as cards, never as his words; the text stays as sent. */
  const split = $derived(splitAttachNote(text));
  const said = $derived(split.said);
  const ran = $derived(parseRan(said));

  let localOpen = $state<Record<number, boolean>>({});
  /** A text attachment unfolded (284), kept under `keep` when there is one. */
  const textOpen = $derived.by<Record<number, boolean>>(() => {
    if (keep === null) return localOpen;
    const out: Record<number, boolean> = {};
    documents.forEach((_, j) => {
      if (keptGet(`${keep}|text:${j}`, false)) out[j] = true;
    });
    return out;
  });
  function flipText(j: number): void {
    if (keep === null) localOpen[j] = !localOpen[j];
    else keptSet(`${keep}|text:${j}`, !textOpen[j], false);
  }
  /** A document with bytes to show: a text one unfolds (284). */
  const isText = (d: Doc) => d.media_type.startsWith("text/") && d.data !== "";
  /** Files the Claude Code engine saved for this message (item 277), by
   *  the paths the note names: each a card (515), with Keep (306) where
   *  the chat can keep. */
  const saved = $derived(split.files);
  /** A sending file the note does not name yet. */
  const pendingNames = $derived(sending.filter((n) => !saved.some((f) => f.name === n)));
  /** A file's kind in words: `HTML file`, `PDF`. */
  function kindOf(name: string, mediaType = ""): string {
    if (mediaType === "application/pdf" || extOf(name) === "pdf") return "PDF";
    if (mediaType.startsWith("text/")) return "Text";
    const ext = extOf(name).slice(0, 8).toUpperCase();
    return ext && ext !== name.toUpperCase() ? `${ext} file` : "File";
  }
  /** A card's badge: the chip's own (`badgeOf`). */
  const fileBadge = (name: string) => extOf(name).slice(0, 5).toUpperCase() || "FILE";
</script>

<div class="user-bubble">
  <!-- A click on an attachment opens it in front (nightshift backlog 145):
       the floating tab zooms up from the thumbnail's rect, so the rect and
       the image's decoded size go with the click. -->
  {#if images.length > 0}
    <div class="user-images">
      {#each images as img, j (j)}
        <div class="user-image-col">
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
        {#if img.data}
          <KeepButton
            keyStr={keepKey(imageName(j, img.media_type), img.data)}
            name={imageName(j, img.media_type)}
            mediaType={img.media_type}
            from={{ data: img.data }}
          />
        {/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if documents.length > 0 || saved.length > 0 || pendingNames.length > 0}
    <!-- Item 515: each file he sent is a card in the hand-off card's
         language (the accent edge on the well): its kind, its name, Keep,
         and a quiet line saying what became of it. -->
    <div class="attach-cards">
      {#each documents as doc, j (j)}
        <div class="attach-card" data-attach="document">
          <div class="attach-head">
            <span class="attach-badge mono">{badgeOf({ kind: "document", ...doc })}</span>
            {#if onopendoc}
              <button
                class="attach-name"
                use:tip={`${doc.name} — open in front`}
                onclick={(e) => onopendoc?.(j, e.currentTarget.getBoundingClientRect())}>{doc.name}</button
              >
            {:else}
              <span class="attach-name" use:tip={doc.media_type || doc.name}>{doc.name}</span>
            {/if}
            {#if doc.data}
              <KeepButton keyStr={keepKey(doc.name, doc.data)} name={doc.name} mediaType={doc.media_type} from={{ data: doc.data }} />
            {/if}
          </div>
          <div class="attach-line">
            {kindOf(doc.name, doc.media_type)} · {doc.data ? (isText(doc) ? "sent with this message as text" : "sent with this message") : "attached"}
            {#if isText(doc)}
              <button
                class="user-file-toggle"
                aria-expanded={!!textOpen[j]}
                use:tip={textOpen[j] ? "Fold the text away" : "Show the text here"}
                onclick={() => flipText(j)}
                >{textOpen[j] ? "▾ hide" : `▸ ${pastedLabel(decodeText(doc.data))}`}</button
              >
            {/if}
          </div>
          {#if textOpen[j] && isText(doc)}
            <pre class="user-file-text">{decodeText(doc.data)}</pre>
          {/if}
        </div>
      {/each}
      {#each saved as f (f.path)}
        <div class="attach-card" data-attach="saved" use:tip={f.path}>
          <div class="attach-head">
            <span class="attach-badge mono">{fileBadge(f.name)}</span>
            <span class="attach-name">{f.name}</span>
            <KeepButton
              keyStr={`path|${f.path}`}
              name={f.name}
              mediaType={f.pages ? "application/pdf" : "application/octet-stream"}
              from={{ path: f.path }}
            />
          </div>
          <div class="attach-line">
            {#if f.pages}PDF · {f.pages} pages · saved for Claude to read the pages it needs with its tools{:else}{kindOf(f.name)} · saved for Claude to open with its tools{/if}
          </div>
        </div>
      {/each}
      {#each pendingNames as name (name)}
        <div class="attach-card sending" data-attach="sending">
          <div class="attach-head">
            <span class="attach-badge mono">{fileBadge(name)}</span>
            <span class="attach-name">{name}</span>
          </div>
          <div class="attach-line">{kindOf(name)} · saving for Claude to open with its tools…</div>
        </div>
      {/each}
    </div>
  {/if}
  {#if custom && body}
    {@render body()}
  {:else if ran}
    <!-- Item 503: the output of a block he ran, folded; not a wall of his. -->
    <RanCard {ran} {keep} />
  {:else if said}
    <!-- `> ` lines are quotes he placed with Reply (backlog 215), drawn as
         quotes where they sit in his words. -->
    <!-- Item 315: a ``` fenced block is drawn as code, coloured, its
         language on a label; the rest of his words stay plain text. -->
    <div class="user-text">{#each splitFences(said) as part, p (p)}{#if part.kind === "code"}<div class="user-code"><span class="user-code-lang mono">{languageOf(part.info)?.label ?? (part.info || "code")}</span><pre><code>{#each segments(part.code, part.info) as sg, j (j)}<span class={sg.cls}>{sg.text}</span>{/each}</code></pre></div>{:else}{#each splitQuotes(part.text) as seg, k (k)}{#if seg.kind === "quote" && quoteNeedsRender(seg.text)}<blockquote class="user-quote markdown rendered">{@html renderReply(seg.text)}</blockquote>{:else if seg.kind === "quote"}<blockquote class="user-quote">{seg.text}</blockquote>{:else}{seg.text}{/if}{/each}{/if}{/each}</div>
  {/if}
  {@render extra?.()}
</div>

<style>
  .user-bubble {
    /* His message block (Filament IV, item 525): a card in front — the
       raised fill with the control edge — and his colour down its right
       side, the corners squared there. ~~A rounded, borderless tint, the way
       claude.ai draws the user's turn (backlog 126)~~. An aside sets its own
       fill through `--user-bubble-bg`. */
    background: var(--user-bubble-bg, var(--raised));
    border: 1px solid var(--line2);
    border-right: 2px solid var(--accent);
    border-radius: var(--r2) 2px 2px var(--r2);
    padding: 11px 16px;
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
  /* Item 315: his fenced code, in the reply's code face. */
  .user-code {
    position: relative;
    margin: 0.35rem 0;
    border: 1px solid var(--line);
    border-radius: var(--r1);
    background: var(--term);
  }
  .user-code pre {
    margin: 0;
    padding: 1.5rem 0.75rem 0.55rem;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 0.82em;
    line-height: 1.5;
    white-space: pre;
  }
  .user-code-lang {
    position: absolute;
    top: 0.3rem;
    left: 0.75rem;
    font-family: var(--mono);
    font-size: 0.68rem;
    letter-spacing: 0.03em;
    color: var(--dim);
  }
  .user-quote {
    margin: 0.3rem 0;
    padding: 0.1rem 0 0.1rem 0.7rem;
    border-left: 3px solid var(--accent);
    color: var(--dim);
  }
  /* Item 470: a quote with maths or Markdown in it, typeset as the reply
     it came from was. */
  .user-quote.rendered {
    white-space: normal;
  }
  .user-quote.rendered :global(p) {
    margin: 0.2em 0;
  }
  .user-quote.rendered :global(.katex-display) {
    margin: 0.3em 0;
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
     not mention reads as a question about nothing. Since item 515 each file
     is a card in the hand-off card's language (app.css `.handoff-card`):
     the accent's soft border with its full edge on the left, on the well. */
  .attach-cards {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }
  .attach-cards:last-child {
    margin-bottom: 0;
  }
  .attach-card {
    box-sizing: border-box;
    min-width: 14rem;
    max-width: 100%;
    padding: 0.4rem 0.6rem 0.42rem;
    border: 1px solid var(--line2);
    border-left: 3px solid var(--accent);
    border-radius: var(--r1);
    background: var(--well);
    font-family: var(--sans);
  }
  .attach-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .attach-badge {
    flex: none;
    font-family: var(--mono);
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    color: var(--accent-ink);
  }
  .attach-name {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0;
    border: none;
    background: none;
    color: var(--ink);
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    text-align: left;
    overflow-wrap: anywhere;
  }
  button.attach-name {
    cursor: pointer;
  }
  button.attach-name:hover {
    text-decoration: underline;
    text-decoration-color: var(--accent-soft);
    text-underline-offset: 2px;
  }
  .attach-head :global(.keep) {
    flex: none;
    margin-left: auto;
  }
  .attach-line {
    margin-top: 0.12rem;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--dim);
  }
  .attach-card.sending .attach-line {
    font-style: italic;
  }
  .attach-card .user-file-text {
    margin: 0.4rem 0 0.1rem;
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
  /* Item 306: a thumbnail with Keep under it. */
  .user-image-col {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.2rem;
  }
</style>
