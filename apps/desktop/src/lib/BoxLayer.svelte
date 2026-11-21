<script module lang="ts">
  import { findFences } from "./codeDetect";
  import { hasQuoteLine } from "./replyQuote.svelte";
  import { findBoxLinks } from "./boxLinks";
  /** Whether a box with `text` draws the layer: a quote line, a fence or
   *  (item 696) a link in it. */
  export function layerShown(text: string): boolean {
    return hasQuoteLine(text) || findFences(text).length > 0 || findBoxLinks(text).length > 0;
  }
</script>

<script lang="ts">
  /*
   * The layer behind a plain message box (items 223, 315; shared since item
   * 399): the box's text drawn again under its own transparent glyphs —
   * quote lines with the bubble's bar, a fenced code block on a code ground
   * with its body coloured and a language picker on its opening fence. The
   * composer's textarea and the edit box of one of his messages both draw
   * it, so pasted or typed code looks the same in either (his 399: "if i
   * copy in code it doesnt render it as code … in the edit screen").
   *
   * It is still the textarea he types in: cursor, selection, IME, undo,
   * paste and growth are the box's. The layer copies the box's font,
   * padding and border offsets, sits on its client box, and follows its
   * size (a ResizeObserver), its scroll and its text. The owner draws it
   * only while `layerShown(text)`, and gives the textarea `color:
   * transparent` and a transparent background meanwhile.
   */
  import { tick } from "svelte";
  import { layerLines } from "./codeDetect";
  import { LANGUAGES } from "./codeHighlight";
  import { mirrorLines, quoteNeedsRender, quoteRuns } from "./replyQuote.svelte";
  import { renderReply } from "./markdown";
  import { tip } from "./tip";
  import { lineLinkSegs, openHint } from "./boxLinks";
  import { isMac } from "./platform";
  import { routeLink } from "./webtabs.svelte";

  let {
    text,
    box,
    onrelabel,
  }: {
    text: string;
    /** The textarea the layer lies under. */
    box: HTMLTextAreaElement | null;
    /** A block's language picked: the owner rewrites the fence's info string. */
    onrelabel: (k: number, lang: string) => void;
  } = $props();

  const fences = $derived(findFences(text));
  /*
   * Item 696: links drawn in the link colour, each line's pieces placed at
   * its offset in the text. The textarea on top takes every click, so a
   * link is found under the pointer by its drawn rectangles here; ⌘-click
   * (Ctrl elsewhere) opens it by the app's route, a plain click still
   * places the caret (blocker 1994).
   */
  const links = $derived(findBoxLinks(text));
  const lineStarts = $derived.by(() => {
    const out: number[] = [];
    let off = 0;
    for (const l of text.split("\n")) {
      out.push(off);
      off += l.length + 1;
    }
    return out;
  });
  /** The drawn link piece under the pointer, with ⌘ held or not. */
  let hot = $state<{ href: string; mod: boolean } | null>(null);
  let pointer: { x: number; y: number } | null = null;
  function linkUnder(x: number, y: number): string | null {
    if (!mirror) return null;
    for (const el of mirror.querySelectorAll<HTMLElement>("[data-href]")) {
      for (const r of el.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el.dataset.href ?? null;
      }
    }
    return null;
  }
  function setHot(mod: boolean): void {
    const href = pointer ? linkUnder(pointer.x, pointer.y) : null;
    const next = href ? { href, mod } : null;
    if (next?.href !== hot?.href || next?.mod !== hot?.mod) hot = next;
  }
  const codeLayer = $derived(fences.length > 0 ? layerLines(text) : []);
  let mirror = $state<HTMLDivElement | null>(null);
  let fenceTops = $state<(number | null)[]>([]);
  // Where the layer's box starts inside the owner's wrap: the textarea's
  // own border, so its text and the layer's line up (the edit box has one).
  let inset = $state({ top: 0, left: 0 });

  /*
   * Item 470: a quote with maths or Markdown in it (a reply's `$$…$$`) is
   * drawn rendered over its own lines, as the transcript draws it, while
   * the caret is outside it; the caret inside it — a click on it, the
   * arrows — shows the source again for editing. The textarea under it is
   * unchanged, so a click lands in the source where it was clicked, and the
   * text sent is the source.
   */
  const runs = $derived(quoteRuns(text).filter((r) => quoteNeedsRender(r.src)));
  let caret = $state<{ start: number; end: number } | null>(null);
  function readCaret(): void {
    if (!box || document.activeElement !== box) {
      caret = null;
      return;
    }
    const start = box.selectionStart;
    const end = box.selectionEnd;
    if (!caret || caret.start !== start || caret.end !== end) caret = { start, end };
  }
  /** Runs whose typeset form is taller than their source lines (by the
   *  run's source and its lines' height): shown as source, never clipped. */
  let tooTall = $state<Record<string, true>>({});
  const fitKey = (src: string, height: number) => `${height}|${src}`;
  /** Each shown run's place in the layer: the top and height of its lines. */
  let runBoxes = $state<({ top: number; left: number; width: number; height: number } | null)[]>([]);

  function sync(): void {
    if (!mirror || !box) return;
    const cs = getComputedStyle(box);
    const s = mirror.style;
    s.fontFamily = cs.fontFamily;
    s.fontSize = cs.fontSize;
    s.lineHeight = cs.lineHeight;
    s.letterSpacing = cs.letterSpacing;
    s.paddingTop = cs.paddingTop;
    s.paddingRight = cs.paddingRight;
    s.paddingBottom = cs.paddingBottom;
    s.paddingLeft = cs.paddingLeft;
    s.width = box.clientWidth + "px";
    s.height = box.clientHeight + "px";
    const top = box.offsetTop + box.clientTop;
    const left = box.offsetLeft + box.clientLeft;
    if (inset.top !== top || inset.left !== left) inset = { top, left };
    mirror.scrollTop = box.scrollTop;
    // Item 315: each code block's label rides on its opening fence line,
    // hidden while that line is scrolled out of the box.
    const tops: (number | null)[] = [];
    for (const el of mirror.querySelectorAll<HTMLElement>("[data-fence]")) {
      const t = el.offsetTop - mirror.scrollTop;
      tops[Number(el.dataset.fence)] = t >= 0 && t < mirror.clientHeight - 4 ? t : null;
    }
    fenceTops = tops;
    const boxes: ({ top: number; left: number; width: number; height: number } | null)[] = [];
    for (const r of runs) {
      const a = mirror.querySelector<HTMLElement>(`[data-line="${r.first}"]`);
      const b = mirror.querySelector<HTMLElement>(`[data-line="${r.last}"]`);
      boxes.push(a && b ? { top: a.offsetTop, left: a.offsetLeft, width: a.offsetWidth, height: b.offsetTop + b.offsetHeight - a.offsetTop } : null);
    }
    runBoxes = boxes;
    // A typeset quote that does not fit its lines goes back to its source.
    void tick().then(() => {
      if (!mirror) return;
      for (const el of mirror.querySelectorAll<HTMLElement>("[data-quote-render]")) {
        const k = el.dataset.fit;
        if (k && el.scrollHeight > el.clientHeight + 1 && !tooTall[k]) tooTall = { ...tooTall, [k]: true };
      }
    });
  }

  // Item 696: over a link the box says how to open it, and with ⌘ held
  // shows the pointer — set on the textarea, which is what he points at.
  $effect(() => {
    const b = box;
    if (!b) return;
    const title = b.getAttribute("title");
    b.style.cursor = hot?.mod ? "pointer" : "";
    if (hot) b.setAttribute("title", openHint(isMac));
    else b.removeAttribute("title");
    return () => {
      b.style.cursor = "";
      if (title === null) b.removeAttribute("title");
      else b.setAttribute("title", title);
    };
  });

  // The layer follows the box: its size (a drag, the 40% line, a resized
  // window, his growing text), its scroll, and its text.
  $effect(() => {
    const b = box;
    if (!b || !mirror) return;
    void text;
    const ro = new ResizeObserver(() => sync());
    ro.observe(b);
    b.addEventListener("scroll", sync, { passive: true });
    void tick().then(sync);
    // Item 470: where the caret is decides which quotes show their source.
    const caretEvents = ["focus", "blur", "select", "keyup", "mouseup", "input"] as const;
    for (const ev of caretEvents) b.addEventListener(ev, readCaret);
    document.addEventListener("selectionchange", readCaret);
    readCaret();
    // Item 696: the pointer over a drawn link, ⌘ held or not, and ⌘-click.
    const modOf = (e: MouseEvent | KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);
    const onMove = (e: MouseEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      setHot(modOf(e));
    };
    const onLeave = () => {
      pointer = null;
      setHot(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (pointer && (e.key === "Meta" || e.key === "Control")) setHot(modOf(e));
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !modOf(e)) return;
      const href = linkUnder(e.clientX, e.clientY);
      if (!href) return;
      // The click opens the link and leaves the caret where it was.
      e.preventDefault();
      e.stopPropagation();
      routeLink(href, false);
    };
    b.addEventListener("mousemove", onMove, { passive: true });
    b.addEventListener("mouseleave", onLeave);
    b.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      b.removeEventListener("mousemove", onMove);
      b.removeEventListener("mouseleave", onLeave);
      b.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      ro.disconnect();
      b.removeEventListener("scroll", sync);
      for (const ev of caretEvents) b.removeEventListener(ev, readCaret);
      document.removeEventListener("selectionchange", readCaret);
    };
  });
