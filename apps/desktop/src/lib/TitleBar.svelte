<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import { app } from "./state.svelte";
  import { isLinux, isMac } from "./platform";

  /**
   * The window's own chrome, drawn in the webview because the system frame is
   * off on Windows and Linux (see `build_window` in `main.rs`). Everything a
   * title bar is expected to do has to be done here rather than assumed: drag
   * and double-click-to-maximize come from `data-tauri-drag-region="deep"`,
   * which Tauri's injected handler reads — clickable elements inside it block
   * the drag on their own, so the buttons need no opt-out.
   */
  const win = getCurrentWindow();

  /**
   * Two things the system used to track for us. The maximize button has two
   * glyphs and they are not interchangeable — a restore icon on a windowed
   * window is the one wrong thing a caption bar can do and still look
   * plausible — and `onResized` is what reports the state, since dragging a
   * window to the top edge maximizes it without the button being touched.
   * Focus dims the bar the way every native one does, which is most of what
   * makes a background window read as a background window.
   */
  let maximized = $state(false);
  let focused = $state(true);

  $effect(() => {
    let alive = true;
    const stops: UnlistenFn[] = [];
    // A listener that resolves after the effect is torn down has to stop
    // itself; nothing else is holding it any more.
    const keep = (stop: UnlistenFn) => {
      if (alive) stops.push(stop);
      else stop();
    };
    // `onResized` fires every frame of a resize drag and the answer is a
    // round trip, so the checks are coalesced rather than queued: one in
    // flight at a time, and one more afterwards if anything arrived while it
    // was out. Dropping the trailing event instead would be the cheap version
    // and would leave the glyph wrong exactly when the drag ended on a
    // maximize.
    let checking = false;
    let again = false;
    const sync = () => {
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      void win
        .isMaximized()
        .then((m) => (maximized = m))
        .finally(() => {
          checking = false;
          if (again) {
            again = false;
            sync();
          }
        });
    };
    sync();
    void win.onResized(sync).then(keep);
    void win.onFocusChanged(({ payload }) => (focused = payload)).then(keep);
    return () => {
      alive = false;
      for (const stop of stops) stop();
    };
  });

  /**
   * What the window is called, which in a chat app is what the chat is
   * called: five alt-tab entries all reading "Nightloom" say less than the
   * names the sidebar is already showing. `title ?? first_user` for the same
   * reason every other list does it — a log written before names existed has
   * no title and is not nameless.
   */
  const label = $derived.by(() => {
    const open = app.sessions.find((s) => s.id === app.activeSessionId);
    const name = open?.title ?? open?.first_user ?? null;
    if (name) return name.length > 64 ? `${name.slice(0, 64)}…` : name;
    return app.project?.name ?? null;
  });

  // The taskbar and the switcher read the OS title, not the bar, so it is set
  // rather than only drawn.
  $effect(() => {
    void win.setTitle(label ? `${label} — Nightloom` : "Nightloom");
  });

  type Edge =
    | "North"
    | "NorthEast"
    | "East"
    | "SouthEast"
    | "South"
    | "SouthWest"
    | "West"
    | "NorthWest";

  const EDGES: Edge[] = [
    "North",
    "NorthEast",
    "East",
    "SouthEast",
    "South",
    "SouthWest",
    "West",
    "NorthWest",
  ];

  function resize(event: MouseEvent, edge: Edge) {
    if (event.button !== 0) return;
    event.preventDefault();
    void win.startResizeDragging(edge);
  }
</script>

<header
  class="titlebar"
  class:mac={isMac}
  class:blur={!focused}
  data-tauri-drag-region="deep"
>
  <span class="wordmark">nightloom</span>
  {#if label}
    <span class="doc">{label}</span>
  {/if}

  {#if !isMac}
    <div class="controls">
      <button class="cap" title="Minimize" aria-label="Minimize" onclick={() => void win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5H10" />
        </svg>
      </button>
      <button
        class="cap"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        onclick={() => void win.toggleMaximize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          {#if maximized}
            <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          {:else}
            <rect x="0.5" y="0.5" width="9" height="9" />
          {/if}
        </svg>
      </button>
      <button
        class="cap close"
        title="Close"
        aria-label="Close"
        onclick={() => void win.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0.5 0.5L9.5 9.5M9.5 0.5L0.5 9.5" />
        </svg>
      </button>
    </div>
  {/if}
</header>

{#if isLinux && !maximized}
  <!-- GTK leaves an undecorated window no grab the webview does not cover, so
       the eight edges are supplied here. Windows needs none and macOS keeps
       its frame, so neither renders them. -->
  {#each EDGES as edge (edge)}
    <div
      class="grip {edge.toLowerCase()}"
      role="presentation"
      onmousedown={(e) => resize(e, edge)}
    ></div>
  {/each}
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
  /* Room for the traffic lights, which sit over the top-left of the content
     when the frame is kept and only its title hidden. */
  .titlebar.mac {
    padding-left: 78px;
  }
  .wordmark {
    padding-left: 0.9rem;
    color: var(--accent);
    font-size: 0.74rem;
    letter-spacing: 0.24em;
    white-space: nowrap;
  }
  .titlebar.mac .wordmark {
    padding-left: 0;
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
  .cap:hover {
    background: rgba(255, 255, 255, 0.08);
    opacity: 1;
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

  /* Five pixels is the width tao itself hit-tests for on the platforms that
     do this in the window manager, so the target is the same size wherever
     it comes from. */
  .grip {
    position: fixed;
    z-index: 60;
  }
  .grip.north,
  .grip.south {
    left: 5px;
    right: 5px;
    height: 5px;
    cursor: ns-resize;
  }
  .grip.east,
  .grip.west {
    top: 5px;
    bottom: 5px;
    width: 5px;
    cursor: ew-resize;
  }
  .grip.north {
    top: 0;
  }
  .grip.south {
    bottom: 0;
  }
  .grip.east {
    right: 0;
  }
  .grip.west {
    left: 0;
  }
  .grip.northwest,
  .grip.northeast,
  .grip.southwest,
  .grip.southeast {
    width: 8px;
    height: 8px;
  }
  .grip.northwest {
    top: 0;
    left: 0;
    cursor: nwse-resize;
  }
  .grip.northeast {
    top: 0;
    right: 0;
    cursor: nesw-resize;
  }
  .grip.southwest {
    bottom: 0;
    left: 0;
    cursor: nesw-resize;
  }
  .grip.southeast {
    bottom: 0;
    right: 0;
    cursor: nwse-resize;
  }
</style>
