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
  import { scrimClose } from "./scrimClose";

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
  <!-- Item 927: a click outside the box is Cancel (no-op while the
       summaries are being written: there is no Cancel then). -->
  <div class="scrim" role="presentation" use:scrimClose={cancelWrapPick}>
    <div class="ns-card dialog" role="dialog" aria-modal="true" aria-labelledby="wrap-asides-title" tabindex="-1">
      <div class="head">
        <span class="mark"><Icon name="think" size={18} /></span>
        <h2 id="wrap-asides-title">Asides in this hand-off</h2>
        <span class="count" aria-label={`${ticked} of ${wrapPick.rows.length} ticked`}
          >{ticked}<span class="of">/{wrapPick.rows.length}</span></span
        >
      </div>
      <p class="lead">
        {#if slug}
          Each ticked aside writes a summary of itself (your words verbatim, with pointers); Nightloom appends it to
          <code>.agents/threads/{slug}/log.md</code>, and the wrap-up folds it into thread.md.
        {:else}
          Each ticked aside writes a summary of itself (your words verbatim, with pointers); the wrap-up puts the summaries
          in the HANDOFF section it writes.
        {/if}
        Unticked asides stay open, untouched.
      </p>
      <ul class="rows">
        {#each wrapPick.rows as r (r.aside.id)}
          {@const label = asideLabel(r.aside, 70)}
          <li class="row" class:off={!r.ticked} class:busy={summarizing}>
            <label class="pick">
              <input
                type="checkbox"
                checked={r.ticked}
                disabled={summarizing}
                onchange={(e) => setTicked(r.aside, (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="box" aria-hidden="true"><svg viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.6 9.6 3.6" /></svg></span>
              <span class="name">{label}</span>
              <span class="sub"
                >{r.aside.turns.length} exchange{r.aside.turns.length === 1 ? "" : "s"}{#if r.aside.quote}{" · "}about {quoteLabel(
                    r.aside.quote,
                    "card",
                  )}{/if}{#if r.aside.foldedInto?.length}{" · "}folded before at {r.aside.foldedInto[r.aside.foldedInto.length - 1]!.at}{/if}</span
              >
            </label>
            {#if summarizing}
              <span class="state" class:in={r.ticked && wrapPick.done.includes(label)}>{r.ticked ? (wrapPick.done.includes(label) ? "summary in" : "writing…") : "left out"}</span>
            {:else}
              <button class="ns-btn ghost small del" onclick={() => requestDelete(r.aside)}>Delete</button>
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
  .count {
    margin-left: auto;
    font: 500 12px var(--mono);
    color: var(--ink2);
  }
  .count .of {
    color: var(--dim);
  }
  .pick {
    position: relative;
  }
  .box {
    display: none;
  }

  /* Item 927: the Jarvis look — ConfirmDialog's card (item 570: raised,
     ruled head in the light sans, ruled foot), each aside a row you click
     anywhere to tick, a drawn checkbox that pops when ticked, an accent
     edge on the ticked rows, Delete quiet until the row is hovered, and
     a short rise for the card and fade for the scrim. Classic keeps the
     rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .scrim {
    background: rgba(0, 0, 0, 0.6);
  }
  :global(:where(:root:not([data-layout="classic"]))) .dialog {
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65);
    padding: 20px 22px 18px;
    gap: 14px;
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
  :global(:where(:root:not([data-layout="classic"]))) .count {
    padding: 2px 8px;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: var(--well);
    font-size: 11px;
    color: var(--accent-ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .lead code {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--well);
    color: var(--ink);
    font-size: 11.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .rows {
    gap: 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .row {
    padding: 0 6px 0 0;
    border: 1px solid var(--line);
    border-radius: var(--r1);
    background: var(--well);
    box-shadow: inset 2px 0 0 var(--accent);
    transition:
      background-color 120ms,
      border-color 120ms,
      box-shadow 160ms,
      opacity 160ms;
  }
  :global(:where(:root:not([data-layout="classic"]))) .row:hover:not(.busy) {
    background: var(--well2);
    border-color: var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .row.off {
    opacity: 0.55;
    box-shadow: inset 2px 0 0 transparent;
  }
  :global(:where(:root:not([data-layout="classic"]))) .row.off:hover {
    opacity: 0.8;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick {
    padding: 9px 4px 9px 12px;
    column-gap: 11px;
    row-gap: 2px;
    align-items: center;
  }
  :global(:where(:root:not([data-layout="classic"]))) .row.busy .pick {
    cursor: default;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick input {
    position: absolute;
    left: 12px;
    top: 50%;
    width: 16px;
    height: 16px;
    margin: -8px 0 0;
    opacity: 0;
    pointer-events: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .box {
    grid-row: span 2;
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    border: 1px solid var(--dim);
    background: var(--sheet);
    transition:
      background-color 120ms,
      border-color 120ms;
  }
  :global(:where(:root:not([data-layout="classic"]))) .box svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--on-accent);
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 12;
    stroke-dashoffset: 12;
    transition: stroke-dashoffset 160ms ease-out 40ms;
  }
  :global(:where(:root:not([data-layout="classic"]))) .row:not(.off) .box {
    background: var(--accent);
    border-color: var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .row:not(.off) .box svg {
    stroke-dashoffset: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pick input:focus-visible + .box {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .name {
    font-size: 13.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .sub {
    font: 400 11px var(--mono);
    letter-spacing: 0.02em;
  }
  :global(:where(:root:not([data-layout="classic"]))) .del {
    color: var(--dim);
    opacity: 0.7;
    transition:
      opacity 120ms,
      color 120ms,
      background-color 120ms;
  }
  :global(:where(:root:not([data-layout="classic"]))) .row:is(:hover, :focus-within) .del {
    opacity: 1;
  }
  :global(:where(:root:not([data-layout="classic"]))) .del:hover:not(:disabled) {
    color: var(--failed);
  }
  :global(:where(:root:not([data-layout="classic"]))) .state {
    font: 500 10px var(--mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding-right: 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .state.in {
    color: var(--accent-ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .actions {
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .scrim {
      animation: wrap-fade 120ms ease-out;
    }
    :global(:where(:root:not([data-layout="classic"]))) .dialog {
      animation: wrap-rise 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    :global(:where(:root:not([data-layout="classic"]))) .row:not(.off) .box {
      animation: wrap-tick 200ms cubic-bezier(0.3, 1.6, 0.5, 1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(:where(:root:not([data-layout="classic"]))) :is(.row, .box, .box svg, .del) {
      transition: none;
    }
  }
  @keyframes wrap-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes wrap-rise {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.985);
    }
  }
  @keyframes wrap-tick {
    0% {
      transform: scale(0.8);
    }
    60% {
      transform: scale(1.12);
    }
    100% {
      transform: scale(1);
    }
  }
</style>
