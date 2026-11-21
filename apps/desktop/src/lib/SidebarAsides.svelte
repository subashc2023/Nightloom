<script lang="ts">
  import { hudIn, hudOut } from "./hudMenu";
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
  import { requestDismissAside } from "./state.svelte";
  import Icon from "./Icon.svelte";
  import AsideNameEdit from "./AsideNameEdit.svelte";
  import { quoteSummary } from "./asideQuote";
  import { tip } from "./tip";
  import { asideLabel } from "./asides";
  import { renameAside } from "./asides.svelte";
  import { openAsideTab } from "./asideSidebar.svelte";
  import { sidebarAsidesLogic, type SidebarAsidesLogicProps } from "./sidebarAsides/logic.svelte";

  // Item 856: the behaviour lives once, in `sidebarAsides/logic.svelte.ts`; this file is the look.
  const props: SidebarAsidesLogicProps = $props();
  const T = sidebarAsidesLogic(() => props);
</script>

<svelte:window
  onkeydown={(e) => {
    if (T.menu && e.key === "Escape") {
      e.preventDefault();
      T.menu = null;
    }
  }}
/>

{#each T.list as a (a.id)}
  <div class="aside-item" class:active={T.isFront(a)} style:--depth={T.depth + 1}>
    {#if T.naming === a.id}
      <AsideNameEdit
        value={a.name ?? ""}
        placeholder={asideLabel({ ...a, name: undefined })}
        oncommit={(v) => {
          T.naming = null;
          renameAside(a, v);
        }}
        oncancel={() => (T.naming = null)}
      />
    {:else}
      <button
        class="aside-row"
        onclick={() => void openAsideTab(T.session, a.id)}
        ondblclick={() => (T.naming = a.id)}
        oncontextmenu={(e) => T.openMenu(e, a, false)}
        use:tip={a.quote ? `About: ${quoteSummary(a.quote.text, 160)}` : "An aside asked from the composer"}
      >
        <span class="snippet"
          ><span class="glyph" aria-hidden="true"><Icon name="think" size={11} /></span>{asideLabel(a)}</span
        >
        <span class="meta">aside · {T.statusOf(a)}</span>
      </button>
      <button
        class="more-btn"
        class:open={T.menu?.a === a}
        aria-label="More for this aside"
        aria-haspopup="menu"
        aria-expanded={T.menu?.a === a}
        use:tip={"Open, rename, close…"}
        onclick={(e) => T.openMenu(e, a, true)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" width="14" height="14" fill="currentColor"
          ><circle cx="4.5" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="15.5" cy="10" r="1.6" /></svg
        >
      </button>
    {/if}
  </div>
{/each}

{#if T.menu}
  <button class="scrim" aria-label="Close" onclick={() => (T.menu = null)} oncontextmenu={(e) => { e.preventDefault(); T.menu = null; }}></button>
  <div
    class="row-menu hud-m"
    role="menu"
    in:hudIn|global
    out:hudOut|global
    style:left="{T.menu.x}px"
    style:top={T.menu.up ? undefined : `${T.menu.y}px`}
    style:bottom={T.menu.up ? `${T.menu.y}px` : undefined}
  >
    <button role="menuitem" onclick={() => T.pick((a) => void openAsideTab(T.session, a.id))}>Open in a tab</button>
    <button role="menuitem" onclick={() => T.pick((a) => (T.naming = a.id))}>Rename</button>
    <div class="row-sep"></div>
    <button role="menuitem" onclick={() => T.pick((a) => requestDismissAside(a))}
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
    /* Item 534: the chat rows' shape, fills and tick (Filament IV). */
    border-radius: 0 var(--r1) var(--r1) 0;
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
    background: var(--raised);
  }
  .aside-item.active {
    background: var(--well);
    box-shadow: inset 2px 0 0 var(--accent);
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
    border-radius: 0 var(--r1) var(--r1) 0;
    padding: 6px 10px 7px;
    cursor: pointer;
    color: var(--text);
    font-family: var(--sans);
  }
  .snippet {
    font-size: 12.5px;
    color: var(--ink2);
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
    font: 10.5px var(--mono);
    color: var(--dim);
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
