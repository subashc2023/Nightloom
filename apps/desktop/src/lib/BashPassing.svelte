<script lang="ts">
  // Item 633: Reticle's floating passing text on a running Bash row, fed by
  // the command's real output (`bashOutput.svelte.ts`) — never invented, so
  // a command that prints nothing shows nothing. Drawn under Combo and
  // Reticle; Sweep keeps today's row. Behind the row's text, right of its
  // argument, faint and masked top and bottom; each new line slides in from
  // below (a transform only, inside no-preference — Reduce motion: still).
  // Item 649: `ended` — the command's remnant, its last lines fading out
  // over LINGER_MS after its result (a fade, under no-preference only).
  import { LINGER_MS, passingLines } from "./bashOutput.svelte";

  let { id, ended = false }: { id: string; ended?: boolean } = $props();
  const lines = $derived(passingLines(id));
  // Restarts the slide on each new last line.
  const last = $derived(lines.length ? `${lines.length}:${lines[lines.length - 1]}` : "");
</script>

{#if lines.length}
  <span class="passing" class:ended aria-hidden="true" data-testid="bash-passing" style:--linger="{LINGER_MS}ms">
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
    /* Item 656 (his "still dont see the bash text"): the newest line — the
       bottom one — sat in the mask's bottom fade and on Reticle's dashed bus
       at 50 %, so it could not be seen. It now ends above the bus (22 px,
       not 30), only older lines fade (top), and the ink is 0.7. */
    height: 22px;
    width: 220px;
    overflow: hidden;
    pointer-events: none;
    z-index: -1;
    opacity: 0.7;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    -webkit-mask: linear-gradient(180deg, transparent, #000 55%);
    mask: linear-gradient(180deg, transparent, #000 55%);
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
    .passing.ended {
      animation: pass-out var(--linger, 2400ms) ease-in both;
    }
    @keyframes pass-out {
      from {
        opacity: 0.7;
      }
      60% {
        opacity: 0.55;
      }
      to {
        opacity: 0;
      }
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
