<script lang="ts">
  // The runaway guard's card (nightshift item 784): a run nobody was
  // watching repeated itself and was paused, its spending stopped. Two
  // buttons — Continue (an allow: the same session carries on) and Stop (a
  // deny: the run ends, everything it did stays on the log). Shaped like
  // the Playwright card beside it, so it reads as one of the turn's
  // interruptions, not a dialog. Nothing is one stray Enter away: focus
  // lands on the card, and Enter is Continue only from the card itself.
  import { tip } from "./tip";
  import { resolveApproval } from "./state.svelte";
  import { trackCard } from "./waitingNotice.svelte";
  import { stuckView } from "./stuck";
  import type { ApprovalDecision, ApprovalRequest } from "./types";

  let { req }: { req: ApprovalRequest } = $props();

  const view = $derived(stuckView(req.input, req.reason));
  let box = $state<HTMLDivElement | null>(null);
  let done = $state(false);

  $effect(() => {
    box?.focus();
  });

  function decide(decision: ApprovalDecision) {
    if (done) return;
    done = true;
    void resolveApproval(req.id, req.name, decision, decision === "deny" ? "stopped: it looked stuck" : undefined).then((ok) => {
      if (!ok) done = false;
    });
  }

  function onKey(e: KeyboardEvent) {
    if (e.target !== box) return;
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="ask" bind:this={box} use:trackCard={req.id} tabindex="-1" role="group" aria-label="the run looks stuck" onkeydown={onKey}>
  <div class="head">
    <span class="mark" aria-hidden="true">↻</span>
    <span>{view.sentence}</span>
    <span class="sp"></span>
    <span class="effect">paused · nothing is being spent</span>
  </div>

  {#if view.job}
    <div class="line">The job <b>{view.job}</b> ran with nobody watching, so it stopped here and asked you.</div>
  {:else}
    <div class="line">This chat ran with nobody watching, so it stopped here and asked you.</div>
  {/if}

  {#if view.ran}
    <div class="arg">
      <div class="key">it ran</div>
      <pre class="val">{view.ran}</pre>
    </div>
  {/if}
  {#if view.result}
    <div class="arg">
      <div class="key">{view.error ? "and got this error" : "and got this"} each time</div>
      <pre class="val">{view.result}</pre>
    </div>
  {/if}

  <div class="actions">
    <button class="ns-btn accent" disabled={done} use:tip={view.then} onclick={() => decide("allow")}>Continue</button>
    <button class="ns-btn danger" disabled={done} use:tip={"Stop: the run ends; what it did stays in the chat."} onclick={() => decide("deny")}
      >Stop</button
    >
    <span class="keys">⏎ continue · esc stop</span>
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
    flex-wrap: wrap;
  }
  .mark {
    color: var(--accent);
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
  .line {
    font-size: 13px;
    line-height: 1.5;
    color: var(--dim);
  }
  .line b {
    color: var(--ink);
    font-weight: 600;
  }
  .key {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    margin-bottom: 3px;
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
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .keys {
    margin-left: auto;
    min-width: 0;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
</style>
