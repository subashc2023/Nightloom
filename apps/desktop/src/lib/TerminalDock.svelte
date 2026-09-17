<script lang="ts">
  /**
   * The terminal pane (nightshift backlog 113, boards 12a–12c): docked
   * under the content, a grip on its top edge, a strip of shells with +
   * and ×, the ⌃` hint, collapse and close, the notice row while a Claude
   * Code turn works in the same folder, and one `TerminalShell` per shell
   * underneath. Always mounted — it draws nothing while the pane is
   * closed — so ⌃` has somewhere to live without `App.svelte` carrying
   * it. Mounted once in every pane's dock slot (`App.svelte`'s
   * `.pane-dock`, agent L's mount point); the one whose `pane` is the
   * store's draws, and the first pane's instance owns the window keys.
   * One dock for the window (blocker 189), under the pane it was opened
   * from; it closes with that pane.
   */
  import { onMount } from "svelte";
  import { app, chatKind } from "./state.svelte";
  import { isMac } from "./platform";
  import Icon from "./Icon.svelte";
  import TerminalShell from "./TerminalShell.svelte";
  import {
    closePane,
    closeShell,
    dockPaneCheck,
    hidePane,
    initTerminalEvents,
    newShell,
    resetHeight,
    restartShell,
    saveHeight,
    selectShell,
    setHeight,
    takeMenuCommand,
    term,
    toggleCollapsed,
    toggleTerminal,
  } from "./terminal.svelte";
  import {
    clockLabel,
    exitLabel,
    filesChanged,
    focusedChord,
    isRunning,
    latestCall,
    shortCwd,
    tabLabel,
    terminalChord,
    turnStartedAt,
  } from "./terminal";

  /** The pane this instance sits under; `null` in a harness with no panes. */
  let { pane = null }: { pane?: string | null } = $props();

  onMount(() => {
    void initTerminalEvents();
  });

  /** Whether this instance is the one that draws: its pane is the dock's
   *  (or there are no panes to speak of, as in a harness). */
  const mine = $derived(pane === null || term.pane === null || term.pane === pane);
  /** The instance that owns the window's keys: the first pane's. */
  const keyed = $derived(pane === null || app.tabs.panes[0]?.id === pane);

  $effect(() => {
    void app.tabs.panes.length;
    if (keyed) dockPaneCheck();
  });

  let dock = $state<HTMLElement | null>(null);
  let dragging = $state(false);

  /** The column the dock sits in — the pane's — for the height's cap:
   *  the `.pane-dock` slot's parent, or the harness's column. */
  function columnHeight(): number {
    const slot = dock?.parentElement;
    const column = slot?.classList.contains("pane-dock") ? slot.parentElement : slot;
    return column?.clientHeight ?? window.innerHeight;
  }

  /** The grip: the composer's idiom (backlog 111) — pointer capture, the
   *  edge follows the pointer, the height is kept on release. */
  function gripDown(e: PointerEvent) {
    if (e.button !== 0 || !dock) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = dock.offsetHeight;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (ev: PointerEvent) => setHeight(startH + (startY - ev.clientY), columnHeight());
    const up = () => {
      dragging = false;
      saveHeight();
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  const home = $derived.by(() => {
    // The home is not handed to the window; the project's root under
    // /Users/<name> or /home/<name> is the one clue, and it is enough
    // for the strip's `~/…/folder`.
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/.exec(term.cwd ?? "");
    return m ? m[1] : null;
  });

  /**
   * The notice row (12c): a Claude Code turn is working in this dock's
   * folder — the chat's name, its latest call, the files changed so far,
   * the turn's clock. The output itself is never here; the row only says
   * that the folder is being edited beside you.
   */
  let now = $state(Date.now());
  $effect(() => {
    if (!app.busy || !term.open) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const notice = $derived.by(() => {
    if (!app.busy || !app.live || !term.cwd) return null;
    if (app.connection?.engine !== "claude-code") return null;
    if (chatKind(app.events) === "chat") return null;
    if (app.project?.root !== term.cwd) return null;
    const session = app.sessions.find((s) => s.id === app.activeSessionId);
    const name = session?.title ?? session?.first_user ?? "This chat";
    const started = turnStartedAt(app.events);
    return {
      name,
      call: latestCall(app.live.segments, term.cwd),
      files: filesChanged(app.live.segments),
      clock: started === null ? null : clockLabel(now - started),
    };
  });

  function onKey(e: KeyboardEvent) {
    if (!keyed) return;
    if (terminalChord(e)) {
      e.preventDefault();
      void toggleTerminal();
      return;
    }
    // The ⌘ chords are menu items on macOS since 099's tabs and arrive as
    // `menu` commands (`takeMenuCommand`); this keydown path is the one
    // for a build without those items, and is inert while they exist.
    const c = focusedChord(e, isMac);
    if (!c) return;
    const id = c === "new" ? "new_tab" : c === "close" ? "close_tab" : c === "next" ? "next_tab" : "prev_tab";
    if (takeMenuCommand(id)) e.preventDefault();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if term.open && mine}
  <section
    class="term-dock"
    class:collapsed={term.collapsed}
    style:height={term.collapsed ? "auto" : `${term.height}px`}
    bind:this={dock}
    aria-label="Terminal"
  >
    {#if !term.collapsed}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="term-grip"
        class:dragging
        role="separator"
        aria-orientation="horizontal"
        aria-label="Terminal height"
        aria-valuenow={term.height}
        title="Drag to resize · double-click to reset"
        onpointerdown={gripDown}
        ondblclick={resetHeight}
      ></div>
    {/if}
    <div class="term-strip" role="tablist" aria-label="Shells">
      {#each term.shells as s (s.id)}
        {@const label = tabLabel(s)}
        {@const exit = exitLabel(s)}
        <div
          class="term-tab"
          class:active={s.id === term.active}
          class:running={isRunning(s)}
          class:exited={!!s.exit}
          role="tab"
          aria-selected={s.id === term.active}
          tabindex="-1"
          title={s.exit ? `${label} ended — click to start a new shell in ${shortCwd(s.cwd, home)}` : `${s.shell} in ${shortCwd(s.cwd, home)}`}
          onclick={() => (s.exit ? void restartShell(s.id) : selectShell(s.id))}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (s.exit) void restartShell(s.id);
              else selectShell(s.id);
            }
          }}
        >
          {#if isRunning(s)}<span class="term-dot" aria-label="running"></span>{/if}
          <span class="term-tab-label">{label}</span>
          {#if exit}<span class="term-exit">{exit}</span>{/if}
          <button
            class="term-x"
            title="Close this shell{isMac ? ' (⌘W)' : ''}"
            aria-label="Close {label}"
            onclick={(e) => {
              e.stopPropagation();
              closeShell(s.id);
            }}>×</button
          >
        </div>
      {/each}
      <button class="term-plus" title="New shell{isMac ? ' (⌘T)' : ''}" aria-label="New shell" onclick={() => void newShell()}>
        <Icon name="plus" size={12} />
      </button>
      <span class="term-hint mono" title="⌃` opens, focuses, hides the terminal">⌃`</span>
      {#if term.cwd}
        <span class="term-cwd mono" title={term.cwd}>{shortCwd(term.cwd, home)}</span>
      {/if}
      <span class="term-spacer"></span>
      <button
        class="term-ctl"
        title={term.collapsed ? "Expand the terminal" : "Collapse to the strip"}
        aria-label={term.collapsed ? "Expand the terminal" : "Collapse the terminal"}
        onclick={toggleCollapsed}
      >
        <Icon name={term.collapsed ? "chev" : "minus"} size={12} />
      </button>
      <button class="term-ctl" title="Hide the pane (⌃`) — the shells keep running" aria-label="Hide the terminal" onclick={hidePane}>
        <Icon name="chevr" size={12} />
      </button>
      <button class="term-ctl" title="Close the terminal — every shell ends" aria-label="Close the terminal" onclick={closePane}>
        <Icon name="x" size={12} />
      </button>
    </div>
    {#if notice && !term.collapsed}
      <div class="term-notice" role="status">
        <Icon name="moon" size={12} />
        <span class="term-notice-name">{notice.name}</span>
        <span>is working in this folder</span>
        {#if notice.call}<span class="term-notice-sep">·</span><span class="mono term-notice-call">{notice.call}</span>{/if}
        {#if notice.files > 0}<span class="term-notice-sep">·</span><span>{notice.files} {notice.files === 1 ? "file" : "files"} so far</span>{/if}
        {#if notice.clock}<span class="term-notice-sep">·</span><span class="mono">{notice.clock}</span>{/if}
      </div>
    {/if}
    {#if !term.collapsed}
      <div class="term-body">
        {#each term.shells as s (s.id)}
          <TerminalShell shell={s} visible={s.id === term.active} />
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .term-dock {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: none;
    min-height: 0;
    border-top: 1px solid var(--line);
    background: var(--term);
  }
  .term-grip {
    position: absolute;
    top: -6px;
    left: 0;
    right: 0;
    height: 12px;
    cursor: row-resize;
    touch-action: none;
    z-index: 2;
  }
  .term-grip::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 5px;
    height: 1px;
    background: transparent;
    transition: background 0.12s;
  }
  .term-grip:hover::before,
  .term-grip.dragging::before {
    background: var(--accent);
  }
  /* The strip: 32px, the shells as tabs, the controls at the right. */
  .term-strip {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 32px;
    flex: none;
    padding: 0 6px 0 8px;
    background: var(--sheet);
    border-bottom: 1px solid var(--line);
    overflow: hidden;
  }
  .term-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 8px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
    border-bottom: 2px solid transparent;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }
  .term-tab:hover {
    color: var(--ink);
  }
  /* Active and focused — the accent rule (12c). */
  .term-tab.active {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .term-tab.exited {
    color: var(--dim);
    opacity: 0.75;
  }
  /* A foreground process — the blue dot: the live colour, not the
     accent, because it is not a turn (12c). */
  .term-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--live);
    flex: none;
  }
  .term-exit {
    color: var(--failed);
    font-size: 11px;
  }
  /* The × appears on hover, and stays on the active tab. */
  .term-x {
    background: none;
    border: none;
    padding: 0 2px;
    margin-right: -4px;
    font: inherit;
    font-size: 13px;
    line-height: 1;
    color: var(--dim);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .term-tab:hover .term-x,
  .term-tab.active .term-x,
  .term-x:focus-visible {
    opacity: 1;
  }
  .term-x:hover {
    color: var(--ink);
  }
  .term-plus,
  .term-ctl {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--dim);
    cursor: pointer;
  }
  .term-plus:hover,
  .term-ctl:hover {
    color: var(--ink);
    background: var(--well);
  }
  .term-hint {
    margin-left: 6px;
    font-size: 11px;
    color: var(--dim);
    opacity: 0.8;
  }
  .term-cwd {
    margin-left: 10px;
    font-size: 11px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .term-spacer {
    flex: 1;
  }
  /* The notice: one row under the strip while a Claude Code turn works in
     this folder (12c). */
  .term-notice {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
    color: var(--ink2);
    background: var(--accent-soft);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
    overflow: hidden;
  }
  .term-notice :global(svg) {
    color: var(--accent);
    flex: none;
  }
  .term-notice-name {
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 30%;
  }
  .term-notice-call {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .term-notice-sep {
    color: var(--dim);
  }
  .term-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
</style>
