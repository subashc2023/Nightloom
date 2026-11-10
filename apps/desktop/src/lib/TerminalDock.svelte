<script lang="ts">
  import { tip } from "./tip";
  /**
   * The terminal pane (nightshift backlog 113, boards 12a–12c): docked
   * under the content, a grip on its top edge, a strip of shells with +
   * and ×, the ⌃` hint, collapse and close, the notice row while a Claude
   * Code turn works in the same folder, and one `TerminalShell` per shell
   * underneath. Always mounted — it draws nothing while the pane is
   * closed — so ⌃` has somewhere to live without `App.svelte` carrying
   * it. Hidden (⌃`) or collapsed, the section and every shell stay
   * mounted and are only not displayed (backlog 137): an unmount disposed
   * each xterm with its scrollback and its screen, so a build's output
   * was gone on the next ⌃`, and a `vim` came back blank. Mounted once in every pane's dock slot (`App.svelte`'s
   * `.pane-dock`, agent L's mount point); the one whose `pane` is the
   * store's draws, and the first pane's instance owns the window keys.
   * One dock for the window by default (blocker 189), under the pane it
   * was opened from; a shell's tab dragged onto the other pane gives that
   * pane a dock of its own (blocker 155, his answer 2026-09-22), so each
   * instance draws the dock keyed by its own pane (`term.docks`) with that
   * pane's shells. A dock closes with its pane.
   */
  import { onMount } from "svelte";
  import { app, chatKind } from "./state.svelte";
  import { TERM_DRAG } from "./tabs";
  import { isMac } from "./platform";
  import Icon from "./Icon.svelte";
  import TerminalShell from "./TerminalShell.svelte";
  // Item 542: the Classic layout's strip and run row (1d4ca17's).
  import TerminalStripClassic from "./TerminalStripClassic.svelte";
  import { classic } from "./layout.svelte";
  import AgentTerminal from "./AgentTerminal.svelte";
  import { sendSoFar, stopRun } from "./shellRun.svelte";
  import {
    chatOfPane,
    closePane,
    closeShell,
    dockPaneCheck,
    hidePane,
    initTerminalEvents,
    newShell,
    openAgentTab,
    resetHeight,
    restartShell,
    saveHeight,
    selectShell,
    setHeight,
    shellsIn,
    takeMenuCommand,
    targetDock,
    term,
    terminalCwd,
    toggleCollapsed,
    toggleTerminal,
  } from "./terminal.svelte";
  import { exitMark, frontFolder, tabKind, tabNames, tabTip } from "./terminalStrip";
  import {
    clockLabel,
    filesChanged,
    focusedChord,
    isRunning,
    latestCall,
    restartsOnClick,
    shortCwd,
    terminalChord,
    turnStartedAt,
  } from "./terminal";

  /** The pane this instance sits under; `null` in a harness with no panes. */
  let { pane = null }: { pane?: string | null } = $props();

  onMount(() => {
    void initTerminalEvents();
  });

  /** The dock this instance draws: its pane's (blocker 155 — one per
   *  pane that has shells); with no pane to speak of, as in a harness,
   *  the window's. */
  const key = $derived(pane ?? targetDock() ?? "");
  const d = $derived(term.docks[key]);
  const shells = $derived(shellsIn(key));
  /** The instance that owns the window's keys: the first pane's. */
  const keyed = $derived(pane === null || app.tabs.panes[0]?.id === pane);

  $effect(() => {
    void app.tabs.panes.length;
    if (keyed) dockPaneCheck();
  });

  let dock = $state<HTMLElement | null>(null);
  let dragging = $state(false);

  /** The block in front, for the row under the strip (item 503). */
  const front = $derived(shells.find((s) => s.id === d?.active) ?? null);
  /** The chat this dock's Agent commands button opens. */
  const paneChatId = $derived(chatOfPane(key) ?? (key === app.tabs.focused ? app.activeSessionId : null));

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

  /** The tabs' names, told apart (item 528). */
  const names = $derived(tabNames(shells));
  /** The folder chip: the tab in front's folder, not the window's first
   *  (item 528: "the path belongs to its tab"). */
  const frontHome = $derived(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/.exec(front?.cwd ?? "")?.[1] ?? home);
  const where = $derived(frontFolder(front, frontHome));
  /** The strip's width, and where it gives up its extras so the tabs keep
   *  room (item 528): first the folder chip, then the controls' words —
   *  the icons and every tooltip stay. Measured in CSS pixels, so ⌘+ zoom
   *  narrows it the way a narrow window does. */
  let stripW = $state(0);
  const tabRoom = $derived(150 * Math.min(3, shells.length));
  const cwdAt = $derived(760 + tabRoom);
  const wordsAt = $derived(480 + tabRoom);
  /** Where New shell opens: the project's folder (`newShell`). */
  const newIn = $derived.by(() => {
    const c = terminalCwd();
    return c ? shortCwd(c, home) : "the project's folder";
  });
  /**
   * The notice row (12c): a Claude Code turn is working in this dock's
   * folder — the chat's name, its latest call, the files changed so far,
   * the turn's clock. The output itself is never here; the row only says
   * that the folder is being edited beside you.
   */
  let now = $state(Date.now());
  $effect(() => {
    if (!app.busy || !d?.open) return;
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

{#if d && shells.length > 0}
  <section
    class="term-dock"
    class:collapsed={d.collapsed}
    class:hidden={!d.open}
    style:height={d.collapsed ? "auto" : `${term.height}px`}
    bind:this={dock}
    aria-label="Terminal"
    aria-hidden={!d.open}
    data-dock={key}
  >
    {#if !d.collapsed}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="term-grip"
        class:dragging
        role="separator"
        aria-orientation="horizontal"
        aria-label="Terminal height"
        aria-valuenow={term.height}
        use:tip={"Drag to resize · double-click to reset"}
        onpointerdown={gripDown}
        ondblclick={resetHeight}
      ></div>
    {/if}
    <!-- The strip (item 528): every tab says what it is (folder · program, the
         ending as a small mark, the whole command and folder in its
         tooltip); every control has a word beside its icon, and its key in
         the tooltip. The words go at narrow docks; the tooltips stay. -->
    {#if classic()}
      <!-- Item 542: the Classic layout's strip, 1d4ca17's (TerminalStripClassic). -->
      <TerminalStripClassic part="strip" {d} {shells} {key} {home} {paneChatId} {front} />
    {:else}
    <div class="term-strip" class:no-cwd={stripW > 0 && stripW < cwdAt} class:no-words={stripW > 0 && stripW < wordsAt} role="toolbar" aria-label="Terminal" bind:clientWidth={stripW}>
      <div class="term-tabs" role="tablist" aria-label="Shells">
        {#each shells as s, i (s.id)}
          {@const n = names[i]}
          {@const mark = exitMark(s)}
          {@const kind = tabKind(s)}
          <div
            class="term-tab"
            class:active={s.id === d.active}
            class:running={isRunning(s)}
            class:exited={!!s.exit}
            role="tab"
            aria-selected={s.id === d.active}
            aria-label={`${n.text}${mark ? `, ${mark.words}` : isRunning(s) ? ", running" : ""}`}
            tabindex="-1"
            data-kind={kind}
            use:tip={tabTip(s, isMac)}
            onclick={() => (restartsOnClick(s) ? void restartShell(s.id) : selectShell(s.id))}
            draggable="true"
            ondragstart={(e) => {
              // Agent P's hunk (nightshift backlog 113's 12b, 2026-09-17),
              // per shell since blocker 155 (2026-09-22): dragging a shell
              // tab onto the other pane or its strip puts that shell in
              // that pane's dock — a second dock if it had none; the only
              // shell of a dock moves the dock (`moveShell`). The tab's own
              // type keeps a strip from reading it as a chat tab;
              // `app.draggingTerm` and `term.dragging` are the mirrors for
              // `dragover`, which cannot read the data.
              if (!e.dataTransfer) return;
              e.dataTransfer.setData(TERM_DRAG, String(s.id));
              e.dataTransfer.effectAllowed = "move";
              app.draggingTerm = true;
              term.dragging = s.id;
            }}
            ondragend={() => {
              app.draggingTerm = false;
              term.dragging = null;
            }}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (restartsOnClick(s)) void restartShell(s.id);
                else selectShell(s.id);
              }
            }}
          >
            <span class="term-kind" aria-hidden="true"><Icon name={kind === "agent" ? "agent" : kind === "run" ? "play" : "term"} size={12} /></span>
            <span class="term-tab-label"
              ><span class="term-tab-folder">{n.folder}</span
              >{#if n.what}<span class="term-tab-sep">·</span><span class="term-tab-what">{n.what}</span>{/if}</span
            >
            {#if isRunning(s)}<span class="term-dot" aria-hidden="true"></span>{/if}
            {#if mark}
              <span class="term-mark {mark.kind}" aria-hidden="true">
                {#if mark.kind === "ok"}<Icon name="check" size={11} />
                {:else if mark.kind === "restart"}<Icon name="refresh" size={11} />
                {:else if mark.kind === "stopped"}<Icon name="stop" size={9} />
                {:else}{mark.text}{/if}
              </span>
            {/if}
            <button
              class="term-x"
              use:tip={{ text: s.agentChat ? "Close this tab" : s.run && s.exit ? "Close this tab" : "Close this shell (it ends)", keys: isMac ? "⌘W" : undefined }}
              aria-label="Close {n.text}"
              onclick={(e) => {
                e.stopPropagation();
                closeShell(s.id);
              }}><Icon name="x" size={11} /></button
            >
          </div>
        {/each}
      </div>
      <button class="ns-btn ghost small term-btn" use:tip={{ text: `New shell: a shell of your own in ${newIn}, in this panel`, keys: isMac ? "⌘T" : undefined }} aria-label="New shell" onclick={() => void newShell(key)}>
        <Icon name="plus" size={13} /><span class="term-word">New shell</span>
      </button>
      <button
        class="ns-btn ghost small term-btn"
        use:tip={paneChatId ? "Agent commands: the commands this chat's agent ran, and their output, in a tab of their own (view only)" : "Agent commands: there is no chat in this pane, so no agent commands to show"}
        aria-label="Agent commands"
        disabled={!paneChatId}
        onclick={() => paneChatId && openAgentTab(paneChatId, key)}
      >
        <Icon name="agent" size={13} /><span class="term-word">Agent commands</span>
      </button>
      <span class="term-spacer"></span>
      {#if where}
        <span class="term-cwd mono" use:tip={where.tip}><Icon name="folder" size={12} /><span class="term-cwd-path">{where.short}</span></span>
      {/if}
      <button
        class="ns-btn ghost small term-btn"
        use:tip={d.collapsed ? "Expand: show the shells again" : "Collapse: shrink the terminal to this strip; the shells keep running"}
        aria-label={d.collapsed ? "Expand the terminal" : "Collapse the terminal"}
        onclick={() => toggleCollapsed(key)}
      >
        <span class="term-fold" class:up={d.collapsed}><Icon name="chev" size={13} /></span><span class="term-word">{d.collapsed ? "Expand" : "Collapse"}</span>
      </button>
      <button
        class="ns-btn ghost small term-btn"
        use:tip={{ text: "Hide the terminal; the shells keep running. The same key opens it again and puts the cursor in it", keys: "⌃`" }}
        aria-label="Hide the terminal"
        onclick={() => hidePane(key)}
      >
        <Icon name="eye-off" size={13} /><span class="term-word">Hide</span><kbd class="term-kbd">⌃`</kbd>
      </button>
      <button
        class="ns-btn ghost small term-btn term-close"
        use:tip={`Close the terminal: every shell in it ends${shells.length > 1 ? ` (${shells.length} tabs)` : ""}`}
        aria-label="Close the terminal"
        onclick={() => closePane(key)}
      >
        <Icon name="x" size={13} /><span class="term-word">Close</span>
      </button>
    </div>
    {/if}
    {#if notice && !d.collapsed}
      <div class="term-notice" role="status">
        <Icon name="moon" size={12} />
        <span class="term-notice-name">{notice.name}</span>
        <span>is working in this folder</span>
        {#if notice.call}<span class="term-notice-sep">·</span><span class="mono term-notice-call">{notice.call}</span>{/if}
        {#if notice.files > 0}<span class="term-notice-sep">·</span><span>{notice.files} {notice.files === 1 ? "file" : "files"} so far</span>{/if}
        {#if notice.clock}<span class="term-notice-sep">·</span><span class="mono">{notice.clock}</span>{/if}
      </div>
    {/if}
    {#if front?.run && !d.collapsed && classic()}
      <TerminalStripClassic part="run" {d} {shells} {key} {home} {paneChatId} {front} />
    {:else if front?.run && !d.collapsed}
      <!-- A block run from a reply (item 503): what became of its output, and
           the two ways out of a command that never ends. -->
      <div class="term-run" role="status">
        <span class="term-run-cap" use:tip={"Where this command's output goes: to the chat its block came from"}>Output</span>
        <span class="term-run-note">{front.exit ? (front.run.note ?? "Ended.") : `${front.run.note ? `${front.run.note} ` : ""}Running: what comes next goes to the chat when it ends.`}</span>
        {#if !front.exit}
          <span class="term-spacer"></span>
          <button class="ns-btn small" use:tip={"Send what it has printed so far to the chat; it keeps running"} onclick={() => front && void sendSoFar(front.id)}>Send output so far</button>
          <button class="ns-btn small danger" use:tip={"Stop the command: it gets ⌃C, and is ended if it has not stopped a moment later"} onclick={() => front && void stopRun(front.id)}><Icon name="stop" size={10} />Stop</button>
        {/if}
      </div>
    {/if}
    <div class="term-body" class:hidden={d.collapsed}>
      {#each shells as s (s.id)}
        {#if s.agentChat}
          <AgentTerminal shell={s} visible={s.id === d.active && d.open && !d.collapsed} />
        {:else}
          <TerminalShell shell={s} visible={s.id === d.active && d.open && !d.collapsed} />
        {/if}
      {/each}
    </div>
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
  /* Hidden, not gone: the shells keep their screens (backlog 137). */
  .term-dock.hidden {
    display: none;
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
  /* The strip (item 528, Filament IV): the panel colour, the shells as
     tabs on the left — the one in front opens onto the terminal under it,
     an amber rule on its top edge, as the main tab strip draws it — then
     the worded controls (their words go at narrow docks: `stripW`). */
  .term-strip {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 34px;
    flex: none;
    padding: 0 6px 0 0;
    background: var(--sheet);
    border-bottom: 1px solid var(--line);
    overflow: hidden;
  }
  .term-tabs {
    display: flex;
    align-self: stretch;
    min-width: 0;
    flex: 0 1 auto;
    overflow: hidden;
    margin-right: 4px;
  }
  .term-tab {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 72px;
    max-width: 240px;
    flex: 0 1 auto;
    padding: 0 6px 0 12px;
    font-family: var(--sans);
    font-size: 12.5px;
    color: var(--dim);
    border-right: 1px solid var(--line);
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }
  .term-tab:hover {
    color: var(--ink);
  }
  /* In front: the terminal's own colour, so the tab and its screen are one
     piece, and the accent rule on top. */
  .term-tab.active {
    color: var(--ink);
    background: var(--term);
    margin-bottom: -1px;
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .term-tab.exited:not(.active) {
    color: color-mix(in srgb, var(--dim) 80%, transparent);
  }
  .term-kind {
    display: inline-flex;
    flex: none;
    color: var(--dim);
  }
  .term-tab[data-kind="run"] .term-kind {
    color: var(--signal);
  }
  /* A long folder gives way first: the program after it stays whole. */
  .term-tab-label {
    display: inline-flex;
    align-items: baseline;
    min-width: 0;
    overflow: hidden;
  }
  .term-tab-folder {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .term-tab-what {
    flex: none;
  }
  .term-tab-sep {
    flex: none;
    margin: 0 5px;
    color: var(--dim);
  }
  .term-tab-what {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
  }
  /* A foreground process — the live dot (12c), lit where the theme lights. */
  .term-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--live);
    box-shadow: var(--glow-live);
    flex: none;
  }
  /* How it ended: a check (exit 0), the code (red), a stop square, or —
     his own shell — the restart arrow a click follows. */
  .term-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    border-radius: var(--r1);
    font: 500 10.5px var(--mono);
    line-height: 1;
  }
  .term-mark.ok {
    color: var(--done);
    background: color-mix(in srgb, var(--done) 14%, transparent);
  }
  .term-mark.fail,
  .term-mark.signal {
    color: var(--failed);
    background: color-mix(in srgb, var(--failed) 14%, transparent);
  }
  .term-mark.stopped {
    color: var(--ink2);
    background: var(--well);
  }
  .term-mark.restart {
    color: var(--dim);
  }
  /* The tab's × is always there, quiet; it lights on hover. */
  .term-x {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
    background: none;
    border: none;
    border-radius: var(--r1);
    color: var(--dim);
    cursor: pointer;
    opacity: 0.55;
  }
  .term-tab:hover .term-x,
  .term-tab.active .term-x,
  .term-x:focus-visible {
    opacity: 1;
  }
  .term-x:hover {
    color: var(--ink);
    background: var(--well);
  }
  .term-btn {
    gap: 5px;
    padding: 2px 7px;
    color: var(--ink2);
  }
  .term-btn :global(svg) {
    width: 13px;
    height: 13px;
    flex: none;
  }
  .term-fold {
    display: inline-flex;
  }
  .term-fold.up {
    transform: rotate(180deg);
  }
  .term-kbd {
    margin-left: 2px;
    padding: 0 4px;
    font: 10.5px var(--mono);
    color: var(--dim);
    border: 1px solid var(--line2);
    border-radius: 4px;
    line-height: 14px;
  }
  .term-close:hover:not(:disabled) {
    color: var(--failed);
  }
  /* The tab in front's folder: dim mono, the whole path in the tooltip. */
  .term-cwd {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    flex: 0 1 auto;
    margin-right: 6px;
    font-size: 11px;
    color: var(--dim);
  }
  .term-cwd :global(svg) {
    flex: none;
  }
  .term-cwd-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .term-spacer {
    flex: 1;
  }
  /* Narrow docks: the folder goes first, then the controls' words. */
  .term-strip.no-cwd .term-cwd,
  .term-strip.no-words .term-word,
  .term-strip.no-words .term-kbd {
    display: none;
  }
  .term-strip.no-words .term-btn {
    padding: 2px 6px;
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
    background: var(--signal-soft);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
    overflow: hidden;
  }
  .term-notice :global(svg) {
    color: var(--signal);
    flex: none;
  }
  /* Item 542: the Classic layout's notice, 1d4ca17's colours. */
  :global([data-layout="classic"]) .term-notice {
    background: var(--accent-soft);
  }
  :global([data-layout="classic"]) .term-notice :global(svg) {
    color: var(--accent);
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
  /* A running block's row: where its output goes, Send so far, Stop. */
  .term-run {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    min-height: 32px;
    padding: 0 8px 0 12px;
    font-size: 12px;
    color: var(--ink2);
    background: var(--term);
    border-bottom: 1px solid var(--line);
  }
  /* The row's name, mono capitals as Filament IV's group headings. */
  .term-run-cap {
    flex: none;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .term-run-note {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .term-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .term-body.hidden {
    display: none;
  }
</style>
