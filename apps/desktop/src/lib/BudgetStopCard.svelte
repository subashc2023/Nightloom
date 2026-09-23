<script lang="ts">
  // The card at the 85 % stop line (nightshift backlog 189, 2026-09-22;
  // his answer to blocker 290: "There should be override for 290 if I'm
  // present"). Past the line every tool call is refused — unless he is in
  // this chat, where the budget hook holds the call instead and the ledger
  // says so (`pending_since_ms`). Continue anyway lets this message's calls
  // through to the end of the turn — not other chats, not the next message;
  // the message's own share (35 %) still binds. Stop here refuses the held
  // call as before. Unanswered, the hook refuses it after five minutes
  // (blocker 292 has why it waits rather than refusing first).
  //
  // Pass 2 (backlog 192, his answer to blocker 292): ~~this message only~~ —
  // Continue anyway covers **this chat** while he stays at the Mac (any key
  // or pointer input within 10 minutes), and ends after 10 minutes away;
  // *Wrap up* has the chat finish and write its hand-off now
  // (`budgetWrap.svelte.ts`). Shown in the chat he is looking at even when
  // the turn runs in another (`elsewhere`, that chat's name) — review
  // 2026-09-23 finding 3: a held call with no card he could see.
  import { app, readTurnBudget } from "./state.svelte";
  import { budgetOverride } from "./api";
  import { stopCard } from "./budget";
  import { wrapUp } from "./budgetWrap.svelte";
  import Icon from "./Icon.svelte";

  let { session, elsewhere = null }: { session: string; elsewhere?: string | null } = $props();

  /** A clock so a hold whose deadline passed takes the card down. */
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const card = $derived(stopCard(app.turnBudget, now));
  let sending = $state(false);
  let failed = $state<string | null>(null);

  async function answer(decision: "continue" | "stop" | "wrap"): Promise<void> {
    sending = true;
    failed = null;
    try {
      if (decision === "wrap") await wrapUp(session);
      else await budgetOverride(session, decision);
      await readTurnBudget(session);
    } catch (e) {
      failed = String(e);
    } finally {
      sending = false;
    }
  }
</script>

{#if card}
  <div class="stop-card" role="group" aria-label="Stopped at the usage line">
    <div class="head">
      <span class="mark"><Icon name="moon" size={14} /></span>
      <strong>{card.title}</strong>
    </div>
    {#if elsewhere}<div class="where">in the running chat, <strong>{elsewhere}</strong> — not this one</div>{/if}
    {#if card.detail}<div class="detail">{card.detail}</div>{/if}
    <div class="actions">
      <button
        class="ns-btn accent"
        disabled={sending}
        title="Lets this chat's calls run past the line while you are at the Mac; after 10 minutes away the stop applies again"
        onclick={() => answer("continue")}>Continue anyway</button
      >
      <button
        class="ns-btn outline"
        disabled={sending}
        title="The model finishes what is half-done, writes its hand-off, and stops"
        onclick={() => answer("wrap")}>Wrap up</button
      >
      <button class="ns-btn outline" disabled={sending} onclick={() => answer("stop")}>Stop here</button>
    </div>
    <div class="keys">Continue covers this chat while you are at the Mac — not other chats · ends after 10 minutes away · unanswered, stops by itself in 5 minutes</div>
    {#if failed}<div class="failed">{failed}</div>{/if}
  </div>
{/if}

<style>
  .stop-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    background: var(--panel);
    border: 1px solid var(--error);
    border-radius: 10px;
    padding: 0.7rem 0.8rem;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.88rem;
  }
  .mark {
    color: var(--error);
    display: inline-flex;
  }
  .where {
    font-size: 0.8rem;
  }
  .detail {
    font-size: 0.8rem;
    color: var(--dim);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
  }
  .keys {
    font-size: 0.72rem;
    color: var(--dim);
  }
  .failed {
    font-size: 0.78rem;
    color: var(--error);
  }
</style>
