<script lang="ts">
  /**
   * Item 542: the Classic layout's terminal strip and run row — 1d4ca17's
   * markup and CSS from `TerminalDock.svelte`, kept verbatim (before item
   * 528 restyled them). `TerminalDock` draws this in place of its Filament
   * IV strip while Settings → Appearance → Layout is Classic; the shells
   * under it stay mounted in the dock either way (an unmount would dispose
   * each xterm's scrollback, backlog 137). `part` picks the strip or the
   * run row; `key` is `TerminalDock`'s dock key.
   */
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { TERM_DRAG } from "./tabs";
  import { isMac } from "./platform";
  import Icon from "./Icon.svelte";
  import { sendSoFar, stopRun } from "./shellRun.svelte";
  import {
    closePane,
    closeShell,
    hidePane,
    newShell,
    openAgentTab,
    restartShell,
    selectShell,
    term,
    toggleCollapsed,
  } from "./terminal.svelte";
  import type { Dock } from "./terminal.svelte";
  import { exitLabel, isRunning, restartsOnClick, shortCwd, tabLabel } from "./terminal";
  import type { ShellRow } from "./terminal";

  interface Props {
    part: "strip" | "run";
    d: Dock;
    shells: ShellRow[];
    key: string;
    home: string | null;
    paneChatId: string | null;
    front: ShellRow | null;
  }
  let { part, d, shells, key, home, paneChatId, front }: Props = $props();
</script>

{#if part === "strip"}
    <div class="term-strip" role="tablist" aria-label="Shells">
      {#each shells as s (s.id)}
        {@const label = tabLabel(s)}
        {@const exit = exitLabel(s)}
        <div
          class="term-tab"
          class:active={s.id === d.active}
          class:running={isRunning(s)}
          class:exited={!!s.exit}
          role="tab"
          aria-selected={s.id === d.active}
          tabindex="-1"
          use:tip={s.agentChat ? "This chat's commands and their output, view only — drag onto the other pane to move it" : s.run ? s.run.command : s.exit ? `${label} ended — click to start a new shell in ${shortCwd(s.cwd, home)}` : `${s.shell} in ${shortCwd(s.cwd, home)} — drag onto the other pane for a terminal there`}
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
          {#if isRunning(s)}<span class="term-dot" aria-label="running"></span>{/if}
          <span class="term-tab-label">{label}</span>
          {#if exit}<span class="term-exit" class:ok={s.run && s.exit?.code === 0}>{exit}</span>{/if}
          <button
            class="term-x"
            use:tip={`Close this shell${isMac ? ' (⌘W)' : ''}`}
            aria-label="Close {label}"
            onclick={(e) => {
              e.stopPropagation();
              closeShell(s.id);
            }}>×</button
          >
        </div>
      {/each}
      <button class="term-plus" use:tip={`New shell${isMac ? ' (⌘T)' : ''}`} aria-label="New shell" onclick={() => void newShell(key)}>
        <Icon name="plus" size={12} />
      </button>
      <button
        class="term-plus"
        use:tip={paneChatId ? "Agent commands: what this chat's agent ran, and the output, view only" : "No chat in this pane, so no agent commands to show"}
        aria-label="Agent commands"
        disabled={!paneChatId}
        onclick={() => paneChatId && openAgentTab(paneChatId, key)}
      >
        <Icon name="agent" size={12} />
      </button>
      <span class="term-hint mono" use:tip={"⌃` opens, focuses, hides the terminal"}>⌃`</span>
      {#if term.cwd}
        <span class="term-cwd mono" use:tip={term.cwd}>{shortCwd(term.cwd, home)}</span>
      {/if}
      <span class="term-spacer"></span>
      <button
        class="term-ctl"
        use:tip={d.collapsed ? "Expand the terminal" : "Collapse to the strip"}
        aria-label={d.collapsed ? "Expand the terminal" : "Collapse the terminal"}
        onclick={() => toggleCollapsed(key)}
      >
        <Icon name={d.collapsed ? "chev" : "minus"} size={12} />
      </button>
      <button class="term-ctl" use:tip={"Hide the pane (⌃`) — the shells keep running"} aria-label="Hide the terminal" onclick={() => hidePane(key)}>
        <Icon name="chevr" size={12} />
      </button>
      <button class="term-ctl" use:tip={"Close the terminal — every shell in it ends"} aria-label="Close the terminal" onclick={() => closePane(key)}>
        <Icon name="x" size={12} />
      </button>
    </div>
{:else if front?.run}
      <div class="term-run" role="status">
        <span class="term-run-note">{front.exit ? (front.run.note ?? "Ended.") : `${front.run.note ? `${front.run.note} ` : ""}Running: what comes next goes to the chat when it ends.`}</span>
        {#if !front.exit}
          <span class="term-spacer"></span>
          <button class="term-run-btn" onclick={() => front && void sendSoFar(front.id)}>Send output so far</button>
          <button class="term-run-btn" onclick={() => front && void stopRun(front.id)}>Stop</button>
        {/if}
      </div>
{/if}

<style>
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
  .term-exit.ok {
    color: var(--done);
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
  .term-plus:disabled {
    opacity: 0.4;
    cursor: default;
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
  /* A running block's row: where its output goes, Send so far, Stop. */
  .term-run {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    min-height: 28px;
    padding: 0 8px 0 10px;
    font-size: 12px;
    color: var(--ink2);
    background: var(--sheet);
    border-bottom: 1px solid var(--line);
  }
  .term-run-note {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .term-run-btn {
    flex: none;
    height: 22px;
    padding: 0 8px;
    font: inherit;
    font-size: 12px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 5px;
    cursor: pointer;
  }
  .term-run-btn:hover {
    border-color: var(--line2);
  }
</style>
