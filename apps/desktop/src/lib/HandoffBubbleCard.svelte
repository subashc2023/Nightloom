<script lang="ts">
  /**
   * The wrap-up as his message (item 706): a Nightloom hand-off card on his
   * side — a label, the goal or the message's first line, and the whole
   * text folded under it. The fold is kept, as every view's is. The turn's
   * own buttons (Copy, Rewind, Edit …) stay under the bubble; an edit makes
   * the message his plain text again (`handoffBubble.ts`).
   */
  import Icon from "./Icon.svelte";
  import { keptOpen } from "./keptFolds.svelte";
  import type { HandoffMessage } from "./handoffBubble";

  let { handoff, keep = null, classic = false }: {
    handoff: HandoffMessage;
    /** The bubble's fold key: equal wrap-ups in two chats keep their own fold. */
    keep?: string | null;
    /** Classic's language (the well, the soft accent line) rather than Jarvis's. */
    classic?: boolean;
  } = $props();

  const key = $derived(`${keep ?? "handoff"}|handoff|${handoff.text.length}|${handoff.text.slice(0, 60)}`);
</script>

<div class="hb-card" class:classic data-handoff-bubble data-find-text={handoff.text}>
  <div class="hb-head">
    <Icon name="moon" size={13} />
    <span class="hb-title">Nightloom hand-off</span>
    <span class="hb-sub">wrap-up sent for you</span>
  </div>
  <div class="hb-headline">{#if handoff.goal}<span class="hb-goal">Goal</span>{/if}{handoff.headline}</div>
  <details class="hb-fold" use:keptOpen={{ key }}>
    <summary>The message · {handoff.lines} {handoff.lines === 1 ? "line" : "lines"}</summary>
    <pre class="hb-text">{handoff.text}</pre>
  </details>
</div>

<style>
  .hb-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: min(420px, 100%);
    max-width: 100%;
    border: 1px solid var(--line2);
    border-left: 3px solid var(--accent);
    border-radius: var(--r2);
    background: var(--term);
    padding: 8px 10px;
  }
  .hb-card.classic {
    border-color: var(--accent-soft);
    border-left-color: var(--accent);
    border-radius: 8px;
    background: var(--well);
  }
  .hb-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--accent-ink);
  }
  .hb-title {
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .hb-sub {
    margin-left: auto;
    font-size: 11px;
    color: var(--dim);
  }
  .hb-headline {
    font-size: 13px;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .hb-goal {
    margin-right: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--dim);
  }
  .hb-fold summary {
    font-size: 12px;
    color: var(--dim);
    cursor: pointer;
  }
  .hb-text {
    margin: 6px 0 0;
    font-family: inherit;
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 420px;
    overflow: auto;
    color: var(--ink2);
  }
</style>
