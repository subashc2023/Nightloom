<script lang="ts">
  import Icon from "./Icon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import {
    feedback,
    keepDraft,
    closeFeedback,
    discardFeedback,
    sendFeedback,
    feedbackContext,
  } from "./feedback.svelte";

  /**
   * His feedback to the agent (nightshift item 805): his words, what will
   * be attached, Send. Closing keeps the draft; Discard asks first.
   */
  let area = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    area?.focus();
  });

  const ctx = $derived(feedbackContext());
  const target = $derived(
    feedback.targets.find((t) => t.id === feedback.draft.about) ??
      feedback.targets.find((t) => t.default) ??
      null,
  );

  function key(e: KeyboardEvent) {
    if (feedback.confirmDiscard) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeFeedback();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendFeedback();
    }
  }
</script>

<svelte:window onkeydown={key} />

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) closeFeedback();
  }}
>
  <div class="ns-card dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title" tabindex="-1">
    <div class="head">
      <span class="mark"><Icon name="send" size={18} /></span>
      <h2 id="feedback-title">Send feedback</h2>
      <span class="spacer"></span>
      <button class="x" aria-label="Close (your words are kept)" onclick={closeFeedback}>
        <Icon name="x" size={14} />
      </button>
    </div>
    <p class="lead">
      Your words go to the agent that builds Nightloom as a new backlog item, exactly as typed. The next session
      sees it first.
    </p>
    <textarea
      bind:this={area}
      bind:value={feedback.draft.text}
      oninput={() => {
        feedback.last = null;
        keepDraft();
      }}
      placeholder="What should change, what broke, what you want…"
      rows="7"
      spellcheck="true"
    ></textarea>
    <div class="facts">
      <span class="ns-k">goes to</span>
      <span>
        {#if feedback.targets.length > 1}
          <select
            bind:value={feedback.draft.about}
            onchange={keepDraft}
            aria-label="Which project it is about"
          >
            {#each feedback.targets as t (t.id)}
              <option value={t.default ? "" : t.id}>{t.name}{t.default ? " (Nightloom)" : ""}</option>
            {/each}
          </select>
        {:else}
          {target ? target.name : "nightshift-code"}
        {/if}
      </span>
      <span class="ns-k">attached</span>
      <span class="attached">
        {ctx.chat_title ? `the chat “${ctx.chat_title}”` : ctx.chat ? "the open chat" : "no chat"}{ctx.project
          ? ` in ${ctx.project}`
          : ""} · this build · the time · {ctx.surface}
      </span>
    </div>
    {#if feedback.problem}<p class="problem" role="alert">{feedback.problem}</p>{/if}
    {#if feedback.last}<p class="done" role="status">{feedback.last}</p>{/if}
    <div class="actions">
      <button
        class="ns-btn ghost"
        disabled={!feedback.draft.text || feedback.sending}
        onclick={() => (feedback.confirmDiscard = true)}>Discard</button
      >
      <span class="spacer"></span>
      <button class="ns-btn" onclick={closeFeedback}>Close</button>
      <button
        class="ns-btn accent"
        disabled={!feedback.draft.text.trim() || feedback.sending}
        onclick={() => void sendFeedback()}
      >
        {feedback.sending ? "Sending…" : "Send"} <span class="kbd">⌘↩</span>
      </button>
    </div>
  </div>
</div>

{#if feedback.confirmDiscard}
  <ConfirmDialog
    title="Discard this feedback?"
    lead="The words in the box go; nothing was sent."
    facts={[["starts", feedback.draft.text.trim().slice(0, 80) + (feedback.draft.text.trim().length > 80 ? "…" : "")]]}
    confirmLabel="Discard"
    danger
    onconfirm={discardFeedback}
    onclose={() => (feedback.confirmDiscard = false)}
  />
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 39;
  }
  .dialog {
    width: 560px;
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
    padding: 22px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    border-color: var(--line2);
    font-family: var(--sans);
    font-size: 14px;
    color: var(--ink);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mark {
    color: var(--accent-ink);
    display: inline-flex;
  }
  .spacer {
    flex: 1;
  }
  .x {
    background: none;
    border: 0;
    color: var(--ink2);
    cursor: pointer;
    padding: 4px;
    display: inline-flex;
  }
  .x:hover {
    color: var(--ink);
  }
  h2 {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 500;
    margin: 0;
  }
  .lead {
    margin: 0;
    color: var(--ink2);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 120px;
    padding: 10px 12px;
    font: 14px/1.5 var(--sans);
    color: var(--ink);
    background: var(--bg, transparent);
    border: 1px solid var(--line2);
    border-radius: 6px;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent-ink);
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 16px;
    font-size: 13px;
    align-items: baseline;
    line-height: 1.45;
  }
  .attached {
    color: var(--ink2);
    overflow-wrap: anywhere;
  }
  select {
    font: inherit;
    color: var(--ink);
    background: transparent;
    border: 1px solid var(--line2);
    border-radius: 4px;
    padding: 2px 6px;
  }
  .problem {
    margin: 0;
    color: var(--failed);
  }
  .done {
    margin: 0;
    color: var(--accent-ink);
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .kbd {
    opacity: 0.6;
    font-size: 11px;
    margin-left: 4px;
  }

  /* Jarvis (the default layout): a raised card with a ruled head and the
     sans title, as ConfirmDialog draws it. */
  :global(:where(:root:not([data-layout="classic"]))) .dialog {
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65);
    padding: 20px 22px 18px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .head {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) h2 {
    font-family: var(--sans);
    font-weight: 400;
    font-size: 19px;
    letter-spacing: -0.005em;
  }
  :global(:where(:root:not([data-layout="classic"]))) .facts .ns-k {
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .actions {
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  @media (max-width: 480px) {
    .scrim {
      padding: 10px;
      align-items: flex-start;
    }
    .dialog {
      padding: 16px;
    }
    .facts {
      grid-template-columns: 1fr;
      gap: 2px;
    }
  }
</style>
