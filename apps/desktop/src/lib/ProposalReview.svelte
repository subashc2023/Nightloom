<script lang="ts">
  /**
   * The proposal card's diff, with the proposed side editable in place
   * (nightshift backlog 184). Left: the file as saved, its removed lines
   * red and a hatched pad beside each added line, read-only. Right: a text
   * box holding the proposed text, laid over a copy of itself that colours
   * the added lines green — recomputed on every keystroke, so the diff is
   * always of what the box says now. In the right side's gutter, on each
   * changed block, "keep saved" (put the file's lines back) and "take
   * proposed" (put the dream's lines back); the logic is `proposalMerge.ts`.
   *
   * The text box grows to its content (it is laid over its coloured copy,
   * which sets the height), so the two wrap identically and only the side
   * scrolls. The two sides scroll together by line: each left
   * row knows the proposed line it sits beside.
   */
  import { applyBlock, hunkActions, reviewRows } from "./proposalMerge";
  import type { HunkAction } from "./proposalMerge";

  let {
    saved,
    original,
    name,
    proposed = $bindable(),
  }: {
    saved: string;
    original: string;
    name: string;
    proposed: string;
  } = $props();

  const rows = $derived(reviewRows(saved, proposed));
  const lines = $derived(proposed.split("\n"));
  const actions = $derived(hunkActions(saved, original, proposed));
  const edited = $derived(proposed !== original);
  /** For each proposed line, the left row beside it (not a removed one). */
  const leftFor = $derived.by(() => {
    const out: number[] = [];
    rows.left.forEach((r, k) => {
      if (r.kind !== "del" && out[r.at] === undefined) out[r.at] = k;
    });
    return out;
  });

  let leftEl = $state<HTMLDivElement | null>(null);
  let rightEl = $state<HTMLDivElement | null>(null);
  let backdropEl = $state<HTMLDivElement | null>(null);
  let box = $state<HTMLTextAreaElement | null>(null);

  function act(a: HunkAction) {
    proposed = applyBlock(proposed, a.block);
  }

  // The box is exactly as tall as its copy, but for a frame after a paste
  // it can hold more and scroll itself; its own scroll must stay at 0 or
  // the text slides off the colours.
  $effect(() => {
    void lines.length;
    if (box && box.scrollTop !== 0) box.scrollTop = 0;
  });

  /** The row under `top` in a list of stacked row elements, and how far
   *  into it. */
  function rowAt(kids: HTMLCollection, top: number): { i: number; frac: number } {
    let lo = 0;
    let hi = kids.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((kids[mid] as HTMLElement).offsetTop <= top) lo = mid;
      else hi = mid - 1;
    }
    const el = kids[lo] as HTMLElement | undefined;
    if (!el) return { i: 0, frac: 0 };
    return { i: lo, frac: el.offsetHeight ? (top - el.offsetTop) / el.offsetHeight : 0 };
  }

  /** The scroll position this code last gave each side, so the scroll
   *  event that setting it raises does not bounce back to the other side.
   *  By value rather than by a timer: a scroll of his own lands somewhere
   *  else and is followed. */
  const given: { left: number | null; right: number | null } = { left: null, right: null };
  function drive(side: "left" | "right", el: HTMLElement, top: number) {
    if (Math.abs(el.scrollTop - top) < 1) return;
    el.scrollTop = top;
    given[side] = el.scrollTop;
  }
  /** Whether this scroll event is the echo of `drive`. */
  function echo(side: "left" | "right", el: HTMLElement): boolean {
    const g = given[side];
    given[side] = null;
    return g !== null && Math.abs(el.scrollTop - g) < 1;
  }

  function fromRight() {
    if (!rightEl || !leftEl || !backdropEl || echo("right", rightEl)) return;
    const { i, frac } = rowAt(backdropEl.children, rightEl.scrollTop);
    const k = leftFor[i] ?? rows.left.length - 1;
    const row = leftEl.children[k] as HTMLElement | undefined;
    if (row) drive("left", leftEl, row.offsetTop + frac * row.offsetHeight);
  }

  function fromLeft() {
    if (!rightEl || !leftEl || !backdropEl || echo("left", leftEl)) return;
    const { i, frac } = rowAt(leftEl.children, leftEl.scrollTop);
    const at = rows.left[i]?.at ?? 0;
    const row = backdropEl.children[Math.min(at, backdropEl.children.length - 1)] as HTMLElement | undefined;
    if (row) drive("right", rightEl, row.offsetTop + (rows.left[i]?.kind === "del" ? 0 : frac * row.offsetHeight));
  }
</script>

