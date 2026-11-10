<script lang="ts">
  /**
   * One shell of the terminal pane (nightshift backlog 113): an xterm.js
   * instance over the pty `terminal.rs` opened. Kept mounted while its
   * tab is behind another (12c: "one instance per shell, kept alive while
   * its tab is hidden") — hidden with `display: none`, refitted when it
   * comes back, since a hidden grid measures as nothing.
   *
   * Bytes come in through the store's sink (`registerSink`), so a prompt
   * printed before this mounted is replayed first, and each write is
   * acknowledged once xterm has drawn it (`terminal_ack`, backlog 135:
   * past 256 KB undrawn the shell's output waits for the window, the
   * way a terminal has always slowed a `yes`); keystrokes go out as
   * xterm's `onData` text through `terminal_write`, which queues and
   * never waits — a program not reading its input answers an error, said
   * once in a toast; the grid's size goes out on every fit through
   * `terminal_resize`, and the kernel tells the shell (`SIGWINCH`).
   */
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import * as api from "./api";
  import { addToast } from "./state.svelte";
  import { isMac } from "./platform";
  import { continueEnded, keepLive, liveShell, registerSink, SHELL_GONE, term } from "./terminal.svelte";
  import { stripAnsi } from "./shellRun";
  import { terminalChord, type LiveShell, type ShellRow } from "./terminal";
  import { termTheme } from "./termTheme";

  /** `visible`: this shell's tab is in front *and* the dock is on screen
   *  and not collapsed — a hidden dock keeps the instance (backlog 137)
   *  and it refits when it shows again. */
  let { shell, visible }: { shell: ShellRow; visible: boolean } = $props();

  /** The container this mount draws in; the xterm's own element (`host`
   *  in the store's `LiveShell`) is appended to it and taken along when
   *  the component unmounts, so a move of the dock keeps the scrollback. */
  let container = $state<HTMLDivElement | null>(null);
  let xterm: Terminal | null = null;
  let fit: FitAddon | null = null;
  let live: LiveShell<Terminal, FitAddon> | null = null;

  function refit() {
    if (!xterm || !fit || !container || container.offsetWidth === 0 || container.offsetHeight === 0) return;
    fit.fit();
  }

  /**
   * Build the shell's xterm once — into an element of its own, registered
   * with the store — and wire everything that belongs to the instance
   * rather than to this mount: the key handler, the data and resize
   * handlers, the sink, the focus listeners. A later mount takes it back
   * from the store (`liveShell`) and only re-attaches the element.
   */
  function build(host: HTMLDivElement): LiveShell<Terminal, FitAddon> {
    const cs = getComputedStyle(document.documentElement);
    const t = new Terminal({
      theme: termTheme(),
      fontFamily: cs.getPropertyValue("--mono").trim() || "IBM Plex Mono, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      // ⌥ is the platform's on a Mac — ⌥← word-jumps are the shell's
      // business through its own escape, not xterm's meta.
      macOptionIsMeta: false,
      allowTransparency: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    // Opened into an element already on screen: xterm measures its cell
    // on `open`, and a detached element measures as nothing.
    t.open(host);
    // A block's tab says what it runs (item 503): the pty never prints it.
    if (shell.run) t.write(`\x1b[2m$ ${stripAnsi(shell.run.command).trim().split("\n").join("\r\n> ")}\x1b[0m\r\n`);
    // The pane's chords stay the window's: ⌃` (open · focus · hide) and,
    // on macOS, the ⌘ chords the dock handles while it has the focus
    // (⌘T, ⌘W, ⌘⇧], ⌘⇧[). Every other ⌘ chord is the app's too — ⌘K the
    // palette, ⌘M the model, ⌘, Settings — and never a shell key; on the
    // other platforms Ctrl is the shell's (⌃C, ⌃D, ⌃L) and only ⌃` leaves.
    t.attachCustomKeyEventHandler((e) => {
      if (terminalChord(e)) return false;
      // ⌘C copies the selection and ⌘V pastes, the browser's own way:
      // xterm sees neither as a key, and its copy/paste handlers run.
      if (isMac && e.metaKey) return false;
      return true;
    });
    // A refused write — the queue to a program not reading its input is
    // full — is said once, until a write goes through again.
    let refused = false;
    const unData = t.onData((data) => {
      // An ended shell has nothing to write to: the keys open one (529).
      if (shell.exit) {
        void continueEnded(shell.id, data);
        return;
      }
      void api.terminalWrite(shell.id, data).then(
        () => (refused = false),
        (e: unknown) => {
          // The program ended before its exit came: this key, too, goes
          // to the next shell (529).
          if (String(e).includes(SHELL_GONE)) {
            void continueEnded(shell.id, data);
            return;
          }
          if (refused) return;
          refused = true;
          addToast(`${shell.title}: ${String(e)}`);
        },
      );
    });
    const unResize = t.onResize(({ cols, rows }) => {
      void api.terminalResize(shell.id, cols, rows).catch(() => {});
    });
    const unsink = registerSink(shell.id, (bytes) =>
      t.write(bytes, () => {
        // A marker line (a string) is the store's own, not the pty's:
        // nothing to acknowledge.
        if (typeof bytes !== "string") void api.terminalAck(shell.id, bytes.length).catch(() => {});
      }),
    );
    // Which dock has the keyboard (blocker 155: there can be two) — read
    // at the event, since a drag moves the shell to another pane's dock.
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
        unData.dispose();
        unResize.dispose();
        unsink();
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
    // The first fit here, after the resize handler exists: the shell was
    // opened at a guessed grid and this is the call that corrects it; on
    // a re-mount it is the pane's new size the grid takes.
    refit();
    const ro = new ResizeObserver(() => refit());
    ro.observe(container);
    return () => {
      // The mount ends, the instance does not: the element is taken out
      // of this container for the next mount to append, and the store
      // disposes it with the shell (`closeShell`, `restartShell`).
      ro.disconnect();
      // Only if it is still ours: with two docks on screen (blocker 155)
      // the dock the shell moved to could mount it before this one
      // unmounts, and an unconditional remove would take the host out of
      // the new dock. A guard — in the harness the old teardown ran first
      // either way (113 pass 5 report).
      if (live && live.host.parentElement === container) live.host.remove();
      xterm = null;
      fit = null;
      live = null;
    };
  });

  // The shell ended (12c's exited state): say so in the body, in the dim
  // colour, under whatever it printed last. The tab carries the code; a
  // click on it starts a new shell in the same folder.
  $effect(() => {
    const exit = shell.exit;
    if (!exit || !xterm || !live || live.exitWritten) return;
    live.exitWritten = true;
    const how = exit.code !== null ? `exit ${exit.code}` : exit.signal ? `ended by ${exit.signal}` : "ended";
    xterm.write(
      shell.run
        ? `\r\n\x1b[2m[${shell.run.stopped ? "stopped by you" : how} — type to go on in a new shell beside this]\x1b[0m\r\n`
        : `\r\n\x1b[2m[${shell.shell} ${how} — type or click the tab for a new shell here]\x1b[0m\r\n`,
    );
  });

  // Coming to the front: fit to the pane (a hidden grid could not), and
  // take the focus when the store asked for it — for this shell's dock.
  $effect(() => {
    void term.focusTick;
    if (!visible) return;
    const asked = term.focusDock === (shell.pane ?? null);
    requestAnimationFrame(() => {
      refit();
      if (asked && term.docks[shell.pane ?? ""]?.active === shell.id && !shell.exit) xterm?.focus();
    });
  });
</script>

<div class="term-shell" class:hidden={!visible} bind:this={container}></div>

<style>
  .term-shell {
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 4px 0 0 8px;
    background: var(--term);
  }
  .term-shell.hidden {
    display: none;
  }
  .term-shell :global(.term-host),
  .term-shell :global(.xterm) {
    height: 100%;
  }
  /* xterm's own focus ring is a box the boards do not draw; the strip's
     accent rule on the active tab says which shell is live. */
  .term-shell :global(.xterm.focus) {
    outline: none;
  }
</style>
