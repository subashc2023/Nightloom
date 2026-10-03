<script lang="ts">
  /*
   * *Fold into thread* on an aside (nightshift backlog 282): `part =
   * "button"` is the action in the card's (or tab's) head; `part =
   * "panel"` is the fold under the exchanges — the picker when the chat
   * has no thread, the turn while it writes, then the summary to review
   * with Append, Edit and Cancel. Nothing is written until Append, and the
   * app writes it (to the thread's log.md), not the model. The why and the
   * rules are in `asideFold.ts`.
   */
  import { app, chatMode, chatThread, type Aside } from "./state.svelte";
  import { FOLD_BLOCK_TEXT, foldBlocked, foldedWarning } from "./asideFold";
  import {
    answerFoldDiscard,
    appendFold,
    continueFold,
    foldDiscard,
    requestCancelFold,
    setFoldEditing,
    setFoldText,
    startFold,
  } from "./asideFold.svelte";
  import { renderMarkdown } from "./markdown";
  import { tip } from "./tip";
  import Icon from "./Icon.svelte";
  import ThreadPicker from "./ThreadPicker.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  let {
    aside,
    part,
    open,
  }: {
    aside: Aside;
    part: "button" | "panel";
    /** The aside's chat is the open one. */
    open: boolean;
  } = $props();

  const fold = $derived(aside.fold ?? null);
  const blocked = $derived(
    foldBlocked({
      mode: open ? chatMode(app.events) : "normal",
      claudeCode: app.connection?.engine === "claude-code",
      open,
      answered: aside.turns.filter((t) => t.partial.trim()).length,
    }),
  );
  /** The button draws on an asked aside in a project (threads live in
   *  one); a fold under way shows its panel instead. */
  const shown = $derived(!aside.draft && app.project !== null && !fold);
  const bound = $derived(open ? chatThread(app.events) : null);
  const warning = $derived(foldedWarning(aside.foldedInto));
  let appending = $state(false);

  async function append(): Promise<void> {
    appending = true;
    try {
      await appendFold(aside);
    } finally {
      appending = false;
    }
  }
</script>

