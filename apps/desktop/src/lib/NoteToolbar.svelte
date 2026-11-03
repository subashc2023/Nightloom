<script lang="ts">
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
    {disabled}><Icon name="textstyle" size={16} /><span class="chev"><Icon name="chev" size={11} /></span></button
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
    {disabled}><Icon name="table" size={16} /></button
  >
  <button
    class="tb"
    aria-label="Image"
    use:tip={canImage ? "Insert an image: it is copied into attachments/ beside the note" : imageWhy}
    onmousedown={hold}
    onclick={choose}
    disabled={disabled || !canImage}><Icon name="image" size={16} /></button
  >
  <button
    class="tb"
    aria-label="Checklist"
    use:tip={"Checklist: the selected lines become to-do items (again to undo them)"}
    onmousedown={hold}
    onclick={() => run(toggleChecklist)}
    {disabled}><Icon name="checklist" size={16} /></button
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
    {disabled}><Icon name="plus" size={16} /><span class="chev"><Icon name="chev" size={11} /></span></button
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
    {disabled}><Icon name="markdown" size={15} /><span class="md-label">Markdown</span></button
  >
  <input bind:this={picker} class="picker" type="file" accept="image/*" hidden onchange={onpick} />
</div>

{#if menu}
  <div
    class="tb-menu"
    role="menu"
    tabindex="-1"
    aria-label={menu === "style" ? "Text style" : "Insert"}
    bind:this={menuEl}
    use:floatMenu={{ anchor: menu === "style" ? styleBtn : insertBtn, align: "left" }}
    onkeydown={menuKeys}
  >
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
</style>
