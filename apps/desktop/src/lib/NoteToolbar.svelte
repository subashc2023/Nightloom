<script lang="ts">
  import { hudIn, hudOut } from "./hudMenu";
  /**
   * The note's toolbar (item 498, his reference shot): text style, code,
   * table, image, checklist, Insert +, and at the end the Markdown switch.
   * Every button writes ordinary Markdown through the one editor
   * (`noteFormat.ts`), one undo step each, in the formatted view and the
   * Markdown view alike. A button's mousedown is held back so the editor
   * keeps its focus and its selection while the button is pressed.
   */
  import { tip } from "./tip";
  import Icon from "./Icon.svelte";
  import { floatMenu } from "./floatMenu";
  import {
    blockStyleAt,
    codeAction,
    insertDivider,
    insertFormula,
    insertLink,
    insertTable,
    insertWikilink,
    setBlockStyle,
    toggleChecklist,
    toggleInline,
    type BlockStyle,
    type Command,
  } from "./noteFormat";
  import type { EditorState } from "@codemirror/state";

  let {
    run,
    current,
    markdown = false,
    onmarkdown,
    canImage = true,
    imageWhy = "",
    onimage,
    disabled = false,
  }: {
    /** Apply an action in the editor. */
    run: (cmd: Command) => void;
    /** The editor's state now, for the Text style menu's tick. */
    current: () => EditorState | null;
    markdown?: boolean;
    onmarkdown?: (on: boolean) => void;
    canImage?: boolean;
    /** Why Image is off, when it is. */
    imageWhy?: string;
    onimage?: (file: File) => void;
    disabled?: boolean;
  } = $props();

  type MenuName = "style" | "insert";
  let menu = $state<MenuName | null>(null);
  let styleBtn = $state<HTMLButtonElement | null>(null);
  let insertBtn = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let picker = $state<HTMLInputElement | null>(null);
  let styleNow = $state<BlockStyle>("normal");

  function hold(e: MouseEvent) {
    e.preventDefault();
  }

  function toggleMenu(name: MenuName) {
    if (menu === name) {
      menu = null;
      return;
    }
    if (name === "style") {
      const s = current();
      styleNow = s ? blockStyleAt(s) : "normal";
    }
    menu = name;
  }

  function pick(cmd: Command) {
    menu = null;
    run(cmd);
  }

  function onDocDown(e: MouseEvent) {
    const t = e.target as Node;
    if (styleBtn?.contains(t) || insertBtn?.contains(t) || menuEl?.contains(t)) return;
    menu = null;
  }
  $effect(() => {
    if (!menu) return;
    document.addEventListener("mousedown", onDocDown, true);
    return () => document.removeEventListener("mousedown", onDocDown, true);
  });

  function menuKeys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const back = menu === "style" ? styleBtn : insertBtn;
      menu = null;
      back?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(menuEl?.querySelectorAll<HTMLButtonElement>("button.it") ?? []);
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    }
  }
  /** Opened from the keyboard: the first item takes the focus. */
  function openKeys(e: KeyboardEvent, name: MenuName) {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    if (menu !== name) toggleMenu(name);
    queueMicrotask(() => menuEl?.querySelector<HTMLButtonElement>("button.it")?.focus());
  }

  function choose() {
    if (!canImage) return;
    picker?.click();
  }
  function onpick() {
    const f = picker?.files?.[0];
    if (picker) picker.value = "";
    if (f) onimage?.(f);
  }

  function flip() {
    onmarkdown?.(!markdown);
  }

  const STYLES: { style: BlockStyle; label: string; cls: string }[] = [
    { style: "normal", label: "Normal text", cls: "s-normal" },
    { style: "h1", label: "Heading 1", cls: "s-h1" },
    { style: "h2", label: "Heading 2", cls: "s-h2" },
    { style: "h3", label: "Heading 3", cls: "s-h3" },
  ];
</script>

