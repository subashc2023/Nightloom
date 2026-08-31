<script lang="ts">
  import { onMount } from "svelte";
  import { app, init } from "./lib/state.svelte";
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
<div class="shell">
  <TitleBar />
  <div class="app">
    <Sidebar />
    <div class="main">
      <TopBar />
      <div class="content">
        {#if app.view === "note"}
          <NoteView />
        {:else if app.view === "graph"}
          <GraphView />
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
    <RightRail />
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
    grid-template-columns: 260px 1fr 240px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
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
