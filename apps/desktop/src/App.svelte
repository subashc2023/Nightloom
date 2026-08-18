<script lang="ts">
  import { onMount } from "svelte";
  import { app, init } from "./lib/state.svelte";
  import Sidebar from "./lib/Sidebar.svelte";
  import TopBar from "./lib/TopBar.svelte";
  import SettingsPanel from "./lib/SettingsPanel.svelte";
  import Transcript from "./lib/Transcript.svelte";
  import Composer from "./lib/Composer.svelte";

  onMount(() => {
    void init();
  });
</script>

<div class="app">
  <Sidebar />
  <div class="main">
    <TopBar />
    <div class="content">
      <Transcript />
      {#if app.showSettings}
        {#if app.connection}
          <div class="settings-dropdown"><SettingsPanel /></div>
        {:else}
          <div class="settings-overlay"><SettingsPanel /></div>
        {/if}
      {/if}
      {#if app.toasts.length > 0}
        <div class="toasts">
          {#each app.toasts as t (t.id)}
            <div class="toast">{t.text}</div>
          {/each}
        </div>
      {/if}
    </div>
    <Composer />
  </div>
</div>

<style>
  .app {
    display: grid;
    grid-template-columns: 260px 1fr;
    height: 100vh;
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
  .settings-dropdown {
    position: absolute;
    top: 0.5rem;
    right: 0.75rem;
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