<div class="toolbar" role="toolbar" aria-label="Formatting">
  <button
    class="tb"
    class:on={menu === "style"}
    bind:this={styleBtn}
    aria-label="Text style"
    aria-haspopup="menu"
    aria-expanded={menu === "style"}
    use:tip={menu === "style" ? null : "Text style: headings, bold, italic, strikethrough, quote"}
    onmousedown={hold}
    onclick={() => toggleMenu("style")}
    onkeydown={(e) => openKeys(e, "style")}
    {disabled}><span class="ico"><Icon name="textstyle" size={16} /></span><span class="lbl">Style</span><span class="chev"><Icon name="chev" size={11} /></span></button
  >
  <!-- Item 565: Bold and Italic on the bar under Filament IV (f4-notes.png);
       Classic reaches them in the Style menu, as before. -->
  <button
    class="tb fiv b"
    aria-label="Bold"
    use:tip={{ text: "Bold", keys: "⌘B" }}
    onmousedown={hold}
    onclick={() => run(toggleInline("bold"))}
    {disabled}>B</button
  >
  <button
    class="tb fiv i"
    aria-label="Italic"
    use:tip={{ text: "Italic", keys: "⌘I" }}
    onmousedown={hold}
    onclick={() => run(toggleInline("italic"))}
    {disabled}>I</button
  >
  <button
    class="tb"
    aria-label="Code"
    use:tip={"Code: inline on a selection in one line, a code block otherwise"}
    onmousedown={hold}
    onclick={() => run(codeAction)}
    {disabled}><Icon name="code" size={16} /></button
  >
  <span class="vr"></span>
  <button
    class="tb"
    aria-label="Table"
    use:tip={"Insert a table (3 columns, a header and two rows)"}
    onmousedown={hold}
    onclick={() => run(insertTable)}
    {disabled}><span class="ico"><Icon name="table" size={16} /></span><span class="lbl">Table</span></button
  >
  <button
    class="tb"
    aria-label="Image"
    use:tip={canImage ? "Insert an image: it is copied into attachments/ beside the note" : imageWhy}
    onmousedown={hold}
    onclick={choose}
    disabled={disabled || !canImage}><span class="ico"><Icon name="image" size={16} /></span><span class="lbl">Image</span></button
  >
  <button
    class="tb"
    aria-label="Checklist"
    use:tip={"Checklist: the selected lines become to-do items (again to undo them)"}
    onmousedown={hold}
    onclick={() => run(toggleChecklist)}
    {disabled}><span class="ico"><Icon name="checklist" size={16} /></span><span class="lbl">Checklist</span></button
  >
  <span class="vr"></span>
  <button
    class="tb"
    class:on={menu === "insert"}
    bind:this={insertBtn}
    aria-label="Insert"
    aria-haspopup="menu"
    aria-expanded={menu === "insert"}
    use:tip={menu === "insert" ? null : "Insert a link, a note link, a formula or a divider"}
    onmousedown={hold}
    onclick={() => toggleMenu("insert")}
    onkeydown={(e) => openKeys(e, "insert")}
    {disabled}><span class="ico"><Icon name="plus" size={16} /></span><span class="lbl">Insert</span><span class="chev"><Icon name="chev" size={11} /></span></button
  >
  <span class="spacer"></span>
  <button
    class="tb md"
    class:on={markdown}
    aria-pressed={markdown}
    use:tip={markdown
      ? "Showing the Markdown as written — click to go back to the formatted view"
      : "Markdown: show and edit the note's raw Markdown, every mark visible"}
    onmousedown={hold}
    onclick={flip}
    {disabled}><span class="ico"><Icon name="markdown" size={15} /></span><i class="fiv sw" aria-hidden="true"></i><span class="md-label">Markdown</span></button
  >
  <input bind:this={picker} class="picker" type="file" accept="image/*" hidden onchange={onpick} />
</div>

