<script lang="ts">
  // The secret-request card (nightshift item 766): the chat needs a token, a
  // password or a key, and asks for it here instead of in the chat. What he
  // types lives in this component's state alone — never a draft, never
  // localStorage — goes to the host's private store (`store_secret`), and
  // the card then answers a bare Allow. The field is emptied on submit and
  // when the card goes. Shaped like the Playwright and stuck cards beside it.
  // Item 974: a digit focuses button n; Enter presses it.
  import { keyPicks } from "./cardKeys";
  import { tip } from "./tip";
  import { app, resolveApproval } from "./state.svelte";
  import {
    bitwardenReady,
    bitwardenSearch,
    bitwardenStore,
    bitwardenTouchSetup,
    bitwardenTouchStatus,
    bitwardenTouchUnlock,
    bitwardenUseSession,
    storeSecret,
  } from "./api";
  import BitwardenPick from "./BitwardenPick.svelte";
  import { trackCard } from "./waitingNotice.svelte";
  import { DECLINE_TIP, SECRET_DECLINED, SECRET_WHERE, USE_TIP, secretCommand, secretView, type BwApi } from "./secret";
  import type { ApprovalRequest } from "./types";

  let { req }: { req: ApprovalRequest } = $props();

  const view = $derived(secretView(req.input));
  const command = $derived(secretCommand(req.input));
  const chatOf = () => req.chat ?? app.activeSessionId ?? "";
  // Item 766 part 2: "From Bitwarden" — the value goes from `bw` to the
  // same private file on this Mac; this card only ever sees names.
  const bw: BwApi = {
    ready: () => bitwardenReady(),
    useSession: (key) => bitwardenUseSession(key),
    // Item 826: Touch ID unlock.
    touch: {
      stored: async () => (await bitwardenTouchStatus()).stored,
      setup: (pw) => bitwardenTouchSetup(pw),
      unlock: () => bitwardenTouchUnlock(),
    },
    search: (q) => bitwardenSearch(q),
    store: async (itemId, field, alwaysFor) => {
      await bitwardenStore(chatOf(), view.name, itemId, field, alwaysFor);
    },
  };

  async function allowStored(): Promise<string | null> {
    if (done) return null;
    done = true;
    value = "";
    const ok = await resolveApproval(req.id, req.name, "allow");
    if (!ok) {
      done = false;
      return "That request is no longer waiting: its reply has ended.";
    }
    return null;
  }
  let value = $state("");
  let shown = $state(false);
  let done = $state(false);
  let error = $state<string | null>(null);
  let field = $state<HTMLInputElement | null>(null);

  $effect(() => {
    field?.focus();
  });
  // Nothing he typed outlives the card.
  $effect(() => () => {
    value = "";
  });

  async function use() {
    if (done || !value) return;
    done = true;
    error = null;
    const chat = req.chat ?? app.activeSessionId ?? "";
    try {
      await storeSecret(chat, view.name, value);
    } catch (e) {
      error = `Not kept: ${String(e).replace(/^Error:\s*/, "")}`;
      done = false;
      return;
    }
    value = "";
    const ok = await resolveApproval(req.id, req.name, "allow");
    if (!ok) {
      error = "That request is no longer waiting: its reply has ended.";
      done = false;
    }
  }

  function decline() {
    if (done) return;
    done = true;
    value = "";
    void resolveApproval(req.id, req.name, "deny", SECRET_DECLINED).then((ok) => {
      if (!ok) done = false;
    });
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void use();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      decline();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="ask" use:trackCard={req.id} use:keyPicks role="group" aria-label="Claude asks for a secret" onkeydown={onKey}>
  <div class="head">
    <span class="mark" aria-hidden="true">✱</span>
    <span>Claude needs <b class="name">{view.name}</b></span>
    <span class="sp"></span>
    <span class="effect">never shown in the chat</span>
  </div>

  {#if view.why}
    <div class="line">{view.why}</div>
  {/if}

  <div class="field">
    {#if shown}
      <input
        bind:this={field}
        bind:value
        type="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="Paste or type it"
        aria-label={view.name}
        disabled={done}
      />
    {:else}
      <input
        bind:this={field}
        bind:value
        type="password"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="Paste or type it"
        aria-label={view.name}
        disabled={done}
      />
    {/if}
    <button class="ns-btn ghost show" type="button" disabled={done} onclick={() => (shown = !shown)}>{shown ? "Hide" : "Show"}</button>
  </div>

  <div class="line small">{SECRET_WHERE}</div>
  {#if error}<div class="line err">{error}</div>{/if}

  <div class="actions">
    <button class="ns-btn accent" data-pick disabled={done || !value} use:tip={USE_TIP} onclick={() => void use()}>Use it</button>
    <button class="ns-btn" data-pick disabled={done} use:tip={DECLINE_TIP} onclick={decline}>Decline</button>
    <span class="keys">⏎ use · esc decline</span>
  </div>

  <BitwardenPick api={bw} name={view.name} {command} where="mac" disabled={done} onstored={allowStored} />
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
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    min-height: 22px;
    flex-wrap: wrap;
  }
  .name {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
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
  .line.small {
    font-size: 12px;
  }
  .line.err {
    color: var(--danger, var(--accent));
  }
  .field {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .field input {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 7px 10px;
  }
  .field input:focus {
    outline: none;
    border-color: var(--accent);
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
