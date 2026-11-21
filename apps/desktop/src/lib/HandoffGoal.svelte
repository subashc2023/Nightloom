<script lang="ts">
  /**
   * Item 747 (2026-11-16): the hand-off notice's goal field, and the one
   * folded line that shows what Nightloom adds under the wrap-up message —
   * the fixed sections and the goal — so everything *Wrap up now* sends is on
   * the notice. Its own component so the notice in `Composer.svelte` gains
   * one tag: the goal is kept per chat in `handoff.svelte.ts` as he types.
   */
  import { goal, message, noteActivity, setGoal, wrapUpToSend } from "./handoff.svelte";
  import { keptOpen } from "./keptFolds.svelte";

  let { chat }: { chat: string | null } = $props();

  const text = $derived(message(chat));
  /** What goes under the message: the sent text less the message itself. */
  const added = $derived(wrapUpToSend(chat, text).slice(text.trimEnd().length).trim());
</script>

<label class="goal-row">
  <span class="goal-label">Goal for the next chat</span>
  <input
    type="text"
    class="goal-input"
    autocorrect="off"
    autocapitalize="off"
    spellcheck="false"
    placeholder="Optional — what the next chat is for, in your words"
    aria-label="Goal for the next chat"
    value={goal(chat)}
    oninput={(e) => {
      noteActivity();
      setGoal(chat, (e.currentTarget as HTMLInputElement).value);
    }}
  />
</label>
{#if added}
  <details class="goal-added" use:keptOpen={{ key: chat ? `fold:${chat}|handoff-added` : null }}>
    <summary>Nightloom adds the hand-off's fixed sections{goal(chat).trim() ? " and your goal" : ""} under this message</summary>
    <div class="goal-added-text">{added}</div>
  </details>
{/if}

<style>
  .goal-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12.5px;
  }
  .goal-label {
    flex: none;
    color: var(--dim);
  }
  .goal-input {
    flex: 1 1 0;
    min-width: 0;
    font: inherit;
    font-size: 12.5px;
    color: var(--ink);
    border: 1px solid var(--line2);
    padding: 4px 8px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .goal-input {
    background: var(--term);
    border-radius: var(--r1);
  }
  :global(:where([data-layout="classic"])) .goal-input {
    background: var(--paper);
    border-radius: 6px;
  }
  .goal-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .goal-input::placeholder {
    color: var(--dim);
    opacity: 0.8;
  }
  .goal-added {
    font-size: 12px;
    color: var(--dim);
  }
  .goal-added > summary {
    cursor: pointer;
    user-select: none;
  }
  .goal-added-text {
    margin-top: 4px;
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ink);
    line-height: 1.5;
  }
  @media (max-width: 520px) {
    .goal-row {
      flex-wrap: wrap;
    }
    .goal-input {
      flex-basis: 100%;
    }
  }
</style>
