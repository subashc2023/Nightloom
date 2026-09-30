<script lang="ts">
  /**
   * A chat's open asides, listed under its sidebar row when its asides
   * toggle is open (item 265; the design is in `asideSidebar.svelte.ts`).
   * Indented like its forks, but each row carries the asides glyph and
   * "aside" on its second line, and the rule at its left is dotted where
   * a fork's is solid. A click shows the thread in a tab (the one already
   * showing it, else a new one beside); a double-click or the ··· menu's
   * Rename names it; the menu's Close moves it to the chat's Past list, as
   * the card's × does (text in its box asks first).
   */
  import { app, asideAsking, asideInTab, requestDismissAside } from "./state.svelte";
  import type { Aside } from "./state.svelte";
  import * as tabs from "./tabs";
  import Icon from "./Icon.svelte";
  import AsideNameEdit from "./AsideNameEdit.svelte";
  import { tip } from "./tip";
  import { asideLabel } from "./asides";
  import { renameAside } from "./asides.svelte";
  import { asidesListedOf, openAsideTab } from "./asideSidebar.svelte";

  let { session, depth = 0 }: { session: string; depth?: number } = $props();

  const list = $derived(asidesListedOf(session));
  const front = $derived(tabs.activeTab(tabs.focusedPane(app.tabs)).content);
  let naming = $state<number | null>(null);
  let menu = $state<{ a: Aside; x: number; y: number; up: boolean } | null>(null);

  function statusOf(a: Aside): string {
    if (asideAsking(a)) return "asking…";
    if (a.draft) return "not asked yet";
    const n = a.turns.length;
    const s = `${n} ${n === 1 ? "exchange" : "exchanges"}`;
    return asideInTab(session, a.id) ? `${s} · in a tab` : s;
  }
  function isFront(a: Aside): boolean {
    return front.kind === "aside" && front.session === session && front.thread === a.id;
  }
  function openMenu(e: MouseEvent, a: Aside, fromButton: boolean) {
    e.preventDefault();
    e.stopPropagation();
    if (fromButton) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const up = r.bottom + 120 > window.innerHeight;
      menu = { a, x: r.left, y: up ? window.innerHeight - r.top + 4 : r.bottom + 4, up };
    } else {
      menu = { a, x: e.clientX, y: e.clientY, up: false };
    }
  }
  function pick(fn: (a: Aside) => void) {
    const a = menu?.a;
    menu = null;
    if (a) fn(a);
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (menu && e.key === "Escape") {
      e.preventDefault();
      menu = null;
    }
  }}
/>

{#each list as a (a.id)}
  <div class="aside-item" class:active={isFront(a)} style:--depth={depth + 1}>
    {#if naming === a.id}
      <AsideNameEdit
        value={a.name ?? ""}
        placeholder={asideLabel({ ...a, name: undefined })}
        oncommit={(v) => {
          naming = null;
          renameAside(a, v);
        }}
        oncancel={() => (naming = null)}
      />
    {:else}
      <button
        class="aside-row"
        onclick={() => void openAsideTab(session, a.id)}
        ondblclick={() => (naming = a.id)}
        oncontextmenu={(e) => openMenu(e, a, false)}
        use:tip={a.quote ? `About: ${a.quote.text.slice(0, 160)}` : "An aside asked from the composer"}
      >
        <span class="snippet"
          ><span class="glyph" aria-hidden="true"><Icon name="think" size={11} /></span>{asideLabel(a)}</span
        >
        <span class="meta">aside · {statusOf(a)}</span>
      </button>
      <button
        class="more-btn"
        class:open={menu?.a === a}
        aria-label="More for this aside"
        aria-haspopup="menu"
        aria-expanded={menu?.a === a}
        use:tip={"Open, rename, close…"}
        onclick={(e) => openMenu(e, a, true)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" width="14" height="14" fill="currentColor"
          ><circle cx="4.5" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="15.5" cy="10" r="1.6" /></svg
        >
      </button>
    {/if}
  </div>
{/each}

{#if menu}
  <button class="scrim" aria-label="Close" onclick={() => (menu = null)} oncontextmenu={(e) => { e.preventDefault(); menu = null; }}></button>
  <div
    class="row-menu"
    role="menu"
    style:left="{menu.x}px"
    style:top={menu.up ? undefined : `${menu.y}px`}
    style:bottom={menu.up ? `${menu.y}px` : undefined}
  >
    <button role="menuitem" onclick={() => pick((a) => void openAsideTab(session, a.id))}>Open in a tab</button>
    <button role="menuitem" onclick={() => pick((a) => (naming = a.id))}>Rename</button>
    <div class="row-sep"></div>
    <button role="menuitem" onclick={() => pick((a) => requestDismissAside(a))}
      >Close <span class="row-key">to the chat's Past list</span></button
    >
  </div>
{/if}

<style>
  /* One indent step past the chat (or fork) it belongs to; the rule at its
     left is dotted where a fork's is solid (item 265). */
  .aside-item {
    display: flex;
    align-items: stretch;
    border-radius: 8px;
    margin-left: calc(min(var(--depth, 1), 4) * 0.9rem);
    position: relative;
  }
  .aside-item::before {
    content: "";
    position: absolute;
    left: -0.45rem;
    top: 4px;
    bottom: 4px;
    border-left: 1px dotted var(--line2);
  }
  .aside-item:hover {
    background: var(--well);
  }
  .aside-item.active {
    background: var(--sheet);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .aside-row {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 8px;
    padding: 0.35rem 0.6rem;
    cursor: pointer;
    color: var(--text);
  }
  .snippet {
    font-size: 0.8rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .glyph {
    display: inline-flex;
    vertical-align: -1px;
    margin-right: 5px;
    color: var(--accent-ink, var(--dim));
  }
  .meta {
    font-size: 0.68rem;
    color: var(--dim);
    font-family: var(--mono);
  }
  .more-btn {
    flex-shrink: 0;
    align-self: center;
    width: 0;
    height: 22px;
    padding: 0;
    margin: 0;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--dim);
    cursor: pointer;
    opacity: 0;
  }
  .aside-item:hover .more-btn,
  .more-btn:focus-visible,
  .more-btn.open {
    width: 22px;
    margin-right: 5px;
    opacity: 1;
  }
  .more-btn:hover,
  .more-btn.open {
    background: var(--line);
    color: var(--ink);
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 35;
    background: transparent;
    border: none;
    cursor: default;
  }
  .row-menu {
    position: fixed;
    z-index: 36;
    display: flex;
    flex-direction: column;
    min-width: 200px;
    padding: 4px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .row-menu button {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--ink2);
    font: inherit;
    font-size: 12.5px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .row-menu button:hover {
    background: var(--well);
    color: var(--ink);
  }
  .row-key {
    color: var(--dim);
    font-size: 11.5px;
  }
  .row-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--line);
  }
</style>
