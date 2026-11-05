<script lang="ts">
  /**
   * The Agent commands tab (nightshift item 503, 2026-11-04): a chat's shell
   * calls in an xterm that takes no input — no pty, no shell, typing goes
   * nowhere. Its text is a pure function of the chat's record
   * (`agentCommands.ts`), so an old chat has it and a relaunch rebuilds it.
   * The instance is kept by the store across mounts like a shell's. Text is
   * appended, never redrawn, while the new text extends what is written, so
   * his scroll and selection stay; a change further back (a rewind, a turn's
   * end replacing a subagent's live rows with its record) rewrites the grid
   * and puts the scroll back.
   */
  import { onMount, untrack } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import * as api from "./api";
  import { paneChat } from "./state.svelte";
  import { isMac } from "./platform";
  import { keepLive, liveShell, term } from "./terminal.svelte";
  import { terminalChord, type LiveShell, type ShellRow } from "./terminal";
  import { termTheme } from "./termTheme";
  import { commandsOf, commandsText, runningOf, type AgentCommand } from "./agentCommands";
  import type { SessionEvent } from "./types";

  let { shell, visible }: { shell: ShellRow; visible: boolean } = $props();

  let container = $state<HTMLDivElement | null>(null);
  let xterm: Terminal | null = null;
  let fit: FitAddon | null = null;
  let live: LiveShell<Terminal, FitAddon> | null = null;

  /** The chat's record as the window holds it, if it does. */
  const held = $derived(shell.agentChat ? paneChat(shell.agentChat) : null);
  /** Its log read from disk, for a chat nothing on screen holds. */
  let disk = $state<SessionEvent[] | null>(null);
  let chatGone = $state(false);

  $effect(() => {
    const chat = shell.agentChat;
    if (!visible || held || !chat) return;
    let stale = false;
    void api
      .transcript(false, chat)
      .then((events) => {
        if (stale) return;
        disk = events;
        chatGone = events.length === 0;
      })
      .catch(() => {});
    return () => (stale = true);
  });

  /** Changes only when a call starts or ends, not per streamed word. */
  const stamp = $derived.by(() => {
    if (!visible) return "";
    const segs = held?.live?.segments ?? [];
    let calls = 0;
    let ended = 0;
    const walk = (list: typeof segs) => {
      for (const s of list) {
        if (s.kind !== "tool") continue;
        calls++;
        if (s.call.result) ended++;
        if (s.call.children) walk(s.call.children);
      }
    };
    walk(segs);
    return `${held?.events.length ?? -1}|${disk?.length ?? -1}|${calls}|${ended}|${held?.running ?? false}`;
  });

  let rows = $state.raw<AgentCommand[]>([]);
  const running = $derived(held?.running ? runningOf(rows) : []);

  function draw() {
    const t = xterm;
    if (!t || !live) return;
    const list = commandsOf(held?.events ?? disk ?? [], held?.live?.segments ?? null);
    rows = list;
    const text = commandsText(list, held?.running ?? false);
    const was = live.written ?? "";
    if (text.startsWith(was)) {
      if (text.length > was.length) t.write(text.slice(was.length));
    } else {
      const buf = t.buffer.active;
      const atEnd = buf.viewportY >= buf.baseY;
      const place = buf.viewportY;
      t.reset();
      t.write(text, () => {
        if (atEnd) t.scrollToBottom();
        else t.scrollToLine(place);
      });
    }
    live.written = text;
  }

  $effect(() => {
    if (!stamp) return;
    untrack(draw);
  });

  function refit() {
    if (!xterm || !fit || !container || container.offsetWidth === 0 || container.offsetHeight === 0) return;
    fit.fit();
  }

  function build(host: HTMLDivElement): LiveShell<Terminal, FitAddon> {
    const cs = getComputedStyle(document.documentElement);
    const t = new Terminal({
      theme: termTheme(),
      fontFamily: cs.getPropertyValue("--mono").trim() || "IBM Plex Mono, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      // No input, no cursor: this is a record, not a shell.
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      // The log's "\n"s, as a pty's line discipline would have turned them.
      convertEol: true,
      scrollback: 50000,
      allowTransparency: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host);
    // Only the window's chords and ⌘C matter here; as in `TerminalShell`.
    t.attachCustomKeyEventHandler((e) => !(terminalChord(e) || (isMac && e.metaKey)));
    const onFocus = () => (term.focused = shell.pane ?? null);
    const onBlur = () => {
      if (term.focused === (shell.pane ?? null)) term.focused = null;
    };
    t.textarea?.addEventListener("focus", onFocus);
    t.textarea?.addEventListener("blur", onBlur);
    return {
      host,
      xterm: t,
      fit: f,
      exitWritten: false,
      dispose: () => {
        t.textarea?.removeEventListener("focus", onFocus);
        t.textarea?.removeEventListener("blur", onBlur);
        t.dispose();
      },
    };
  }

  onMount(() => {
    if (!container) return;
    const kept = liveShell(shell.id) as LiveShell<Terminal, FitAddon> | undefined;
    if (kept) {
      live = kept;
      container.appendChild(live.host);
    } else {
      const host = document.createElement("div");
      host.className = "term-host";
      container.appendChild(host);
      live = build(host);
      keepLive(shell.id, live);
    }
    xterm = live.xterm;
    fit = live.fit;
    refit();
    if (visible) untrack(draw);
    const ro = new ResizeObserver(() => refit());
    ro.observe(container);
    return () => {
      ro.disconnect();
      if (live && live.host.parentElement === container) live.host.remove();
      xterm = null;
      fit = null;
      live = null;
    };
  });

  $effect(() => {
    void term.focusTick;
    if (!visible) return;
    requestAnimationFrame(() => refit());
  });

</script>

<div class="agent-term" class:hidden={!visible}>
  {#if running.length > 0}
    <div class="agent-running mono" role="status">
      <span class="agent-dot" aria-hidden="true"></span>
      <span class="agent-cmd">running: {running[0].command.split("\n")[0]}</span>
      {#if running.length > 1}<span class="agent-more">and {running.length - 1} more</span>{/if}
      <span class="agent-more">its output lands when it ends</span>
    </div>
  {:else if rows.length === 0 && (held || disk)}
    <div class="agent-running" role="status">
      {chatGone && !held ? "That chat is gone." : "No shell commands in this chat yet."}
    </div>
  {/if}
  <div class="agent-grid" bind:this={container}></div>
</div>

<style>
  .agent-term {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--term);
  }
  .agent-term.hidden {
    display: none;
  }
  .agent-running {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    height: 24px;
    padding: 0 10px;
    font-size: 12px;
    color: var(--dim);
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
    overflow: hidden;
  }
  .agent-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--live);
    flex: none;
  }
  .agent-cmd {
    color: var(--ink2);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .agent-more {
    flex: none;
  }
  .agent-grid {
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 4px 0 0 8px;
  }
  .agent-grid :global(.term-host),
  .agent-grid :global(.xterm) {
    height: 100%;
  }
  .agent-grid :global(.xterm.focus) {
    outline: none;
  }
</style>
