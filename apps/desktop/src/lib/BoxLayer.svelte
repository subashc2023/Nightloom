<script module lang="ts">
  import { findFences } from "./codeDetect";
  import { hasQuoteLine } from "./replyQuote.svelte";
  /** Whether a box with `text` draws the layer: a quote line or a fence in it. */
  export function layerShown(text: string): boolean {
    return hasQuoteLine(text) || findFences(text).length > 0;
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
  import { mirrorLines } from "./replyQuote.svelte";
  import { tip } from "./tip";

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
  const codeLayer = $derived(fences.length > 0 ? layerLines(text) : []);
  let mirror = $state<HTMLDivElement | null>(null);
  let fenceTops = $state<(number | null)[]>([]);
  // Where the layer's box starts inside the owner's wrap: the textarea's
  // own border, so its text and the layer's line up (the edit box has one).
  let inset = $state({ top: 0, left: 0 });

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
  }

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
    return () => {
      ro.disconnect();
      b.removeEventListener("scroll", sync);
    };
  });
</script>

<div class="ta-mirror" aria-hidden="true" bind:this={mirror} style:top="{inset.top}px" style:left="{inset.left}px">{#each mirrorLines(text) as l, i (i)}{@const c = codeLayer[i]}{#if c && c.kind === "body"}<div class="ml code">{#each c.segs as sg, j (j)}<span class={sg.cls}>{sg.text}</span>{/each}{#if c.segs.length === 0}{"​"}{/if}</div>{:else if c}<div class="ml code fence" data-fence={c.kind === "open" ? c.fence : undefined}>{l.marker}{l.rest || "​"}</div>{:else}<div class="ml" class:q={l.quote}>{#if l.quote}<span class="qm">{l.marker}</span>{l.rest}{:else}{l.rest || "​"}{/if}</div>{/if}{/each}</div>
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
