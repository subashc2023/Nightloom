<script lang="ts">
  // Playwright's approval card (nightshift backlog 367, blocker 1413): "the
  // model wants to use playwright, and it gave this purpose as a reason",
  // with his three buttons. Shaped like the permission card above it in
  // ApprovalPrompt — the same head, the model's reason in the transcript's
  // face, the one note field, the buttons on one row — so it reads as one
  // of the turn's interruptions, not a dialog.
  import { tip } from "./tip";
  import { app, resolveApproval } from "./state.svelte";
  import { draftKey, enqueueMessage } from "./drafts.svelte";
  import { routeNote } from "./askNote";
  import type { ApprovalDecision, ApprovalRequest } from "./types";
  import { PLAYWRIGHT_BUTTONS, PLAYWRIGHT_CHANGED, PLAYWRIGHT_DECLINED, playwrightAction } from "./playwright";

  let { req }: { req: ApprovalRequest } = $props();

  const action = $derived(playwrightAction(req.name, req.input));
  let note = $state("");
  let box = $state<HTMLDivElement | null>(null);
  let done = $state(false);

  // Focus the card, never a button: nothing here is one stray Enter away
  // from granting the browser.
  $effect(() => {
    box?.focus();
  });

  function decide(decision: ApprovalDecision) {
    if (done) return;
    done = true;
    const route = routeNote(decision, note, PLAYWRIGHT_DECLINED);
    if (route.enqueue) {
      enqueueMessage(draftKey(app.activeSessionId, app.project?.id, app.pendingMode), route.enqueue, []);
    }
    void resolveApproval(req.id, req.name, decision, route.reason).then(() => {
      // The rail's per-chat switch follows "Allow for this chat".
      if (decision === "always") window.dispatchEvent(new CustomEvent(PLAYWRIGHT_CHANGED));
    });
  }

  function onNoteKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      decide("allow");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      decide("deny");
    }
  }
</script>

<div class="ask" bind:this={box} tabindex="-1" role="group" aria-label="Claude wants to use its own browser (Playwright)">
  <div class="head">
    <span class="mark" aria-hidden="true">◎</span>
    <span>Claude wants to use its own browser <span class="dim">(Playwright)</span></span>
    <span class="sp"></span>
    <span class="effect">paused · waiting for you</span>
  </div>

  <div class="arg">
    <div class="key">the model's reason</div>
    {#if req.reason}
      <div class="why">{req.reason}</div>
    {:else}
      <div class="why none">The model wrote nothing before the call.</div>
    {/if}
  </div>

  <div class="arg">
    <div class="key">the action</div>
    <pre class="val"><b>{action.tool}</b>{#if action.target}&nbsp; {action.target}{/if}</pre>
  </div>

  <div class="note-row">
    <input
      class="note"
      type="text"
      bind:value={note}
      onkeydown={onNoteKey}
      placeholder="Note for the model — optional"
      aria-label="note for the model, optional"
    />
  </div>

  <div class="actions">
    {#each PLAYWRIGHT_BUTTONS as b (b.decision)}
      <button
        class="ns-btn"
        class:accent={b.decision === "allow"}
        class:danger={b.decision === "deny"}
        disabled={done}
        use:tip={b.tip}
        onclick={() => decide(b.decision)}>{b.label}</button
      >
    {/each}
    <span class="keys">⏎ allow once · esc deny</span>
  </div>
</div>

<style>
  .ask {
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    background: var(--sheet);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 10px 14px 14px;
  }
  .ask:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    min-height: 22px;
  }
  .mark {
    color: var(--accent);
  }
  .dim {
    color: var(--dim);
  }
  .sp {
    flex: 1;
  }
  .effect {
    font-size: 11px;
    line-height: 1.5;
    color: var(--dim);
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 0 8px;
    white-space: nowrap;
  }
  .key {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    margin-bottom: 3px;
  }
  .why {
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 16px);
    line-height: 1.55;
    color: var(--ink);
    max-height: 9.4em;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .why.none {
    color: var(--dim);
    font-style: italic;
  }
  .val {
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 7px 10px;
    margin: 0;
    max-height: 8rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .note-row {
    display: flex;
  }
  .note {
    flex: 1;
    min-width: 0;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 5px 10px;
    min-height: 32px;
    box-sizing: border-box;
  }
  .note::placeholder {
    color: var(--dim);
  }
  .note:focus {
    outline: none;
    border-color: var(--accent);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  /* Wraps rather than running out of the card in a narrow pane (item 360). */
  .keys {
    margin-left: auto;
    min-width: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
</style>
