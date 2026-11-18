<script lang="ts">
  // The phone's secret-request card (nightshift item 766): the desktop's
  // `SecretCard` words, the phone's look (`JobApproval`'s shape). What he
  // types is this component's state alone — never a draft, never
  // localStorage — handed to `onuse`, which keeps it on the chat's host
  // and then answers a bare Allow; emptied once sent and when the card goes.
  import { SECRET_WHERE_PHONE, secretCommand, secretView, type BwApi } from "../lib/secret";
  import BitwardenPick from "../lib/BitwardenPick.svelte";

  let {
    input,
    onuse,
    ondecline,
    bw = null,
    onstored = async () => null,
  }: {
    input: unknown;
    /** Keep it on the host, then Allow; the error to show, or null. */
    onuse: (name: string, value: string) => Promise<string | null>;
    ondecline: () => void;
    /** Item 766 part 2: "From Bitwarden" on the chat's host, when connected. */
    bw?: BwApi | null;
    /** The host stored it from Bitwarden: Allow; the error to show, or null. */
    onstored?: () => Promise<string | null>;
  } = $props();
  const command = $derived(secretCommand(input));

  const view = $derived(secretView(input));
  let value = $state("");
  let shown = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => () => {
    value = "";
  });

  async function use() {
    if (busy || !value) return;
    busy = true;
    error = await onuse(view.name, value);
    if (error === null) value = "";
    busy = false;
  }

  function decline() {
    value = "";
    ondecline();
  }
</script>

<div class="sa" role="group" aria-label="Claude asks for a secret">
  <p class="sa-title">Claude needs <code>{view.name}</code></p>
  {#if view.why}<p class="sa-body">{view.why}</p>{/if}
  <div class="sa-field">
    {#if shown}
      <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste or type it" aria-label={view.name} bind:value />
    {:else}
      <input type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste or type it" aria-label={view.name} bind:value />
    {/if}
    <button class="sa-btn quiet" type="button" onclick={() => (shown = !shown)}>{shown ? "Hide" : "Show"}</button>
  </div>
  <p class="sa-hint">{SECRET_WHERE_PHONE}</p>
  {#if error}<p class="sa-hint err">{error}</p>{/if}
  <div class="sa-row">
    <button class="sa-btn primary" data-act="secret-use" disabled={busy || !value} onclick={() => void use()}>Use it</button>
    <button class="sa-btn" data-act="secret-decline" disabled={busy} onclick={decline}>Decline</button>
  </div>
  {#if bw}
    <div class="sa-bw"><BitwardenPick api={bw} name={view.name} {command} where="phone" disabled={busy} {onstored} /></div>
  {/if}
</div>

<style>
  .sa {
    border: 1px solid var(--accent);
    border-radius: 12px;
    background: var(--raised);
    padding: 10px 12px;
    margin: 6px 0;
  }
  .sa-title {
    font-weight: 600;
    font-size: 15px;
    margin: 0 0 4px;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .sa-title code {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 14px;
  }
  .sa-body,
  .sa-hint {
    font-size: 14px;
    line-height: 1.4;
    margin: 0 0 8px;
    color: var(--ink);
  }
  .sa-hint {
    font-size: 12.5px;
    color: var(--dim);
  }
  .sa-hint.err {
    color: var(--danger, var(--accent));
  }
  .sa-field {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 0 0 8px;
  }
  .sa-field input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 16px;
    min-height: 36px;
    padding: 6px 10px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 9px;
    box-sizing: border-box;
  }
  .sa-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .sa-btn {
    font: inherit;
    font-size: 14px;
    min-height: 36px;
    padding: 6px 12px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 9px;
    cursor: pointer;
  }
  .sa-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .sa-btn.quiet {
    background: none;
    color: var(--dim);
  }
  .sa-btn:disabled {
    opacity: 0.5;
  }
  .sa-bw {
    margin-top: 10px;
  }
</style>
