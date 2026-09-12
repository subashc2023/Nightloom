<script lang="ts">
  import { onMount } from "svelte";
  import {
    app,
    init,
    setSidebarWidth,
    toggleSidebar,
    SIDEBAR_MAX,
    SIDEBAR_MIN,
  } from "./lib/state.svelte";
  import Grip from "./lib/Grip.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import TitleBar from "./lib/TitleBar.svelte";
  import TopBar from "./lib/TopBar.svelte";
  import RightRail from "./lib/RightRail.svelte";
  import SettingsModal from "./lib/SettingsModal.svelte";
  import PromptLibrary from "./lib/PromptLibrary.svelte";
  import Transcript from "./lib/Transcript.svelte";
  import Composer from "./lib/Composer.svelte";
  import NoteView from "./lib/NoteView.svelte";
  import GraphView from "./lib/GraphView.svelte";
  import Welcome from "./lib/Welcome.svelte";
  import NightshiftSurface from "./lib/NightshiftSurface.svelte";
  import Icon from "./lib/Icon.svelte";

  onMount(() => {
    void init();
  });

  /**
   * A conversation with nothing in it yet gets the launcher instead of an
   * empty transcript with a docked composer: an empty pane is where the two
   * questions that actually start a chat belong — which folder, and what do
   * you want. `app.live` is checked as well as the log so the switch happens
   * on the first send rather than on the re-sync a whole turn later.
   */
  const blank = $derived(app.events.length === 0 && !app.live);
</script>

<!--
  The title bar spans the whole window rather than sitting inside the centre
  column, because it is the window's own chrome and not a toolbar: with the
  system frame off there has to be somewhere to grab at the top of the screen
  wherever the pointer is, including over the sidebar and the rail.
-->
<svelte:window
  onkeydown={(e) => {
    // ⌘\ (Ctrl+\ elsewhere) collapses and reopens the sidebar.
    if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
      e.preventDefault();
      toggleSidebar();
    }
  }}
/>

<div class="shell">
  <TitleBar />
  <div
    class="app"
    class:nightshift={app.view === "nightshift"}
    class:collapsed={app.layout.sidebarCollapsed}
    style:grid-template-columns="{app.layout.sidebarCollapsed ? 0 : app.layout.sidebarWidth}px 1fr {app.view === 'nightshift' ? 0 : 240}px"
  >
    <Sidebar />
    {#if app.layout.sidebarCollapsed}
      <button class="side-expand" title="Show sidebar (⌘\)" onclick={() => toggleSidebar()}>
        <Icon name="chevr" size={12} />
      </button>
    {:else}
      <!-- The sidebar's collapse button and resize grip sit on its edge,
           drawn here because the sidebar clips its own overflow. -->
      <button
        class="side-toggle"
        style:left="{app.layout.sidebarWidth - 11}px"
        title="Collapse sidebar (⌘\)"
        onclick={() => toggleSidebar()}
      >
        <Icon name="chevl" size={12} />
      </button>
      <div class="side-grip" style:left="{app.layout.sidebarWidth - 4}px">
        <Grip
          width={app.layout.sidebarWidth}
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          edge="left"
          onchange={(w) => setSidebarWidth(w)}
        />
      </div>
    {/if}
    <div class="main">
      {#if app.view !== "nightshift"}
        <TopBar />
      {/if}
      <div class="content">
        {#if app.view === "note"}
          <NoteView />
        {:else if app.view === "graph"}
          <GraphView />
        {:else if app.view === "nightshift"}
          <NightshiftSurface />
        {:else if blank}
          <Welcome />
        {:else}
          <Transcript />
        {/if}
        {#if app.toasts.length > 0}
          <div class="toasts">
            {#each app.toasts as t (t.id)}
              <div class="toast">{t.text}</div>
            {/each}
          </div>
        {/if}
      </div>
      {#if app.view === "chat" && !blank}
        <Composer />
      {/if}
    </div>
    {#if app.view !== "nightshift"}
      <RightRail />
    {/if}
    {#if app.showSettings}
      <div class="settings-overlay"><SettingsModal /></div>
    {/if}
    {#if app.showPrompts}
      <div class="settings-overlay"><PromptLibrary /></div>
    {/if}
  </div>
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .app {
    position: relative;
    display: grid;
    /* The columns are set inline: the sidebar's width is a preference and
       it collapses to nothing; the rail is folded away on the Nightshift
       screens, whose header carries what it would have shown. */
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  /* The round button that brings a collapsed sidebar back — where its
     collapse button sat, on the sidebar's edge. */
  .side-expand {
    position: absolute;
    left: 10px;
    top: 30px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: var(--sheet);
    color: var(--dim);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 6;
  }
  .side-expand:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .side-toggle {
    position: absolute;
    top: 30px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: var(--sheet);
    color: var(--dim);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 6;
  }
  .side-toggle:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .side-grip {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    z-index: 5;
  }
  .side-grip :global(.grip) {
    height: 100%;
  }
  .side-grip :global(.grip::after) {
    height: 100%;
    background: transparent;
  }
  .side-grip :global(.grip:hover::after),
  .side-grip :global(.grip.dragging::after) {
    background: var(--accent);
  }
  .app.collapsed :global(header.topbar) {
    padding-left: 44px;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .content {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .settings-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(13, 13, 20, 0.65);
    z-index: 20;
  }
  .toasts {
    position: absolute;
    bottom: 0.75rem;
    right: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    z-index: 30;
    pointer-events: none;
  }
  .toast {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--dim);
    font-size: 0.8rem;
    padding: 0.4rem 0.7rem;
    border-radius: 6px;
    max-width: 22rem;
  }
</style>
