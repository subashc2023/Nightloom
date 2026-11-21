<script lang="ts">
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { isMac } from "./platform";
  import { titleBarLogic, type TitleBarLogicProps } from "./titleBar/logic.svelte";

  // Item 856: the behaviour lives once, in `titleBar/logic.svelte.ts`; this file is the look.
  const props: TitleBarLogicProps = $props();
  const T = titleBarLogic(() => props);
</script>

{#if !isMac}
  <header class="titlebar" class:blur={!T.focused} data-tauri-drag-region="deep">
    <span class="wordmark">nightloom</span>
    {#if T.label}
      <span class="doc">{T.label}</span>
    {/if}

    <div class="controls">
      <!-- App commands sit to the left of the window's own, with a gap
           between: they belong to different owners, and a gear flush against
           minimize reads as a fourth caption button. -->
      <button
        class="cap app"
        use:tip={"Settings"}
        aria-label="Settings"
        onclick={() => (app.showSettings = !app.showSettings)}
      >
        <!-- Teeth short and a body that is plainly a ring: eight long spokes
             around a small circle is a sun, which is what the first draft of
             this drew. -->
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="3.5" />
          <circle cx="8" cy="8" r="1.3" />
          <path
            d="M8 4.5V2.7M8 11.5v1.8M4.5 8H2.7M11.5 8h1.8M5.53 5.53L4.25 4.25M10.47 10.47l1.28 1.28M10.47 5.53l1.28-1.28M5.53 10.47l-1.28 1.28"
          />
        </svg>
      </button>
      <button
        class="cap"
        use:tip={"Minimize"}
        aria-label="Minimize"
        onclick={() => void T.win.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5H10" />
        </svg>
      </button>
      <button
        class="cap"
        use:tip={T.maximized ? "Restore" : "Maximize"}
        aria-label={T.maximized ? "Restore" : "Maximize"}
        onclick={() => void T.win.toggleMaximize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          {#if T.maximized}
            <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          {:else}
            <rect x="0.5" y="0.5" width="9" height="9" />
          {/if}
        </svg>
      </button>
      <button
        class="cap close"
        use:tip={"Close"}
        aria-label="Close"
        onclick={() => void T.win.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" />
        </svg>
      </button>
    </div>
  </header>
{/if}

<style>
  .titlebar {
    position: relative;
    display: flex;
    align-items: center;
    flex-shrink: 0;
    height: var(--titlebar-h);
    background: var(--panel);
    user-select: none;
    -webkit-user-select: none;
  }
  .wordmark {
    padding-left: 0.9rem;
    color: var(--accent);
    font-size: 0.74rem;
    letter-spacing: 0.24em;
    white-space: nowrap;
  }
  /* Centred on the window rather than on the space left over, so it does not
     shift when the chat's name changes length. It is never a drag obstacle:
     with no pointer events the mousedown lands on the bar itself. */
  .doc {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    max-width: 36%;
    color: var(--dim);
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .blur .wordmark,
  .blur .doc {
    opacity: 0.55;
  }

  .controls {
    margin-left: auto;
    display: flex;
    align-self: stretch;
    flex-shrink: 0;
  }
  /* 46px wide and full height is what Windows uses; a caption button is a
     target you hit by throwing the pointer at the corner, so it runs to the
     window edge with no padding or radius of its own. */
  .cap {
    width: 46px;
    display: grid;
    place-items: center;
    background: transparent;
    border: none;
    padding: 0;
    color: var(--text);
    opacity: 0.75;
    cursor: default;
  }
  /* Narrower than a caption button and set apart from the run of them, so it
     reads as the app's control rather than the window's. */
  .cap.app {
    width: 38px;
    margin-right: 0.35rem;
    color: var(--dim);
  }
  .cap:hover {
    background: rgba(255, 255, 255, 0.08);
    opacity: 1;
  }
  .cap.app:hover {
    color: var(--text);
  }
  .cap:active {
    background: rgba(255, 255, 255, 0.04);
  }
  .cap.close:hover {
    background: #c42b1c;
    color: #fff;
  }
  .cap.close:active {
    background: #b02818;
  }
  .cap:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -3px;
  }
  .blur .cap {
    opacity: 0.45;
  }
  .cap svg {
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    stroke-linecap: square;
  }
  /* The gear is drawn at 16 rather than 10, so square caps would read as
     blunt corners on the spokes. */
  .cap.app svg {
    stroke-width: 1.3;
    stroke-linecap: round;
  }

</style>
