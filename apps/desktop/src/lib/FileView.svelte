<script lang="ts">
  import { untrack } from "svelte";
  import { tip } from "./tip";
  /**
   * A file as a tab (nightshift backlog 161, 2026-09-25): the file card's
   * *Open* under a reply. Read-only, whatever the file is — the card's path
   * is the model's choice, so this view shows and never writes (a `.md`
   * outside the notes folder is read-only too: guess pass 2026-09-25,
   * question 18; a note inside it opens in the note view instead, and never
   * reaches here). An image or a PDF draws as 145's attachment viewer does,
   * Markdown formatted with a Plain switch, any other text as it is. The
   * backend decides whether the file may be read at all (`read_file_tab`:
   * inside the chat's folders, or written by its own tools) and its refusal
   * is shown here in its own words, with Reveal beside it.
   */
  import * as api from "./api";
  import { addToast, app } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import { fmtSize } from "./cards";
  import type { TabContent } from "./tabs";
  import { fileSegments } from "./codeHighlight";
  import { firstTexError, isTexPath } from "./latexLog";
  import { viewGet, viewSet } from "./viewState";
  import HtmlPage from "./HtmlPage.svelte";
  import { fileFind } from "./fileFind.svelte";
  import { utf16Range } from "./evidenceBlock";
  import { svgBacking, withInk, type SvgBacking } from "./diagramBlock";
  // Item 879: a transparent PNG/GIF/WebP with dark ink sits on white paper, as an SVG does.
  import { paperIfDarkInk } from "./rasterBacking";
  // Item 885: a click zooms in at that spot (again: back to fit), pinch / ctrl-wheel zoom, a drag pans; kept per file.
  import { zoomable } from "./pictureZoomAction";
  import { readKitTheme } from "./pageTheme";
  import { fileChanged, fileFollow } from "./fileFollow.svelte";
  import { coalesced } from "./notesFollow";

  let { content }: { content: Extract<TabContent, { kind: "file" }> } = $props();

  let file = $state<api.FileTabData | null>(null);
  let error = $state<string | null>(null);
  // Item 495: a file's Plain/Formatted and image-size switches, kept by its
  // path past this view (a project switch, a relaunch, the kept list).
  const plainKey = $derived(`file.plain:${content.path}`);
  let plain = $state(false);
  $effect.pre(() => {
    plain = viewGet(plainKey, false);
  });
  $effect(() => viewSet(untrack(() => plainKey), plain, false));
  // Item 495, as a zoom since item 885: a picture's zoom and pan, kept per file past this view.
  const zoomKey = $derived(`file.zoom:${content.path}`);
  const kept = $derived(viewGet(zoomKey, ""));
  let reads = $state(0);

  $effect(() => {
    const path = content.path;
    const chat = content.session ?? app.activeSessionId;
    void reads;
    let stale = false;
    file = null;
    error = null;
    api
      .readFileTab(path, chat)
      .then((f) => {
        if (!stale) file = f;
      })
      .catch((e) => {
        if (!stale) error = String(e);
      });
    return () => {
      stale = true;
    };
  });

  // Item 928: the tab follows its file — it read it once on mount, so edits a
  // chat made (or another editor saved) showed only after leaving and coming
  // back. A follow read keeps what is shown until the new text arrives and
  // redraws only when it changed (no blank flash, the scroll stays).
  const follow = coalesced(async () => {
    const path = content.path;
    const chat = content.session ?? app.activeSessionId;
    try {
      const f = await api.readFileTab(path, chat);
      if (path !== content.path) return;
      if (fileChanged(untrack(() => file), f)) file = f;
      error = null;
    } catch {
      // A failed follow says nothing; Reload shows the error in its words.
    }
  });
  let seenTools = fileFollow.tools;
  let seenTurns = fileFollow.turns;
  $effect(() => {
    const tools = fileFollow.tools;
    const turns = fileFollow.turns;
    const text = untrack(() => file?.kind === "text" || file?.kind === "markdown" || file?.kind === "html");
    const due = turns !== seenTurns || (tools !== seenTools && text);
    seenTools = tools;
    seenTurns = turns;
    if (due && untrack(() => file !== null)) void follow();
  });

  // Item 567: the path as folder (dim under Filament IV) + name; drawn as
  // one run of text, so Classic, which styles neither part, is unchanged.
  const pathCut = $derived(content.path.lastIndexOf("/") + 1);
  // Item 879: an SVG file is its own document as an <img>, so its default black cannot follow the theme. One
  // with no background of its own is drawn on white paper; one drawn in `currentColor` (or light colours) gets
  // the theme's text colour — the same rule as a reply's ```svg block (`svgBacking`), redrawn on a theme change.
  const isSvgFile = $derived(file?.kind === "image" && /^image\/svg\+xml\b/i.test(file?.media_type ?? ""));
  let themeTick = $state(0);
  $effect(() => {
    if (!isSvgFile || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => themeTick++);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme", "data-palette", "data-layout"] });
    return () => mo.disconnect();
  });
  const svgShown = $derived.by((): { url: string; backing: SvgBacking } | null => {
    void themeTick;
    if (!isSvgFile || !file?.data) return null;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0)));
      const backing = svgBacking(text);
      if (backing !== "theme") return { url: `data:${file.media_type};base64,${file.data}`, backing };
      const scheme = document.documentElement.dataset.scheme === "light" ? "light" : "dark";
      const inked = withInk(text, readKitTheme(null, scheme).ink);
      return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(inked)}`, backing };
    } catch {
      return null;
    }
  });
  const src = $derived(svgShown?.url ?? (file?.data ? `data:${file.media_type};base64,${file.data}` : null));
  // Item 380: text drawn in the chat's code colours, by the file's extension
  // (plain past the highlighter's cap).
  const segs = $derived(file?.text != null ? fileSegments(file.text, content.path) : []);

  // Item 381: a `.tex` tab is split, its source left and the PDF TeX makes
  // of it right. It renders once each time the file is read: on open, and
  // on Re-render (which reads the source again first).
  const tex = $derived(file?.kind === "text" && isTexPath(content.path));
  let render = $state<api.LatexRender | null>(null);
  let renderFailed = $state<string | null>(null);
  let rendering = $state(false);
  $effect(() => {
    if (!tex || !file) return;
    const path = content.path;
    const chat = content.session ?? app.activeSessionId;
    let stale = false;
    rendering = true;
    renderFailed = null;
    api
      .renderLatex(path, chat)
      .then((r) => {
        if (!stale) render = r;
      })
      .catch((e) => {
        if (!stale) {
          render = null;
          renderFailed = String(e);
        }
      })
      .finally(() => {
        if (!stale) rendering = false;
      });
    return () => {
      stale = true;
    };
  });
  const pdfSrc = $derived(render?.pdf ? `data:application/pdf;base64,${render.pdf}` : null);
  const texError = $derived(render && !render.pdf && render.log ? firstTexError(render.log) : null);

  // Item 798: an evidence table's cell opens its source's stored text here,
  // scrolled to the quote and marked — once per request, so a later visit
  // to the tab keeps its own scroll.
  let textPre = $state<HTMLElement | null>(null);
  let foundSeq = 0;
  $effect(() => {
    const t = fileFind.target;
    const pre = textPre;
    const text = file?.text;
    if (!t || t.path !== content.path || !pre || text == null || t.seq === foundSeq) return;
    foundSeq = t.seq;
    const [a, b] = utf16Range(text, t.start, t.end);
    queueMicrotask(() => markRange(pre, a, b));
  });
  function markRange(pre: HTMLElement, a: number, b: number): void {
    const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let at = 0;
    let started = false;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const len = n.nodeValue?.length ?? 0;
      if (!started && a <= at + len) {
        range.setStart(n, Math.max(0, a - at));
        started = true;
      }
      if (started && b <= at + len) {
        range.setEnd(n, Math.max(0, b - at));
        break;
      }
      at += len;
    }
    if (!started) return;
    const hl = (globalThis as { Highlight?: new (r: Range) => unknown }).Highlight;
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    if (hl && reg) reg.set("evidence-quote", new hl(range));
    else {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    const r = range.getBoundingClientRect();
    const box = pre.getBoundingClientRect();
    pre.scrollTop += r.top - box.top - pre.clientHeight / 3;
  }

  async function reveal(): Promise<void> {
    try {
      await api.revealFile(content.path);
    } catch (e) {
      addToast(`Could not reveal: ${String(e)}`);
    }
  }
  async function openWithApp(): Promise<void> {
    try {
      await api.openFile(content.path);
    } catch (e) {
      addToast(`Could not open: ${String(e)}`);
    }
  }
</script>

<!-- Item 928: back to the window — an outside editor may have saved the file. -->
<svelte:window onfocus={() => { if (file) void follow(); }} />
<div class="file-view">
  <header class="head">
    <span class="path mono" use:tip={content.path}
      ><span class="path-dir">{content.path.slice(0, pathCut)}</span><span class="path-name">{content.path.slice(pathCut)}</span></span
    >
    {#if file}
      <span class="meta mono">
        {fmtSize(file.size)} · read-only{file.via === "written" ? " · written by this chat's tools, outside its folders" : ""}
      </span>
    {/if}
    <span class="spacer"></span>
    {#if file?.kind === "html"}
      <!-- Item 819: Page (the default) or Source, kept by the file's path as
           Plain/Formatted is; `plain` is Source. -->
      <button
        class="ns-btn ghost small"
        onclick={() => (plain = !plain)}
        use:tip={plain ? "Draw the page" : "Show the HTML source"}>{plain ? "Page" : "Source"}</button
      >
    {/if}
    {#if file?.kind === "markdown"}
      <button class="ns-btn ghost small" onclick={() => (plain = !plain)} use:tip={"Show the Markdown source or the formatted text"}
        >{plain ? "Formatted" : "Plain"}</button
      >
    {/if}
    {#if tex && !render?.missing_tex}
      <button
        class="ns-btn ghost small"
        disabled={rendering}
        onclick={() => reads++}
        use:tip={"Read the source again and compile it with TeX"}>{rendering ? "Rendering…" : "Re-render"}</button
      >
    {/if}
    <button class="ns-btn ghost small" onclick={() => reads++} use:tip={"Read the file again"}>Reload</button>
    <button class="ns-btn ghost small" onclick={() => void reveal()} use:tip={"Show in the file manager"}>Reveal</button>
  </header>
  {#if error}
    <div class="note-card">
      <p>{error}</p>
      <button class="ns-btn small" onclick={() => void reveal()}>Reveal in the Finder</button>
    </div>
  {:else if !file}
    <p class="dim">Reading…</p>
  {:else if file.kind === "image" && src}
    <div class="media" data-picture-viewer use:zoomable={{ initial: kept, onchange: (v) => viewSet(zoomKey, v, "") }}>
      <img
        class="img"
        class:paper={svgShown?.backing === "paper"}
        {src}
        use:paperIfDarkInk
        alt={content.path}
        draggable="false"
        use:tip={"Click to zoom in there (again to fit) · pinch to zoom · drag to pan"}
      />
    </div>
  {:else if file.kind === "pdf" && src}
    <div class="media">
      <embed class="pdf" {src} type={file.media_type} title={content.path} />
    </div>
  {:else if file.kind === "html" && !plain}
    <HtmlPage html={file.text ?? ""} place={`file:${content.path}`} title={content.path} />
  {:else if file.kind === "markdown" && !plain}
    <div class="body markdown">{@html renderMarkdown(file.text ?? "")}</div>
  {:else if tex && !render?.missing_tex}
    <div class="tex-wrap">
      <div class="tex-split">
        <pre class="body text mono"><code>{#each segs as sg, j (j)}<span class={sg.cls}>{sg.text}</span>{/each}</code></pre>
        <div class="tex-out">
          {#if pdfSrc}
            {#key pdfSrc}<embed class="pdf" src={pdfSrc} type="application/pdf" title={`${content.path} rendered`} />{/key}
          {:else if rendering}
            <p class="dim">Rendering with TeX…</p>
          {:else if renderFailed}
            <div class="tex-error"><p>{renderFailed}</p></div>
          {:else if render}
            <div class="tex-error">
              {#if texError}
                <p class="tex-error-title">TeX stopped{texError.line != null ? ` at line ${texError.line}` : ""}:</p>
                <pre class="mono">! {texError.message}{texError.line != null ? `\nl.${texError.line} ${texError.context ?? ""}` : ""}</pre>
              {:else}
                <p class="tex-error-title">TeX did not make a PDF:</p>
                <pre class="mono">{render.message ?? "no error line in its log"}</pre>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  {:else if file.kind === "markdown" || file.kind === "text" || file.kind === "html"}
    {#if tex && render?.missing_tex}
      <p class="tex-note">No TeX is installed on this Mac (Nightloom looks in /Library/TeX/texbin, where MacTeX puts it), so only the source is shown.</p>
    {/if}
    <pre class="body text mono" bind:this={textPre}><code>{#each segs as sg, j (j)}<span class={sg.cls}>{sg.text}</span>{/each}</code></pre>
  {:else}
    <div class="note-card">
      <p>Nightloom does not draw this kind of file. Its own application can open it.</p>
      <button class="ns-btn small" onclick={() => void openWithApp()}>Open with its application</button>
    </div>
  {/if}
</div>

<style>
  .file-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    flex: none;
    min-width: 0;
  }
  .path {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .meta {
    font-size: 11.5px;
    color: var(--dim);
    white-space: nowrap;
    flex: none;
  }
  .spacer {
    flex: 1;
  }
  .mono {
    font-family: var(--mono);
  }
  .dim {
    color: var(--dim);
    padding: 16px;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin: 0;
    padding: 16px 24px 40px;
  }
  .text {
    font-size: 12.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .text code {
    font: inherit;
  }
  .media {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: var(--well);
    overflow: hidden;
  }
  .img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: zoom-in;
    display: block;
  }
  /* Item 879: an SVG with default (black) lines and no background of its own, on white paper. */
  .img.paper {
    background: #fff;
    padding: 10px;
    border-radius: 6px;
    box-sizing: border-box;
  }
  .pdf {
    width: 100%;
    height: 100%;
    border: none;
  }
  /* Item 381: source | PDF, half and half; stacked (source above) when the
     pane is narrower than 640 px, as a 700 pt window's pane is. */
  .tex-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    container-type: inline-size;
  }
  .tex-split {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .tex-split > .body {
    border-right: 1px solid var(--line);
  }
  @container (max-width: 639px) {
    .tex-split {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
    }
    .tex-split > .body {
      border-right: none;
      border-bottom: 1px solid var(--line);
    }
  }
  .tex-out {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--well);
  }
  .tex-error {
    margin: 16px;
    padding: 14px 18px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--bg);
    font-size: 13px;
    color: var(--ink);
    overflow: auto;
  }
  .tex-error-title {
    margin: 0 0 8px;
  }
  .tex-error pre {
    margin: 0;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--del-fg);
  }
  .tex-note {
    margin: 0;
    padding: 10px 24px 0;
    font-size: 12.5px;
    color: var(--dim);
  }
  .note-card {
    margin: 32px auto;
    max-width: 440px;
    padding: 20px 24px;
    border: 1px dashed var(--line2);
    border-radius: 10px;
    color: var(--dim);
    font-size: 13px;
    line-height: 1.5;
  }

  /* Item 567 (Filament IV stage 10): the head as the browser's bar — a
     panel band, the folder dim and the name in the text colour, the meta
     in mono; the source on the code ground; images and PDFs on it too.
     Filament IV only (item 542's gate); Classic keeps the rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .head {
    padding: 8px 14px 8px 16px;
    min-height: 46px;
    box-sizing: border-box;
    background: var(--sheet);
  }
  :global(:where(:root:not([data-layout="classic"]))) .path {
    font-size: 12.5px;
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .path-dir {
    color: var(--dim);
  }
  :global(:where(:root:not([data-layout="classic"]))) .meta {
    font-size: 11px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .body.text {
    background: var(--term);
    line-height: 1.6;
  }
  :global(:where(:root:not([data-layout="classic"]))) .media,
  :global(:where(:root:not([data-layout="classic"]))) .tex-out {
    background: var(--term);
  }
  :global(:where(:root:not([data-layout="classic"]))) .note-card {
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    background: var(--raised);
  }
  :global(:where(:root:not([data-layout="classic"]))) .tex-error {
    border-radius: var(--r1);
    background: var(--raised);
  }
</style>
