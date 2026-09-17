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
  import { keepLive, liveShell, registerSink, term } from "./terminal.svelte";
  import { terminalChord, type LiveShell, type ShellRow } from "./terminal";

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

  /** The app's tokens, read once at mount so the grid matches the theme
   *  the window is in (`--term` is the ground the boards draw). */
  function theme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      background: v("--term", "#131110"),
      foreground: v("--ink", "#ece7dc"),
      cursor: v("--accent", "#e0a458"),
      cursorAccent: v("--term", "#131110"),
      selectionBackground: v("--accent-soft", "#3a2d1c"),
      black: "#1b1916",
      brightBlack: v("--dim", "#8d8676"),
      red: v("--failed", "#e57373"),
      brightRed: "#f2bcbc",
      green: v("--done", "#7cc48a"),
      brightGreen: "#bfe6c4",
      yellow: v("--accent", "#e0a458"),
      brightYellow: v("--accent-ink", "#f0c27a"),
      blue: v("--live", "#7fb3f0"),
      brightBlue: "#a9ccf5",
      magenta: "#c9a3d6",
      brightMagenta: "#dcbfe6",
      cyan: "#7fc7c0",
      brightCyan: "#a8ddd8",
      white: v("--ink2", "#c9c2b3"),
      brightWhite: v("--ink", "#ece7dc"),
    };
  }

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
      theme: theme(),
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
      void api.terminalWrite(shell.id, data).then(
        () => (refused = false),
        (e: unknown) => {
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
    const onFocus = () => (term.focused = true);
    const onBlur = () => {
      if (term.focused) term.focused = false;
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
      live?.host.remove();
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
    xterm.write(`\r\n\x1b[2m[${shell.shell} ${how} — click the tab for a new shell here]\x1b[0m\r\n`);
  });

  // Coming to the front: fit to the pane (a hidden grid could not), and
  // take the focus when the store asked for it.
  $effect(() => {
    void term.focusTick;
    if (!visible) return;
    requestAnimationFrame(() => {
      refit();
      if (term.active === shell.id && !shell.exit) xterm?.focus();
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
