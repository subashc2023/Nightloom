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
   *
   * Item 681 (his "should be like a toggle instaed of jus like \"turn
   * fof\" and teh toggle sh be on the left side too and the entire thing
   * should be clickable"): the line is one switch — a small toggle on its
   * left, the words after it, the whole row the button (`role="switch"`,
   * Space / Enter from the keyboard). Off, it stays while the reply's cache
   * is still warm and says a click keeps it (`noticeRow`); a click sends
   * what the composer's keep-warm switch sends (`rowToggle`).
   */
  import { onDestroy } from "svelte";
  import { tip } from "./tip";
  import { addToast } from "./state.svelte";
  import { noticeRow, rowToggle, switchTitle } from "./keepWarm";
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
  const row = $derived(noticeRow(status, now));
  // The switch moves at the click, before the backend answers; the answer
  // (or a refusal) puts it where the status says.
  let pending: boolean | null = $state(null);
  const on = $derived(pending ?? row?.on ?? false);

  async function flip() {
    if (!row || pending !== null) return;
    const mode = rowToggle(row);
    pending = mode === "on";
    const refused = await setKeepWarm(chat, mode);
    pending = null;
    if (refused) addToast(`Keep warm: ${refused}`);
  }
</script>

{#if row}
  <button
    type="button"
    class="keep-warm-notice"
    class:under-reply={side === "reply"}
    class:on
    role="switch"
    aria-checked={on}
    use:tip={switchTitle(status, now)}
    onclick={() => void flip()}
  >
    <span class="kw-switch" aria-hidden="true"><span class="kw-knob"></span></span>
    <span class="kw-line">{row.text}</span>
  </button>
{/if}

<style>
  /* Classic: a plain dim row, right-aligned under his bubble (left under
     the reply), the switch drawn in the line's own colours. */
  .keep-warm-notice {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 7px;
    width: fit-content;
    margin: 2px 0 6px auto;
    padding: 2px 6px;
    border: 0;
    border-radius: 6px;
    background: none;
    font: 11.5px var(--sans);
    color: var(--dim);
    font-variant-numeric: tabular-nums;
    text-align: left;
    cursor: pointer;
  }
  .keep-warm-notice:hover {
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 6%, transparent);
  }
  .keep-warm-notice:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* The switch: a 22 × 12 track, a 8 px knob; on, the knob slides right on the accent. */
  .kw-switch {
    position: relative;
    flex: none;
    width: 22px;
    height: 12px;
    border-radius: 6px;
    border: 1px solid var(--line2, currentColor);
    background: transparent;
    box-sizing: border-box;
  }
  .kw-knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }
  .keep-warm-notice.on .kw-switch {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .keep-warm-notice.on .kw-knob {
    transform: translateX(10px);
    background: var(--accent);
    /* Lit: a faint glow; Calm and Classic set the token to none. */
    box-shadow: var(--glow-accent, none);
  }
  @media (prefers-reduced-motion: no-preference) {
    .kw-knob {
      transition:
        transform 180ms cubic-bezier(0.3, 0.7, 0.4, 1),
        background-color 180ms ease;
    }
    .kw-switch,
    .keep-warm-notice {
      transition:
        background-color 180ms ease,
        border-color 180ms ease,
        color 120ms ease;
    }
  }
  /* Filament IV: a small raised pill. */
  :global(:where(:root:not([data-layout="classic"]))) .keep-warm-notice {
    margin: 4px 0 8px auto;
    padding: 3px 10px 3px 7px;
    border: 1px solid var(--line2);
    border-radius: 12px;
    background: var(--raised);
    font: 500 11px var(--sans);
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .keep-warm-notice:not(.on) {
    color: var(--dim);
  }
  :global(:where(:root:not([data-layout="classic"]))) .keep-warm-notice:hover {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--line2));
    background: color-mix(in srgb, var(--accent) 7%, var(--raised));
    color: var(--ink);
  }
  .keep-warm-notice.under-reply {
    justify-content: flex-start;
    margin-left: 0;
    margin-right: auto;
  }
  :global(:where(:root:not([data-layout="classic"]))) .keep-warm-notice.under-reply {
    margin: 4px auto 8px 0;
  }
</style>
