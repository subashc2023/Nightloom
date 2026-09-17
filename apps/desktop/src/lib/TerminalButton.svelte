<script lang="ts">
  /**
   * New terminal, at the right end of the top bar's chips (board 12a; his
   * words: "you go to the top bar and … click new terminal"). One click
   * opens the pane with a shell in the project's folder; with the pane
   * open, a second click adds a shell to its strip. Dim in a chat with no
   * folder (12c) — the tooltip says why.
   */
  import Icon from "./Icon.svelte";
  import { openTerminalFromBar, term, terminalCwd } from "./terminal.svelte";
  import { shortCwd } from "./terminal";

  const cwd = $derived(terminalCwd());
  const home = $derived.by(() => {
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/|$)/.exec(cwd ?? "");
    return m ? m[1] : null;
  });
  const title = $derived(
    cwd
      ? term.open && !term.collapsed
        ? `New terminal (⌃\`) — a second shell in the dock under this chat, in ${shortCwd(cwd, home)}`
        : `New terminal (⌃\`) — a shell in ${shortCwd(cwd, home)}, docked under this chat`
      : "No terminal without a folder — this chat has none",
  );
</script>

<button
  class="ns-btn ghost small term-open"
  class:term-open-on={term.open}
  {title}
  aria-label="New terminal"
  disabled={!cwd}
  onclick={() => void openTerminalFromBar()}
>
  <Icon name="term" size={13} />
  <span class="term-open-label">Terminal</span>
</button>

<style>
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
