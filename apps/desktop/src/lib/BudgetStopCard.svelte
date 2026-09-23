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
  import { app, readTurnBudget } from "./state.svelte";
  import { budgetOverride } from "./api";
  import { stopCard } from "./budget";
  import Icon from "./Icon.svelte";

  let { session }: { session: string } = $props();

  const card = $derived(stopCard(app.turnBudget));
  let sending = $state(false);
  let failed = $state<string | null>(null);

  async function answer(decision: "continue" | "stop"): Promise<void> {
    sending = true;
    failed = null;
    try {
      await budgetOverride(session, decision);
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
    {#if card.detail}<div class="detail">{card.detail}</div>{/if}
    <div class="actions">
      <button class="ns-btn accent" disabled={sending} onclick={() => answer("continue")}>Continue anyway</button>
      <button class="ns-btn outline" disabled={sending} onclick={() => answer("stop")}>Stop here</button>
      <span class="keys">this message only — not other chats, not the next message · stops by itself in 5 minutes</span>
    </div>
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