</script>

<div class="ta-mirror" aria-hidden="true" bind:this={mirror} style:top="{inset.top}px" style:left="{inset.left}px">{#each mirrorLines(text) as l, i (i)}{@const c = codeLayer[i]}{#if c && c.kind === "body"}<div class="ml code">{#each c.segs as sg, j (j)}<span class={sg.cls}>{sg.text}</span>{/each}{#if c.segs.length === 0}{"​"}{/if}</div>{:else if c}<div class="ml code fence" data-fence={c.kind === "open" ? c.fence : undefined}>{l.marker}{l.rest || "​"}</div>{:else}<div class="ml" class:q={l.quote} data-line={i}>{#if l.quote}<span class="qm">{l.marker}</span>{/if}{#if links.length > 0 && l.rest}{#each lineLinkSegs(l.rest, (lineStarts[i] ?? 0) + l.marker.length, links) as sg, j (j)}{#if sg.href}<span class="lk" class:hot={hot?.mod && hot.href === sg.href} data-href={sg.href}>{sg.text}</span>{:else}{sg.text}{/if}{/each}{:else if l.quote}{l.rest}{:else}{l.rest || "​"}{/if}</div>{/if}{/each}{#each runs as r, k (r.start)}{@const at = runBoxes[k]}{#if at && !tooTall[fitKey(r.src, at.height)] && !(caret && caret.end >= r.start && caret.start <= r.end)}<div class="q-render markdown" data-quote-render data-fit={fitKey(r.src, at.height)} style:top="{at.top}px" style:left="{at.left}px" style:width="{at.width}px" style:height="{at.height}px">{@html renderReply(r.src)}</div>{/if}{/each}</div>
{#each fences as f, k (k)}
  {#if fenceTops[k] != null}
    <!-- Item 315: the block's language; a pick rewrites only the
         fence's info string. -->
    <select
      class="code-lang mono"
      style:top="{inset.top + (fenceTops[k] ?? 0)}px"
      style:right="{8 + inset.left}px"
      aria-label="Code block language"
      use:tip={"The block's language — the fence's ```name"}
      value={f.lang ?? f.info}
      onmousedown={(e) => e.stopPropagation()}
      onchange={(e) => onrelabel(k, (e.currentTarget as HTMLSelectElement).value)}
    >
      {#if !f.lang}<option value={f.info}>{f.info || "code"}</option>{/if}
      {#each LANGUAGES as lg (lg.id)}<option value={lg.id}>{lg.label}</option>{/each}
    </select>
  {/if}
{/each}

<style>
  .ta-mirror {
    position: absolute;
    z-index: 0;
    overflow: hidden;
    box-sizing: border-box;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: break-word;
    pointer-events: none;
  }
  /* A quote line: the bubble's `.user-quote` look (bar, muted text), the
     bar in the gutter; the `> ` marker dimmed further but kept, so the
     characters and the caret stay where the textarea has them. */
  .ml.q {
    margin-left: -10px;
    padding-left: 10px;
    box-shadow: inset 3px 0 0 var(--accent);
    color: var(--dim);
  }
  .qm {
    opacity: 0.45;
  }
  /* Item 696: a link in the box, in the theme's link colour (a reply's
     `.markdown a` / `.ns-prose a`), a faint underline so it reads as a link
     and not as code colouring; full under the pointer with ⌘ held. Colour
     and line only: the glyphs must stay where the textarea has them. */
  .lk {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
    text-underline-offset: 2px;
  }
  .lk.hot {
    text-decoration-color: var(--accent);
  }
  /* Item 470: a quote drawn rendered over its source lines — the quote's
     bar and muted ink, the transcript's typesetting, the box's ground so
     the source under it does not show through. Typeset maths taller than
     its source lines is not drawn: the source shows instead (`tooTall`). */
  .q-render {
    position: absolute;
    box-sizing: border-box;
    padding: 0 0 0 10px;
    overflow: hidden;
    white-space: normal;
    background: var(--q-ground, var(--sheet));
    box-shadow: inset 3px 0 0 var(--accent);
    color: var(--dim);
  }
  .q-render :global(p) {
    margin: 0;
  }
  .q-render :global(.katex-display) {
    margin: 0;
    padding: 0;
  }
  /* Item 315: a fenced block in the box — a code ground under its lines
     (out into the gutter, as a quote's bar), the fence lines dimmed. The
     font stays the textarea's: the layer must match its glyphs. */
  .ml.code {
    margin-left: -10px;
    padding-left: 10px;
    background: var(--well);
  }
  .ml.fence {
    color: var(--dim);
  }
  .code-lang {
    position: absolute;
    z-index: 2;
    height: 1.35rem;
    margin-top: 0.1rem;
    padding: 0 0.3rem;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--sheet);
    color: var(--ink2);
    font-family: var(--mono);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .code-lang:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
</style>
