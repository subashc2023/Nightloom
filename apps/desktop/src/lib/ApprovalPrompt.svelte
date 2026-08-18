<script lang="ts">
  import { tick } from "svelte";
  import { resolveApproval } from "./state.svelte";
  import { inputFields } from "./toolinput";
  import type { ApprovalRequest } from "./types";

  let { req }: { req: ApprovalRequest } = $props();

  const fields = $derived(inputFields(req.input));

  let denying = $state(false);
  let reason = $state("");
  let box = $state<HTMLDivElement | null>(null);
  let reasonInput = $state<HTMLInputElement | null>(null);
  let denyButton = $state<HTMLButtonElement | null>(null);

  // The turn is parked on this answer, so put keyboard focus on the prompt —
  // but on the box, not on a button: nothing here should be one stray Enter
  // away from granting permission.
  $effect(() => {
    box?.focus();
  });

  function decide(decision: "allow" | "always" | "deny") {
    void resolveApproval(
      req.id,
      req.name,
      decision,
      decision === "deny" ? reason.trim() || undefined : undefined,
    );
  }

  function onDeny() {
    if (denying) {
      decide("deny");
      return;
    }
    denying = true;
    void tick().then(() => reasonInput?.focus());
  }

  function onReasonKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      decide("deny");
    } else if (e.key === "Escape") {
      // Back out of the reason, not out of the decision — the call is still
      // waiting either way, so leave the three buttons in reach.
      e.preventDefault();
      e.stopPropagation();
      denying = false;
      reason = "";
      denyButton?.focus();
    }
  }
</script>

<div
  class="approval"
  bind:this={box}
  tabindex="-1"
  role="group"
  aria-label="permission required to run {req.name}"
>
  <div class="head">
    <span class="mark" aria-hidden="true">⚠</span>
    <span>Run <code>{req.name}</code>?</span>
    <span class="effect">{req.effect.replace("_", " ")}</span>
  </div>

  <div class="args">
    {#each fields as f, i (i)}
      <div class="arg">
        {#if f.key}<div class="key">{f.key}</div>{/if}
        <pre class="val">{f.value}</pre>
      </div>
    {/each}
  </div>

  <div class="actions">
    <button class="btn allow" onclick={() => decide("allow")}>Allow once</button>
    <button class="btn" onclick={() => decide("always")}>
      Always allow {req.name}
    </button>
    <button class="btn deny" bind:this={denyButton} onclick={onDeny}>
      {denying ? "Deny" : "Deny…"}
    </button>
  </div>

  {#if denying}
    <input
      class="reason"
      type="text"
      bind:this={reasonInput}
      bind:value={reason}
      onkeydown={onReasonKey}
      placeholder="why not? (optional)"
    />
    <p class="hint">
      The model is told this verbatim, so it can try something else. Enter to
      deny · Esc to go back.
    </p>
  {/if}
</div>

<style>
  .approval {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 0.7rem 0.8rem;
  }
  .approval:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    font-size: 0.88rem;
  }
  .mark {
    color: var(--accent);
  }
  .head code {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--accent);
  }
  .effect {
    margin-left: auto;
    font-size: 0.68rem;
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    white-space: nowrap;
  }
  .args {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .key {
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--dim);
    margin-bottom: 0.15rem;
  }
  /* Values wrap and scroll rather than being elided: a command you cannot
     read in full is not something you can agree to. */
  .val {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    margin: 0;
    max-height: 12rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }
  .btn {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.35rem 0.75rem;
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
  }
  .btn:hover {
    border-color: var(--accent);
  }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .btn.allow {
    background: var(--accent);
    color: #0d0d14;
    border-color: var(--accent);
    font-weight: 600;
  }
  .btn.allow:hover {
    filter: brightness(1.1);
  }
  .btn.deny {
    color: var(--error);
    border-color: rgba(246, 109, 124, 0.4);
  }
  .btn.deny:hover {
    border-color: var(--error);
  }
  .reason {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.55rem;
    font-size: 0.8rem;
    font-family: inherit;
    width: 100%;
  }
  .reason:focus {
    outline: none;
    border-color: var(--accent);
  }
  .hint {
    margin: 0;
    font-size: 0.68rem;
    line-height: 1.35;
    color: var(--dim);
  }
</style>
