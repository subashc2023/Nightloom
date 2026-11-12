<script lang="ts">
  /*
   * The keep-warm notice (nightshift backlog 582; his ask in item 579: "a
   * small popup … after my latest msg … and then i can turn it off"): one
   * quiet line under his latest message while the chat's cache is being
   * kept warm — until when — with a one-click off that switches the
   * chat's keep-warm off. Nothing while nothing is being kept (the switch
   * off, the cap passed, the chat's turn running).
   *
   * Fixed-cap form: the time is the schedule's end (the last ping the cap
   * allows, plus the cache's hour), not a prediction of his return — 579's
   * predictor is not shipped.
   */
  import { onDestroy } from "svelte";
  import { tip } from "./tip";
  import { addToast } from "./state.svelte";
  import { noticeLine, switchTitle } from "./keepWarm";
  import { keepWarm, loadKeepWarm, setKeepWarm } from "./keepWarm.svelte";

  // Item 663: `reply` hangs it on the reply's side (left) instead of his.
  let { chat, side = "user" }: { chat: string; side?: "user" | "reply" } = $props();

  const status = $derived(keepWarm.byChat[chat] ?? null);
  $effect(() => {
    void loadKeepWarm(chat);
  });
  // The line goes when the schedule's end passes: one timer to that moment.
  let now = $state(Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const until = status?.warm_until_ms ?? null;
    if (timer != null) clearTimeout(timer);
    timer = null;
    now = Date.now();
    if (until != null && until > now) timer = setTimeout(() => (now = Date.now()), Math.min(until - now + 50, 2_000_000_000));
  });
  onDestroy(() => {
    if (timer != null) clearTimeout(timer);
  });
  const line = $derived(noticeLine(status, now));

  async function off() {
    const refused = await setKeepWarm(chat, "off");
    if (refused) addToast(`Keep warm: ${refused}`);
  }
</script>

{#if line}
  <div class="keep-warm-notice" class:under-reply={side === "reply"} role="status">
    <span class="kw-dot" aria-hidden="true"></span>
    <span class="kw-line" use:tip={switchTitle(status, now)}>{line}{status?.mode === "once" ? " or your next message" : ""}</span>
    <button class="kw-off" type="button" use:tip={"Switch this chat's keep-warm off — no more requests; the cache runs out its hour"} onclick={() => void off()}>turn off</button>
  </div>
{/if}

<style>
  /* Classic: a plain dim line, right-aligned under his bubble. */
  .keep-warm-notice {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin: 2px 0 6px;
    font: 11.5px var(--sans);
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .kw-dot {
    display: none;
  }
  .kw-off {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--dim);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .kw-off:hover {
    color: var(--ink);
  }
  /* Filament IV: a small raised pill with a warm dot. */
  :global(:where(:root:not([data-layout="classic"]))) .keep-warm-notice {
    width: fit-content;
    margin: 4px 0 8px auto;
    padding: 3px 10px 3px 9px;
    gap: 7px;
    border: 1px solid var(--line2);
    border-radius: 12px;
    background: var(--raised);
    font: 500 11px var(--sans);
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .kw-dot {
    display: block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .kw-off {
    padding-left: 7px;
    border-left: 1px solid var(--line2);
    text-decoration: none;
    color: var(--dim);
  }
  :global(:where(:root:not([data-layout="classic"]))) .kw-off:hover {
    color: var(--accent);
  }
  .keep-warm-notice.under-reply {
    justify-content: flex-start;
  }
  :global(:where(:root:not([data-layout="classic"]))) .keep-warm-notice.under-reply {
    margin: 4px auto 8px 0;
  }
</style>
