<script lang="ts">
  /*
   * The wrap-up's aside picker (nightshift item 285): every asked aside of
   * the chat, all ticked; untick to leave one out; Delete closes one into
   * the Past list after a confirmation; Wrap up runs each ticked aside's
   * summary (282's fold step) and then the wrap-up. The logic and the
   * rules are in `wrapAsides.svelte.ts`.
   */
  import { app, chatThread } from "./state.svelte";
  import { asideLabel } from "./asides";
  import {
    answerDelete,
    cancelWrapPick,
    confirmWrapPick,
    requestDelete,
    setTicked,
    skipWaiting,
    WAIT_MS,
    wrapPick,
  } from "./wrapAsides.svelte";
  import { quoteLabel } from "./asideQuote";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import Icon from "./Icon.svelte";

  const slug = $derived(wrapPick.chat ? chatThread(app.events) : null);
  const ticked = $derived(wrapPick.rows.filter((r) => r.ticked).length);
  const summarizing = $derived(wrapPick.stage === "summarizing");

  function key(e: KeyboardEvent): void {
    if (!wrapPick.chat || e.key !== "Escape" || wrapPick.deleting) return;
    e.preventDefault();
    e.stopPropagation();
    cancelWrapPick();
  }
</script>

<svelte:window onkeydown={key} />

{#if wrapPick.chat}
  <div class="scrim" role="presentation">
    <div class="ns-card dialog" role="dialog" aria-modal="true" aria-labelledby="wrap-asides-title" tabindex="-1">
      <div class="head">
        <span class="mark"><Icon name="think" size={18} /></span>
        <h2 id="wrap-asides-title">Asides in this hand-off</h2>
      </div>
      <p class="lead">
        {#if slug}
          Each ticked aside writes a summary of itself (his words verbatim, with pointers); Nightloom appends it to
          <code>.agents/threads/{slug}/log.md</code>, and the wrap-up folds it into thread.md.
        {:else}
          Each ticked aside writes a summary of itself (his words verbatim, with pointers); the wrap-up puts the summaries
          in the HANDOFF section it writes.
        {/if}
        Unticked asides stay open, untouched.
      </p>
      <ul class="rows">
        {#each wrapPick.rows as r (r.aside.id)}
          {@const label = asideLabel(r.aside, 70)}
          <li class="row" class:off={!r.ticked}>
            <label class="pick">
              <input
                type="checkbox"
                checked={r.ticked}
                disabled={summarizing}
                onchange={(e) => setTicked(r.aside, (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="name">{label}</span>
              <span class="sub"
                >{r.aside.turns.length} exchange{r.aside.turns.length === 1 ? "" : "s"}{#if r.aside.quote} · about {quoteLabel(
                    r.aside.quote,
                    "card",
                  )}{/if}{#if r.aside.foldedInto?.length} · folded before at {r.aside.foldedInto[r.aside.foldedInto.length - 1]!.at}{/if}</span
              >
            </label>
            {#if summarizing}
              <span class="state">{r.ticked ? (wrapPick.done.includes(label) ? "summary in" : "writing…") : "left out"}</span>
            {:else}
              <button class="ns-btn ghost small" onclick={() => requestDelete(r.aside)}>Delete</button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if summarizing}
        <p class="note">
          Asides answer one at a time. The wrap-up goes when every summary is in, or after {Math.round(WAIT_MS / 60000)} minutes
          with what arrived — the rest are named in it and stay open.
        </p>
      {/if}
      <div class="actions">
        {#if summarizing}
          <button class="ns-btn" onclick={skipWaiting}>Wrap up now with what arrived</button>
        {:else}
          <button class="ns-btn" onclick={cancelWrapPick}>Cancel</button>
          <button class="ns-btn accent" disabled={app.busy} onclick={() => void confirmWrapPick()}
            >{ticked > 0 ? `Wrap up with ${ticked} aside${ticked === 1 ? "" : "s"}` : "Wrap up without asides"}</button
          >
        {/if}
      </div>
    </div>
  </div>
  {#if wrapPick.deleting}
    {@const d = wrapPick.deleting}
    <ConfirmDialog
      title="Delete this aside?"
      lead={`'${asideLabel(d, 70)}' is closed and moves to the chat's Past asides, where it can be reopened.${(d.unsent ?? "").trim() ? " The text typed in its box and not sent is dropped." : ""}`}
      confirmLabel="Delete"
      danger
      onconfirm={() => answerDelete(true)}
      onclose={() => answerDelete(false)}
    />
  {/if}
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
  h2 {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 500;
    margin: 0;
  }
  .lead,
  .note {
    margin: 0;
    color: var(--ink2);
    font-size: 13px;
    line-height: 1.45;
  }
  .lead code {
    font-family: var(--mono);
    font-size: 12px;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 8px;
    background: var(--well);
  }
  .row.off {
    opacity: 0.6;
  }
  .pick {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 8px;
    align-items: baseline;
    cursor: pointer;
  }
  .pick input {
    grid-row: span 2;
    accent-color: var(--accent);
  }
  .name,
  .sub {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sub {
    color: var(--dim);
    font-size: 12px;
  }
  .state {
    color: var(--dim);
    font-size: 12px;
    flex-shrink: 0;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
