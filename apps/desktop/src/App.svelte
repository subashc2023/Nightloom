<script lang="ts">
  import { onMount } from "svelte";
  import {
    app,
    closePrompts,
    init,
    runMenuCommand,
    setSidebarWidth,
    syncPromptLayers,
    toggleSidebar,
    SIDEBAR_MAX,
    SIDEBAR_MIN,
  } from "./lib/state.svelte";
  import { isMac } from "./lib/platform";
  import { toggleTranscriptPref } from "./lib/transcriptPrefs.svelte";
  import Grip from "./lib/Grip.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import TitleBar from "./lib/TitleBar.svelte";
  import TopBar from "./lib/TopBar.svelte";
  import SettingsModal from "./lib/SettingsModal.svelte";
  import PromptLibrary from "./lib/PromptLibrary.svelte";
  import Transcript from "./lib/Transcript.svelte";
  import Composer from "./lib/Composer.svelte";
  import NoteView from "./lib/NoteView.svelte";
  import GraphView from "./lib/GraphView.svelte";
  import Welcome from "./lib/Welcome.svelte";
  import NewProject from "./lib/NewProject.svelte";
  import Palette from "./lib/Palette.svelte";
  import NightshiftSurface from "./lib/NightshiftSurface.svelte";
  import Icon from "./lib/Icon.svelte";

  onMount(() => {
    void init();
  });

  /**
   * The engine is built once per rail change and a chat's switched-off
   * prompt layers live in its log, so opening a different chat can leave
   * the wire carrying the last chat's prompt. Re-checked whenever the open
   * chat changes, and again when a turn or a connect ends, since the sync
   * itself stands aside while either is in flight (`syncPromptLayers`).
   */
  $effect(() => {
    void app.activeSessionId;
    void app.connecting;
    void app.busy;
    void syncPromptLayers();
  });

  /**
   * A conversation with nothing in it yet gets the launcher instead of an
   * empty transcript with a docked composer: an empty pane is where the two
   * questions that actually start a chat belong — which folder, and what do
   * you want. `app.live` is checked as well as the log so the switch happens
   * on the first send rather than on the re-sync a whole turn later.
   *
   * "Nothing in it" means no message, not no event (review round 1,
   * 2026-09-13): a session re-opened from the sidebar carries its
   * `session_created` line, and on the old test that one line turned the
   * Welcome page into an empty transcript. New chat and the empty session it
   * made now show the same page.
   */
  const blank = $derived(
    !app.live &&
      !app.events.some(
        (e) =>
          e.event === "user_message" ||
          e.event === "assistant_message" ||
          e.event === "compaction",
      ),
  );

  /**
   * The redesign's shortcuts (nightshift blocker 035) on Windows and Linux,
   * where there is no menu bar to carry accelerators. On macOS the same keys
   * arrive as `menu` events from `mac_menu`, and binding them here as well
   * would fire each command twice — so this table is off there.
   */
  const KEYS: Record<string, string> = {
    k: "commands",
    p: "projects",
    m: "model",
    e: "engine",
  };
  const SHIFT_KEYS: Record<string, string> = {
    s: "model_sonnet",
    o: "model_opus",
    f: "model_fable",
    h: "model_haiku",
  };
  function onShortcut(e: KeyboardEvent): boolean {
    if (e.altKey) return false;
    // ⌘1…9 (Ctrl+1…9 elsewhere) is the n-th provider pill, on every
    // platform: it is not a menu item, so macOS cannot double-fire it.
    // Bare ⌘, not ⌘⇧, since his second look (2026-09-13): "anthropic
    // shouldn't be special" — the alias letters need Shift, the providers
    // do not. Matched on the physical key so a layout cannot move it.
    const primary = isMac ? e.metaKey : e.ctrlKey;
    if (primary && /^Digit[1-9]$/.test(e.code)) {
      // ⌘⇧digit is the n-th model of the picker, every provider alike
      // (2026-09-14); Shift means model on both engines — letters on
      // Claude Code, numbers on the API.
      runMenuCommand(`${e.shiftKey ? "model" : "provider"}_${e.code.slice(5)}`);
      return true;
    }
    // ⌘⇧T shows or folds thinking, ⌘⇧B the tool calls (nightshift backlog
    // 052, 2026-09-14). On every platform, like the digits: neither is a
    // menu item, so macOS cannot double-fire them. Physical keys, so a
    // layout cannot move them. Both were free — the grep on 2026-09-14
    // found no Shift+T or Shift+B anywhere in the app or its menu.
    if (primary && e.shiftKey && (e.code === "KeyT" || e.code === "KeyB")) {
      toggleTranscriptPref(e.code === "KeyT" ? "thinking" : "tool");
      return true;
    }
    if (isMac || !e.ctrlKey) return false;
    const k = e.key.toLowerCase();
    const id = e.shiftKey ? SHIFT_KEYS[k] : KEYS[k];
    if (!id) return false;
    runMenuCommand(id);
    return true;
  }
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
      return;
    }
    if (onShortcut(e)) e.preventDefault();
  }}
/>

<div class="shell">
  <TitleBar />
  <div
    class="app"
    class:nightshift={app.view === "nightshift"}
    class:collapsed={app.layout.sidebarCollapsed}
    style:grid-template-columns="{app.layout.sidebarCollapsed ? 0 : app.layout.sidebarWidth}px minmax(0, 1fr)"
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
        {:else if app.view === "new-project"}
          <NewProject />
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
    <!-- A click on the overlay itself — outside the modal — closes it. The
         handler checks the target so clicks inside the modal that bubble up
         are left alone. -->
    {#if app.showSettings}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="settings-overlay" onmousedown={(e) => { if (e.target === e.currentTarget) app.showSettings = false; }}><SettingsModal /></div>
    {/if}
    <Palette />
    {#if app.showPrompts}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="settings-overlay" onmousedown={(e) => { if (e.target === e.currentTarget) closePrompts(); }}><PromptLibrary /></div>
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
       it collapses to nothing. The right rail is no longer a column — it
       opens as a popover from the chat top bar's model chip (2026-09-11). */
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
    width: 7px;
    display: flex;
    z-index: 5;
  }
  .side-grip :global(.grip) {
    height: 100%;
    margin: 0;
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