<div class="pr">
  <div class="strip">
    <span class="name">{name}</span>
    <span class="plus">+{rows.added}</span>
    <span class="minus">−{rows.removed}</span>
    {#if edited}
      <span class="edited" title="The proposed side differs from what the dream wrote">edited</span>
      <button
        class="reset"
        title="Put the proposed side back to exactly what the dream wrote"
        onclick={() => (proposed = original)}>Back to the dream's text</button
      >
    {/if}
  </div>
  <div class="cols">
    <span>as saved</span>
    <span></span>
    <span class="r">proposed — type to edit</span>
  </div>
  <div class="panes">
    <div class="side left" bind:this={leftEl} onscroll={fromLeft}>
      {#each rows.left as r, k (k)}
        <div class="line {r.kind}"><span class="no">{r.no ?? ""}</span><span class="txt">{r.text}</span></div>
      {/each}
    </div>
    <div class="vsep"></div>
    <div class="side right" bind:this={rightEl} onscroll={fromRight}>
      <div class="stack">
        <div class="backdrop" bind:this={backdropEl}>
          {#each lines as l, i (i)}
            <div class="line {rows.right[i] ?? 'ctx'}">
              <span class="gut">
                {#each actions.get(i) ?? [] as a, n (n)}
                  <button
                    class="hunk {a.kind}"
                    title={a.kind === "keep"
                      ? "Keep saved — put the file's lines back here"
                      : "Take proposed — put the dream's lines back here"}
                    aria-label={a.kind === "keep" ? `Keep saved at line ${i + 1}` : `Take proposed at line ${i + 1}`}
                    onclick={() => act(a)}>{a.kind === "keep" ? "↶" : "↷"}</button
                  >
                {/each}
                <span class="no">{i + 1}</span>
              </span>
              <span class="txt" aria-hidden="true">{l}</span>
            </div>
          {/each}
        </div>
        <textarea
          bind:this={box}
          bind:value={proposed}
          aria-label="Proposed text"
          spellcheck="false"
          rows="1"
        ></textarea>
      </div>
    </div>
  </div>
</div>

<style>
  .pr {
    --gut: 72px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line2);
    background: var(--well);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    flex: none;
  }
  .strip .name {
    color: var(--ink);
  }
  .plus {
    color: var(--done);
  }
  .minus {
    color: var(--failed);
  }
  .edited {
    color: var(--accent);
    margin-left: 6px;
  }
  .reset {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--dim);
    font-family: inherit;
    font-size: 11px;
    padding: 1px 7px;
    cursor: pointer;
  }
  .reset:hover {
    color: var(--text);
    border-color: var(--dim);
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr);
    font-size: 11px;
    color: var(--dim);
    padding: 4px 12px;
    border-bottom: 1px solid var(--line);
    font-family: var(--mono);
    flex: none;
  }
  .cols .r {
    padding-left: 12px;
  }
  .panes {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr);
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.6;
  }
  .side {
    position: relative;
    overflow: auto;
    min-height: 0;
    min-width: 0;
  }
  .vsep {
    background: var(--line2);
  }
  .line {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    min-width: 0;
  }
  .right .line {
    grid-template-columns: var(--gut) minmax(0, 1fr);
  }
  .no {
    color: var(--dim);
    text-align: right;
    padding-right: 10px;
    user-select: none;
    opacity: 0.8;
  }
  .txt {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding-right: 12px;
  }
  .line.del {
    background: var(--del-bg);
    color: var(--del-fg);
  }
  .line.add {
    background: var(--add-bg);
  }
  .line.add .no {
    color: var(--add-fg);
  }
  .line.pad {
    background: repeating-linear-gradient(45deg, transparent 0 4px, var(--well) 4px 5px);
  }
  .stack {
    position: relative;
    /* One spare line under the copy, so a new line typed at the end fits
       before the copy has grown to match. */
    padding-bottom: 1.6em;
  }
  .gut {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    gap: 2px;
  }
  .gut .no {
    padding-right: 10px;
  }
  .backdrop .txt {
    /* The box draws the text; the copy only lends its lines' colour and
       height. */
    color: transparent;
  }
  textarea {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--gut);
    right: 0;
    width: calc(100% - var(--gut));
    margin: 0;
    padding: 0 12px 0 0;
    border: none;
    outline: none;
    resize: none;
    overflow: hidden;
    background: transparent;
    color: var(--text);
    font: inherit;
    line-height: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    box-sizing: border-box;
  }
  .side.right:focus-within {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .hunk {
    width: 18px;
    height: 17px;
    margin-top: 1px;
    padding: 0;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--panel);
    font-family: system-ui, sans-serif;
    font-size: 13px;
    font-weight: 700;
    line-height: 15px;
    cursor: pointer;
    flex: none;
  }
  .hunk.keep {
    color: var(--failed);
  }
  .hunk.take {
    color: var(--done);
  }
  .hunk:hover {
    border-color: currentColor;
  }
</style>
