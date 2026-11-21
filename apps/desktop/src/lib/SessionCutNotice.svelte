<script lang="ts">
  import { cutText, RESUMED_TEXT, type Cut } from "./sessionCut";
  import { exactTime } from "./time";
  import { tip } from "./tip";

  /**
   * Item 703: a turn that ended with agents still running — they ran in
   * its Claude Code process and ended with it. The chat's own Nightloom
   * notice look (the ruled amber mono line), in the theme's warn amber;
   * `resumed` once a later turn ran (a new process). Jarvis and Classic.
   */
  let { cuts, resumed }: { cuts: readonly Cut[]; resumed: boolean } = $props();
</script>

{#each cuts as c (c.at)}
  <div class="session-cut" role="status">
    <div
      class="session-cut-line"
      use:tip={`${exactTime(new Date(c.at).toISOString())} — the turn ended while these ran: ${c.agents.join("; ")}. Their transcripts are kept; the main agent can resume one with SendMessage.`}
    >
      <span class="session-cut-who">Nightloom</span>
      <span class="session-cut-text">{cutText(c.agents)}</span>
    </div>
    {#if resumed}<div class="session-cut-resumed">{RESUMED_TEXT}</div>{/if}
  </div>
{/each}

<style>
  .session-cut {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 14px 0;
    max-width: 760px;
  }
  /* The notice row of a reply (AssistantMessage `.notice`): a rule either
     side, the words between, mono, in the warn amber. */
  .session-cut-line {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--partial);
    min-width: 0;
  }
  .session-cut-line::before,
  .session-cut-line::after {
    content: "";
    flex: 1;
    min-width: 12px;
    height: 1px;
    background: var(--partial);
    opacity: 0.45;
  }
  .session-cut-who {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--partial-soft);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 10px;
  }
  .session-cut-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .session-cut-resumed {
    text-align: center;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
  }
</style>
