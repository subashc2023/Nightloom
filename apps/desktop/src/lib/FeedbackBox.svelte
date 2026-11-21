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
    feedbackImages,
    hasFeedback,
    addFeedbackImage,
    removeFeedbackImage,
    pastedImages,
    attachPageShot,
  } from "./feedback.svelte";
  import { MAX_FEEDBACK_IMAGES } from "./feedbackText";

  /**
   * His feedback to the agent (nightshift item 805): his words, what will
   * be attached, Send. Closing keeps the draft; Discard asks first.
   */
  let area = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    area?.focus();
  });

  const ctx = $derived(feedbackContext());
  const images = $derived(feedbackImages());
  const any = $derived(hasFeedback());

  /** Item 815: ⌘V of a screenshot attaches it. Words on the clipboard
   *  still paste as words; only image files are taken here. */
  async function paste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    if (!e.clipboardData?.getData("text/plain")) e.preventDefault();
    for (const img of await pastedImages(files)) {
      if (!(await addFeedbackImage(img.data, img.type, "paste"))) break;
    }
  }

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
  class:capturing={feedback.capturing}
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) closeFeedback();
  }}
>
  <div
    class="ns-card dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="feedback-title"
    tabindex="-1"
    onpaste={(e) => void paste(e)}
  >
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
    {#if images.length}
      <div class="shots" role="list" aria-label="Attached images">
        {#each images as img, i (img.stash)}
          <div class="shot" role="listitem">
            {#if feedback.imageData[img.stash]}
              <img
                src={`data:${img.media_type};base64,${feedback.imageData[img.stash]}`}
                alt={img.kind === "page" ? `Shot of the page (image ${i + 1})` : `Pasted image ${i + 1}`}
              />
            {:else}
              <span class="shot-wait">…</span>
            {/if}
            {#if img.kind === "page"}<span class="shot-tag">page</span>{/if}
            <button class="shot-x" aria-label={`Remove image ${i + 1}`} onclick={() => removeFeedbackImage(img.stash)}>
              <Icon name="x" size={10} />
            </button>
          </div>
        {/each}
      </div>
    {/if}
    <div class="attach-row">
      <button
        class="ns-btn ghost"
        disabled={feedback.capturing || images.length >= MAX_FEEDBACK_IMAGES}
        onclick={() => void attachPageShot()}
      >
        <Icon name="image" size={13} /> Attach a shot of this page
      </button>
      <span class="hint">or ⌘V a screenshot</span>
    </div>
    <div class="facts">
      <span class="ns-k">goes to</span>
      <!-- Always Nightloom's own backlog: feedback is only for Nightloom's development (item 816). -->
      <span>Nightloom</span>
      <span class="ns-k">attached</span>
      <span class="attached">
        {ctx.chat_title ? `the chat “${ctx.chat_title}”` : ctx.chat ? "the open chat" : "no chat"}{ctx.project
          ? ` in ${ctx.project}`
          : ""}{images.length ? ` · ${images.length === 1 ? "1 image" : `${images.length} images`}` : ""} · this build · the time · {ctx.surface}
      </span>
    </div>
    {#if feedback.problem}<p class="problem" role="alert">{feedback.problem}</p>{/if}
    {#if feedback.last}<p class="done" role="status">{feedback.last}</p>{/if}
    <div class="actions">
      <button
        class="ns-btn ghost"
        disabled={!(feedback.draft.text || images.length) || feedback.sending}
        onclick={() => (feedback.confirmDiscard = true)}>Discard</button
      >
      <span class="spacer"></span>
      <button class="ns-btn" onclick={closeFeedback}>Close</button>
      <button
        class="ns-btn accent"
        disabled={!any || feedback.sending}
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
    lead={images.length ? "The words and images in the box go; nothing was sent." : "The words in the box go; nothing was sent."}
    facts={[
      ["starts", feedback.draft.text.trim().slice(0, 80) + (feedback.draft.text.trim().length > 80 ? "…" : "")],
      ...(images.length ? [["images", images.length === 1 ? "1 attached" : `${images.length} attached`] as [string, string]] : []),
    ]}
    confirmLabel="Discard"
    danger
    onconfirm={discardFeedback}
    onclose={() => (feedback.confirmDiscard = false)}
  />
{/if}

<style>
  .scrim.capturing {
    visibility: hidden;
  }
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
  .shots {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .shot {
    position: relative;
    width: 84px;
    height: 60px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    overflow: hidden;
    background: var(--well, rgba(255, 255, 255, 0.04));
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .shot img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .shot-wait {
    color: var(--ink2);
  }
  .shot-tag {
    position: absolute;
    left: 4px;
    bottom: 4px;
    font: 500 9px var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
  }
  .shot-x {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 0;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    cursor: pointer;
  }
  .shot-x:hover {
    background: rgba(0, 0, 0, 0.85);
  }
  .attach-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .attach-row .ns-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .hint {
    color: var(--ink2);
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