{#if part === "button"}
  {#if shown}
    <button
      class="ns-btn ghost small fold-btn"
      disabled={blocked !== null}
      use:tip={blocked
        ? FOLD_BLOCK_TEXT[blocked]
        : (bound
            ? `Fold this aside into ◇ ${bound}: one turn here writes a summary (your words verbatim, with pointers); you review it, then Nightloom appends it to the thread's log.md`
            : "Fold this aside into a research thread — this chat has none yet, so you pick one first") +
          (warning ? `\n${warning}` : "")}
      onclick={() => void startFold(aside)}><Icon name="think" size={11} /> Fold into thread</button
    >
  {/if}
{:else if fold}
  <div class="fold" role="region" aria-label="Fold into thread">
    <div class="fold-head">
      <span class="fold-title"
        >Fold into thread{#if fold.slug}<span class="fold-slug">◇ {fold.slug}</span>{/if}</span
      >
    </div>
    {#if warning && fold.stage !== "pick"}
      <div class="fold-warn">{warning}</div>
    {/if}
    {#if fold.stage === "pick"}
      <p class="fold-note">This chat has no thread yet. Pick one (or start one) — the chat is bound to it — then write the summary.</p>
      {#if open}
        <ThreadPicker list />
      {:else}
        <p class="fold-note">Open the chat to pick its thread.</p>
      {/if}
      <div class="fold-row">
        <button class="ns-btn small" disabled={!bound || !open || blocked !== null} onclick={() => void continueFold(aside)}
          >{bound ? `Write the summary for ◇ ${bound}` : "Write the summary"}</button
        >
        <button class="ns-btn ghost small" onclick={() => requestCancelFold(aside)}>Cancel</button>
      </div>
    {:else if fold.stage === "asking"}
      <div class="fold-wait" role="status">
        <span class="roll" aria-hidden="true"><Icon name="moon" size={14} /></span>
        <span
          >Writing the summary in this aside{app.busy ? " — it starts when the chat's turn ends" : ""}… nothing is written yet.</span
        >
      </div>
      <div class="fold-row">
        <button class="ns-btn ghost small" onclick={() => requestCancelFold(aside)}>Stop</button>
      </div>
    {:else if fold.stage === "error"}
      <div class="fold-err">{fold.error ?? "the fold's turn failed"}</div>
      <div class="fold-row">
        <button class="ns-btn small" disabled={!open || blocked !== null} onclick={() => void continueFold(aside)}>Try again</button>
        <button class="ns-btn ghost small" onclick={() => requestCancelFold(aside)}>Cancel</button>
      </div>
    {:else}
      <p class="fold-note">
        Review it: <b>Append</b> adds it, dated, to <code>.agents/threads/{fold.slug}/log.md</code>; the chat's next wrap-up folds
        it into thread.md.
      </p>
      {#if fold.editing}
        <textarea
          class="fold-edit"
          aria-label="The fold's summary, editable"
          value={fold.text}
          onkeydown={(e) => {
            // Escape leaves the edit box, never the card (it would close it).
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            setFoldEditing(aside, false);
          }}
          oninput={(e) => setFoldText(aside, (e.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      {:else}
        <div class="fold-text markdown">{@html renderMarkdown(fold.text)}</div>
      {/if}
      <div class="fold-row">
        <button class="ns-btn accent small" disabled={appending || !fold.text.trim()} onclick={() => void append()}
          >{appending ? "Appending…" : "Append"}</button
        >
        <button class="ns-btn ghost small" onclick={() => setFoldEditing(aside, !fold.editing)}
          >{fold.editing ? "Done editing" : "Edit"}</button
        >
        <button
          class="ns-btn ghost small"
          use:tip={fold.edited ? "Drop the summary — asks first, since you edited it" : "Drop the summary; nothing was written"}
          onclick={() => requestCancelFold(aside)}>Cancel</button
        >
        {#if fold.edited}<span class="fold-mark">edited</span>{/if}
      </div>
    {/if}
  </div>
  {#if foldDiscard.aside === aside}
    <ConfirmDialog
      title="Discard the edited summary?"
      lead="Your edit of the fold's summary is dropped; nothing is appended to the thread's log."
      confirmLabel="Discard"
      danger
      onconfirm={() => answerFoldDiscard(true)}
      onclose={() => answerFoldDiscard(false)}
    />
  {/if}
{/if}

<style>
  .fold-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .fold {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
    padding: 8px 10px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--paper);
    font-family: var(--sans);
    font-size: 12.5px;
    color: var(--ink2);
  }
  .fold-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .fold-title {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .fold-slug {
    text-transform: none;
    letter-spacing: 0;
    color: var(--ink);
    font-size: 12px;
  }
  .fold-note {
    margin: 0;
    color: var(--dim);
  }
  .fold-note code {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .fold-warn {
    color: var(--partial, var(--ink2));
    font-size: 12px;
  }
  .fold-err {
    color: var(--failed, #d66);
  }
  .fold-wait {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--dim);
  }
  .fold-wait .roll {
    display: inline-flex;
    animation: fold-roll 1.6s linear infinite;
  }
  @keyframes fold-roll {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fold-wait .roll {
      animation: none;
    }
  }
  .fold-text {
    max-height: 40vh;
    overflow-y: auto;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--well);
    color: var(--ink);
    font-family: var(--transcript-font, var(--sans));
    font-size: 13px;
    line-height: 1.5;
  }
  .fold-edit {
    min-height: 12rem;
    max-height: 40vh;
    resize: vertical;
    box-sizing: border-box;
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--well);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
  }
  .fold-edit:focus {
    outline: none;
    border-color: var(--accent);
  }
  .fold-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .fold-mark {
    color: var(--dim);
    font-size: 11.5px;
  }
</style>
