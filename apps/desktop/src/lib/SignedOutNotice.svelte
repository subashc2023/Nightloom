<script lang="ts">
  /**
   * The stand-in reply for a turn Claude Code refused because it is signed
   * out (nightshift backlog 409): Nightloom's amber notice (as backlog 407
   * draws every stand-in) saying so, with **Sign in** — a terminal tab with
   * the CLI's own `auth login` typed in by its absolute path. Retry under
   * the reply (item 333) sends the message again once he has signed in.
   *
   * Mounted by `AssistantMessage` for a stand-in whose stop reason carries
   * the service's mark (`isSignedOut`). The CLI's own sentence stays, small,
   * under the words.
   */
  import { onMount } from "svelte";
  import { tip } from "./tip";
  import { phaseLine } from "./claudeAuth";
  import { auth, probeSoon, signIn, signInLine } from "./claudeAuth.svelte";
  import { signedOutDetail } from "./replyFooter";

  let { reason }: { reason: string | null | undefined } = $props();

  const detail = $derived(signedOutDetail(reason));
  const busy = $derived(auth.phase === "opening");

  // A notice on screen asks the CLI again (at most every 30 s): the chip
  // learns the sign-in broke without waiting for the next connect.
  onMount(() => probeSoon());
</script>

<div class="signed-out" role="status">
  <div class="title">Claude Code is signed out</div>
  <div class="line">{phaseLine(auth.phase)}</div>
  <div class="row">
    <button
      class="ns-btn small sign-in"
      disabled={busy}
      use:tip={`Open a terminal tab running ${signInLine()}`}
      onclick={() => void signIn()}
    >
      {auth.phase === "typed" || auth.phase === "signed-in" ? "Sign in again" : "Sign in"}
    </button>
    {#if auth.phase === "failed"}
      <code class="cmd">{signInLine()}</code>
    {/if}
  </div>
  {#if detail}
    <div class="detail" use:tip={"What Claude Code said"}>{detail}</div>
  {/if}
</div>

<style>
  /* The stand-in's amber (407's `.notice.nl-own`), as a block: a title, a
     line, the button, the CLI's sentence small under them. */
  .signed-out {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--partial);
    border-left-width: 3px;
    border-radius: 6px;
    background: var(--partial-soft);
    max-width: min(100%, 560px);
  }
  .title {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--partial);
  }
  .line {
    font-size: 13px;
    color: var(--ink);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .cmd {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
    overflow-wrap: anywhere;
    user-select: all;
  }
  .detail {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
</style>
