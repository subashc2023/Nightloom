<script lang="ts">
  /**
   * New terminal, at the right end of the top bar's chips (board 12a; his
   * words: "you go to the top bar and … click new terminal"). One click
   * opens the pane with a shell in the project's folder; with the pane
   * open, a second click adds a shell to its strip. Dim in a chat with no
   * folder (12c) — the tooltip says why.
   */
  import Icon from "./Icon.svelte";
  import { anyOpen, dockAt, openTerminalFromBar, targetDock, terminalCwd } from "./terminal.svelte";
  import { shortCwd } from "./terminal";

  /** `bar` (the top bar's chip, the original) or `foot` — a row in the
   *  sidebar's foot beside Settings, where it lives since 2026-09-18 (his
   *  words: "move the terminal button to the bottom row … right next to
   *  the settings button; that might save some space"). */
  let { variant = "bar" }: { variant?: "bar" | "foot" } = $props();

  const cwd = $derived(terminalCwd());
  const home = $derived.by(() => {
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/.exec(cwd ?? "");
    return m ? m[1] : null;
  });
  /** The dock a click acts on (blocker 155: the focused pane's, else the
   *  window's), and whether any dock is on screen. */
  const target = $derived(dockAt(targetDock()));
  const lit = $derived(anyOpen());
  const title = $derived(
    cwd
      ? target?.open && !target.collapsed
        ? `New terminal (⌃\`) — a second shell in the dock under this chat, in ${shortCwd(cwd, home)}`
        : `New terminal (⌃\`) — a shell in ${shortCwd(cwd, home)}, docked under this chat`
      : "No terminal without a folder — this chat has none",
  );
</script>

{#if variant === "foot"}
  <button
    class="term-foot"
    class:term-open-on={lit}
    {title}
    aria-label="New terminal"
    disabled={!cwd}
    onclick={() => void openTerminalFromBar()}
  >
    <Icon name="term" size={13} />
    <span>Terminal</span>
    <span class="term-spacer"></span>
    <span class="term-kbd">⌃`</span>
  </button>
{:else}
  <button
    class="ns-btn ghost small term-open"
    class:term-open-on={lit}
    {title}
    aria-label="New terminal"
    disabled={!cwd}
    onclick={() => void openTerminalFromBar()}
  >
    <Icon name="term" size={13} />
    <span class="term-open-label">Terminal</span>
  </button>
{/if}

<style>
  /* The foot row, drawn like the sidebar's Settings row (`.foot-btn`). */
  .term-foot {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--line);
    color: var(--dim);
    font-size: 12.5px;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .term-foot:hover:not(:disabled) {
    color: var(--ink);
  }
  .term-foot:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .term-spacer {
    flex: 1;
  }
  .term-kbd {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  .term-open {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .term-open-on {
    color: var(--accent-ink);
  }
  /* The word goes at the bar's narrow widths; the glyph is enough. */
  @media (max-width: 1060px) {
    .term-open-label {
      display: none;
    }
  }
</style>