{#if menu}
  <div
    class="tb-menu hud-m"
    role="menu"
    in:hudIn|global
    out:hudOut|global
    tabindex="-1"
    aria-label={menu === "style" ? "Text style" : "Insert"}
    bind:this={menuEl}
    use:floatMenu={{ anchor: menu === "style" ? styleBtn : insertBtn, align: "left" }}
    onkeydown={menuKeys}
  >
    <p class="fiv cap" aria-hidden="true">{menu === "style" ? "Text style" : "Insert"}</p>
    {#if menu === "style"}
      {#each STYLES as s (s.style)}
        <button
          type="button"
          class="it {s.cls}"
          role="menuitemradio"
          aria-checked={styleNow === s.style}
          onmousedown={hold}
          onclick={() => pick(setBlockStyle(s.style))}
          ><span class="tick">{styleNow === s.style ? "✓" : ""}</span>{s.label}</button
        >
      {/each}
      <div class="sep" role="separator"></div>
      <button type="button" class="it" role="menuitem" onmousedown={hold} onclick={() => pick(toggleInline("bold"))}
        ><span class="tick"></span><strong>Bold</strong><span class="kbd">⌘B</span></button
      >
      <button type="button" class="it" role="menuitem" onmousedown={hold} onclick={() => pick(toggleInline("italic"))}
        ><span class="tick"></span><em>Italic</em><span class="kbd">⌘I</span></button
      >
      <button type="button" class="it" role="menuitem" onmousedown={hold} onclick={() => pick(toggleInline("strike"))}
        ><span class="tick"></span><s>Strikethrough</s></button
      >
      <button
        type="button"
        class="it"
        role="menuitemradio"
        aria-checked={styleNow === "quote"}
        onmousedown={hold}
        onclick={() => pick(setBlockStyle("quote"))}
        ><span class="tick">{styleNow === "quote" ? "✓" : ""}</span><span class="q">Quote</span></button
      >
    {:else}
      <button type="button" class="it" role="menuitem" onmousedown={hold} onclick={() => pick(insertLink)}
        ><Icon name="link" size={14} />Link <span class="hint">[text](url)</span></button
      >
      <button type="button" class="it" role="menuitem" onmousedown={hold} onclick={() => pick(insertWikilink)}
        ><Icon name="note" size={14} />Note link <span class="hint">[[note]]</span></button
      >
      <button type="button" class="it" role="menuitem" onmousedown={hold} onclick={() => pick(insertFormula)}
        ><span class="glyph">∑</span>Formula <span class="hint">$x$</span></button
      >
      <button type="button" class="it" role="menuitem" onmousedown={hold} onclick={() => pick(insertDivider)}
        ><span class="glyph">—</span>Divider <span class="hint">---</span></button
      >
    {/if}
  </div>
{/if}

<style>
  /* Item 498: a row under the top row, on the page's background, in the
     tool cluster's colours (496's head); it stays put while the note
     scrolls under it, as in his shot. */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0.25rem clamp(1.2rem, 4.5cqi, 2.6rem) 0.35rem;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    flex-shrink: 0;
    min-width: 0;
    container: toolbar / inline-size;
  }
  .tb {
    border: 0;
    background: none;
    color: var(--ink2, var(--dim));
    font-family: inherit;
    font-size: 0.74rem;
    padding: 0.32rem 0.45rem;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .tb:hover:not(:disabled) {
    color: var(--ink, var(--text));
    background: var(--well);
  }
  .tb.on {
    background: var(--well);
    color: var(--ink, var(--text));
  }
  .tb:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tb .chev {
    display: inline-flex;
    color: var(--dim);
    margin-left: -1px;
  }
  .tb.md {
    gap: 0.35rem;
    padding: 0.32rem 0.6rem;
  }
  .tb.md.on {
    color: var(--accent);
  }
  .vr {
    width: 1px;
    height: 18px;
    background: var(--line);
    margin: 0 5px;
    flex-shrink: 0;
  }
  .spacer {
    flex: 1;
  }
  .picker {
    display: none;
  }
  @container toolbar (max-width: 360px) {
    .md-label {
      display: none;
    }
  }
  .tb-menu {
    position: fixed;
    z-index: 60;
    min-width: 13rem;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    padding: 5px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
  }
  .tb-menu .it {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 6px;
    color: var(--ink2);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.42rem 0.6rem;
    cursor: pointer;
  }
  .tb-menu .it:hover,
  .tb-menu .it:focus-visible {
    background: var(--well);
    color: var(--ink);
    outline: none;
  }
  .tb-menu .tick {
    width: 0.9rem;
    color: var(--accent);
    flex-shrink: 0;
  }
  .tb-menu .s-h1 {
    font-size: 1.05rem;
    font-weight: 600;
  }
  .tb-menu .s-h2 {
    font-size: 0.95rem;
    font-weight: 600;
  }
  .tb-menu .s-h3 {
    font-size: 0.86rem;
    font-weight: 600;
  }
  .tb-menu .q {
    border-left: 2px solid var(--line2);
    padding-left: 0.45rem;
  }
  .tb-menu .kbd,
  .tb-menu .hint {
    margin-left: auto;
    color: var(--dim);
    font-size: 0.7rem;
    font-family: var(--mono);
  }
  .tb-menu .glyph {
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .tb-menu .sep {
    height: 1px;
    background: var(--line);
    margin: 4px 2px;
  }

  /* ---- Filament IV (item 565, stage 8; f4-notes.png, f4-notesmenus.png) ----
     Words on the buttons, each a control in the shared grammar (fill, edge,
     28px); Bold and Italic on the bar; the Markdown switch drawn as a
     switch; the menus with a ruled capital title. The added words, B and
     I, the switch and the title are hidden by the base rule, so Classic
     looks as it did; the rest is behind the layout gate. */
  .lbl,
  .fiv {
    display: none;
  }
  .ico {
    display: inline-flex;
  }
  :global(:where(:root:not([data-layout="classic"]))) .lbl {
    display: inline;
  }
  :global(:where(:root:not([data-layout="classic"]))) .fiv {
    display: inline-flex;
  }
  :global(:where(:root:not([data-layout="classic"]))) .fiv.cap {
    display: flex;
  }
  :global(:where(:root:not([data-layout="classic"]))) .toolbar {
    gap: 6px;
    padding: 0.5rem clamp(1.2rem, 4.5cqi, 2.6rem) 0.55rem;
    background: var(--paper);
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb {
    min-height: 28px;
    padding: 3px 10px;
    gap: 6px;
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    background: var(--well);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    color: var(--ink);
    font-size: 12.5px;
    font-weight: 500;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb:hover:not(:disabled),
  :global(:where(:root:not([data-layout="classic"]))) .tb.on {
    background: var(--well2);
    border-color: var(--dim);
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb:has(.lbl) .ico {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb.b {
    font-weight: 700;
    min-width: 30px;
    justify-content: center;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb.i {
    font-style: italic;
    font-family: var(--serif, Georgia, serif);
    min-width: 30px;
    justify-content: center;
  }
  :global(:where(:root:not([data-layout="classic"]))) .vr {
    height: 20px;
    margin: 0 4px;
    background: var(--line2);
  }
  /* Markdown: a switch, not a button (off: the knob left, grey). */
  :global(:where(:root:not([data-layout="classic"]))) .tb.md {
    border-radius: 999px;
    padding: 3px 12px 3px 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb.md .ico {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .sw {
    position: relative;
    width: 26px;
    height: 15px;
    border-radius: 999px;
    background: var(--paper);
    border: 1px solid var(--line2);
    flex: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .sw::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--dim);
    transition: transform 120ms;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb.md.on .sw {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb.md.on .sw::after {
    transform: translateX(11px);
    background: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    :global(:where(:root:not([data-layout="classic"]))) .sw::after {
      transition: none;
    }
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu {
    min-width: 15rem;
    padding: 5px;
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .tb-menu {
      animation: tb-in 90ms ease-out;
    }
  }
  @keyframes tb-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .cap {
    align-items: center;
    gap: 8px;
    margin: 6px 10px 6px;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .cap::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .it {
    min-height: 30px;
    border-radius: var(--r1);
    color: var(--ink);
    font-size: 13px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .it:hover,
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .it:focus-visible {
    background: var(--well);
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .s-h1 {
    font-size: 1.05rem;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .s-h2 {
    font-size: 0.95rem;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .s-h3 {
    font-size: 0.86rem;
  }
  :global(:where(:root:not([data-layout="classic"]))) .tb-menu .sep {
    background: var(--line2);
  }
  @container toolbar (max-width: 620px) {
    :global(:where(:root:not([data-layout="classic"]))) .tb:has(.lbl) .ico {
      display: inline-flex;
    }
    :global(:where(:root:not([data-layout="classic"]))) .tb .lbl {
      display: none;
    }
  }
</style>
