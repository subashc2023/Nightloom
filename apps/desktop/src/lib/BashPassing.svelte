<script lang="ts">
  // Item 633: Reticle's floating passing text on a running Bash row, fed by
  // the command's real output (`bashOutput.svelte.ts`) — never invented, so
  // a command that prints nothing shows nothing. Drawn under Combo and
  // Reticle; Sweep keeps today's row. Behind the row's text, right of its
  // argument, faint and masked top and bottom; each new line slides in from
  // below (a transform only, inside no-preference — Reduce motion: still).
  import { passingLines } from "./bashOutput.svelte";

  let { id }: { id: string } = $props();
  const lines = $derived(passingLines(id));
  // Restarts the slide on each new last line.
  const last = $derived(lines.length ? `${lines.length}:${lines[lines.length - 1]}` : "");
</script>

{#if lines.length}
  <span class="passing" aria-hidden="true" data-testid="bash-passing">
    {#key last}
      <span class="pl">{#each lines as l, i (i)}<span>{l}</span>{/each}</span>
    {/key}
  </span>
{/if}

<style>
  .passing {
    position: absolute;
    right: 196px;
    top: 2px;
    height: 30px;
    width: 220px;
    overflow: hidden;
    pointer-events: none;
    z-index: -1;
    opacity: 0.5;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    -webkit-mask: linear-gradient(180deg, transparent, #000 35%, #000 72%, transparent);
    mask: linear-gradient(180deg, transparent, #000 35%, #000 72%, transparent);
  }
  .pl {
    display: flex;
    flex-direction: column;
    font: 8.5px/10px var(--mono, ui-monospace, monospace);
    color: var(--signal);
    white-space: pre;
    text-align: left;
  }
  .pl span {
    overflow: hidden;
    text-overflow: clip;
  }
  /* Today's motion keeps today's row (item 616: passing text is Reticle's,
     taken into Combo). */
  :global(.trace[data-motion="sweep"]) .passing {
    display: none;
  }
  @media (prefers-reduced-motion: no-preference) {
    .pl {
      animation: pass-in 0.24s steps(4, end) both;
    }
    @keyframes pass-in {
      from {
        transform: translateY(10px);
      }
      to {
        transform: translateY(0);
      }
    }
  }
  /* A narrow pane: no room beside the argument. */
  @media (max-width: 720px) {
    .passing {
      display: none;
    }
  }
</style>
