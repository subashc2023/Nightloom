<script lang="ts">
  /**
   * The typed link's card on the phone (nightshift item 993f): the Mac's own card host and card (`RefCardHost`,
   * `RefCard`) as a bottom sheet, with every action run on the Mac through the listener (`phoneRefAct.ts`). A tap on
   * an event, email or doc name in any reply on the phone — Home's chat, a chat, an aside — opens it.
   *
   * The hold bar and the toasts are this page's own (the phone has no Mac toasts): a mail's hold shows here with its
   * Undo whether or not the sheet is open, so closing the sheet never leaves a mail going with no Undo in sight.
   * Drafts are the phone's own (`refDrafts`, this page's storage) and are kept whatever the link does.
   */
  import RefCardHost from "../lib/RefCardHost.svelte";
  import { MAIL_HOLD_MS, type HoldToast } from "../lib/mailHold";
  import type { Client } from "./client";
  import { phoneRefCards } from "./phoneRefAct";

  let { mac, offline, holdMs = MAIL_HOLD_MS }: { mac: () => Client | null; offline: () => string | null; holdMs?: number } = $props();

  const hands = phoneRefCards(() => mac());

  type Bar = { id: number; text: string; label?: string; run?: () => void };
  let bars = $state<Bar[]>([]);
  let n = 0;
  const drop = (id: number, ms: number) => setTimeout(() => (bars = bars.filter((b) => b.id !== id)), ms);
  const set = (id: number, patch: Partial<Bar>) => (bars = bars.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  function toast(text: string, action?: { label: string; run: () => void }): void {
    const id = ++n;
    bars = [...bars, { id, text, label: action?.label, run: action?.run }];
    drop(id, action ? 6000 : 4000);
  }
  const holdToast: HoldToast = {
    start: (text, undo) => {
      const id = ++n;
      bars = [...bars, { id, text, label: "Undo", run: undo }];
      return id;
    },
    update: (id, text) => set(id, { text }),
    settle: (id, text) => {
      // The hold is over: the Undo goes with it.
      set(id, { text, label: undefined, run: undefined });
      drop(id, 5000);
    },
  };
</script>

<RefCardHost
  sheet
  loadReach={hands.loadReach}
  act={hands.act}
  readMail={hands.readMail}
  mailSend={true}
  {toast}
  {holdToast}
  {holdMs}
  {offline}
  armSend={hands.armSend}
  disarm={hands.disarm}
  lockOf={hands.lockOf}
  checked={hands.checked}
/>

{#if bars.length > 0}
  <div class="ref-hold-bar" role="status" aria-live="polite">
    {#each bars as b (b.id)}
      <div class="rhb">
        <span class="rhb-t">{b.text}</span>
        {#if b.run && b.label}
          {@const run = b.run}
          <button type="button" class="rhb-b" onclick={() => (run(), set(b.id, { label: undefined, run: undefined }))}>{b.label}</button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* Above the sheet and the page, under the status bar: seen with the sheet open or closed. */
  .ref-hold-bar {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 8px);
    left: 8px;
    right: 8px;
    z-index: 90;
    display: flex;
    flex-direction: column;
    gap: 6px;
    pointer-events: none;
  }
  .rhb {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px 9px 13px;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: var(--sheet);
    color: var(--ink);
    font: 14px var(--sans);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    pointer-events: auto;
    animation: rhb-in 220ms var(--ease, ease-out) both;
  }
  .rhb-t {
    flex: 1;
    min-width: 0;
  }
  .rhb-b {
    flex: none;
    min-height: 36px;
    padding: 6px 14px;
    border: 1px solid var(--accent);
    border-radius: 9px;
    background: var(--accent-soft);
    color: var(--accent-ink, var(--ink));
    font: 500 14px var(--sans);
    -webkit-tap-highlight-color: transparent;
    transition: transform 80ms ease-out;
  }
  .rhb-b:active {
    transform: scale(0.96);
  }
  @keyframes rhb-in {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rhb {
      animation: none;
    }
  }
</style>
