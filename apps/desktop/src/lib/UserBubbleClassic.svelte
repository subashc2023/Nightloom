<script lang="ts">
  import { tip } from "./tip";
  import { badgeOf } from "./attachKinds";
  import { decodeText, pastedLabel } from "./pasteAttach";
  import { quoteNeedsRender, splitQuotes } from "./replyQuote.svelte";
  import { renderReply } from "./markdown";
  import { splitFences } from "./codeDetect";
  import MathText from "./MathText.svelte";
  import { languageOf, segments } from "./codeHighlight";
  import KeepButton from "./KeepButton.svelte";
  import { imageName, keepKey } from "./keep";
  import RanCard from "./RanCard.svelte";
  import AsideNoteChip from "./AsideNoteChip.svelte";
  import HandoffBubbleCard from "./HandoffBubbleCard.svelte";
  import { userBubbleLogic, type UserBubbleLogicProps } from "./userBubble/logic.svelte";
  // Item 879: a transparent PNG/GIF/WebP with dark ink sits on white paper, readable on the dark looks.
  import { paperIfDarkInk } from "./rasterBacking";

  // Item 856: the behaviour lives once, in `userBubble/logic.svelte.ts`; this file is the look.
  const props: UserBubbleLogicProps = $props();
  const T = userBubbleLogic(() => props);
</script>

<div class="user-bubble">
  <!-- A click on an attachment opens it in front (nightshift backlog 145):
       the floating tab zooms up from the thumbnail's rect, so the rect and
       the image's decoded size go with the click. -->
  {#if T.images.length > 0}
    <div class="user-images">
      {#each T.images as img, j (j)}
        <div class="user-image-col">
        {#if T.onopenimage}
          <button
            class="user-image-btn"
            use:tip={"Open in front"}
            onclick={(e) => {
              const el = e.currentTarget.querySelector("img");
              T.onopenimage?.(
                j,
                e.currentTarget.getBoundingClientRect(),
                el && el.naturalWidth > 0 ? { width: el.naturalWidth, height: el.naturalHeight } : null,
              );
            }}
          >
            <img class="user-image" src={`data:${img.media_type};base64,${img.data}`} alt="attachment" use:paperIfDarkInk />
          </button>
        {:else}
          <img class="user-image" src={`data:${img.media_type};base64,${img.data}`} alt="attachment" use:paperIfDarkInk />
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
  {#if T.documents.length > 0 || T.saved.length > 0 || T.pendingNames.length > 0}
    <!-- Item 515: each file he sent is a card in the hand-off card's
         language (the accent edge on the well): its kind, its name, Keep,
         and a quiet line saying what became of it. -->
    <div class="attach-cards">
      {#each T.documents as doc, j (j)}
        <div class="attach-card" data-attach="document">
          <div class="attach-head">
            <span class="attach-badge mono">{badgeOf({ kind: "document", ...doc })}</span>
            {#if T.onopendoc}
              <button
                class="attach-name"
                use:tip={`${doc.name} — open in front`}
                onclick={(e) => T.onopendoc?.(j, e.currentTarget.getBoundingClientRect())}>{doc.name}</button
              >
            {:else}
              <span class="attach-name" use:tip={doc.media_type || doc.name}>{doc.name}</span>
            {/if}
            {#if doc.data}
              <KeepButton keyStr={keepKey(doc.name, doc.data)} name={doc.name} mediaType={doc.media_type} from={{ data: doc.data }} />
            {/if}
          </div>
          <div class="attach-line">
            {T.kindOf(doc.name, doc.media_type)} · {doc.data ? (T.isText(doc) ? "sent with this message as text" : "sent with this message") : "attached"}
            {#if T.isText(doc)}
              <button
                class="user-file-toggle"
                aria-expanded={!!T.textOpen[j]}
                use:tip={T.textOpen[j] ? "Fold the text away" : "Show the text here"}
                onclick={() => T.flipText(j)}
                >{T.textOpen[j] ? "▾ hide" : `▸ ${pastedLabel(decodeText(doc.data))}`}</button
              >
            {/if}
          </div>
          {#if T.textOpen[j] && T.isText(doc)}
            <pre class="user-file-text">{decodeText(doc.data)}</pre>
          {/if}
        </div>
      {/each}
      {#each T.saved as f (f.path)}
        <div class="attach-card" data-attach="saved" use:tip={f.path}>
          <div class="attach-head">
            <span class="attach-badge mono">{T.fileBadge(f.name)}</span>
            <span class="attach-name">{f.name}</span>
            <KeepButton
              keyStr={`path|${f.path}`}
              name={f.name}
              mediaType={f.pages ? "application/pdf" : "application/octet-stream"}
              from={{ path: f.path }}
            />
          </div>
          <div class="attach-line">
            {#if f.pages}PDF · {f.pages} pages · saved for Claude to read the pages it needs with its tools{:else}{T.kindOf(f.name)} · saved for Claude to open with its tools{/if}
          </div>
        </div>
      {/each}
      {#each T.pendingNames as name (name)}
        <div class="attach-card sending" data-attach="sending">
          <div class="attach-head">
            <span class="attach-badge mono">{T.fileBadge(name)}</span>
            <span class="attach-name">{name}</span>
          </div>
          <div class="attach-line">{T.kindOf(name)} · saving for Claude to open with its tools…</div>
        </div>
      {/each}
    </div>
  {/if}
  {#if T.custom && T.body}
    {@render T.body()}
  {:else if T.ran}
    <!-- Item 503: the output of a block he ran, folded; not a wall of his. -->
    <RanCard ran={T.ran} keep={T.keep} />
  {:else if T.handoff}
    <!-- Item 706: a wrap-up, folded on his side; an edit makes it his words again. -->
    <HandoffBubbleCard handoff={T.handoff} keep={T.keep} classic />
  {:else if T.said}
    <!-- `> ` lines are quotes he placed with Reply (backlog 215), drawn as
         quotes where they sit in his words. -->
    <!-- Item 315: a ``` fenced block is drawn as code, coloured, its
         language on a label; the rest of his words stay plain text. -->
    <!-- Item 837: the maths in his words is typeset (`MathText`, the box's
         own reading of `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and bare LaTeX). -->
    <div class="user-text">{#each splitFences(T.said) as part, p (p)}{#if part.kind === "code"}<div class="user-code"><span class="user-code-lang mono">{languageOf(part.info)?.label ?? (part.info || "code")}</span><pre><code>{#each segments(part.code, part.info) as sg, j (j)}<span class={sg.cls}>{sg.text}</span>{/each}</code></pre></div>{:else}{#each splitQuotes(part.text) as seg, k (k)}{#if seg.kind === "quote" && quoteNeedsRender(seg.text)}<blockquote class="user-quote markdown rendered">{@html renderReply(seg.text)}</blockquote>{:else if seg.kind === "quote"}<blockquote class="user-quote">{seg.text}</blockquote>{:else}<MathText text={seg.text} />{/if}{/each}{/if}{/each}</div>
  {/if}
  {#if T.split.aside}
    <!-- Item 775: what his asides changed, told to the main chat with
         this message — a chip, never his words. -->
    <AsideNoteChip rows={T.split.aside} keep={T.keep} />
  {/if}
  {@render T.extra?.()}
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
  /* Item 315: his fenced code, in the reply's code face. */
  .user-code {
    position: relative;
    margin: 0.35rem 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--well);
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
    border: 1px solid var(--accent-soft);
    border-left: 3px solid var(--accent);
    border-radius: 8px;
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
