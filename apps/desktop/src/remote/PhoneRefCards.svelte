<script lang="ts">
  /**
   * The typed link's card on the phone (nightshift item 993f): the Mac's own card host and card (`RefCardHost`,
   * `RefCard`) as a bottom sheet, with every action run on the Mac through the listener (`phoneRefAct.ts`). A tap on
   * an event, email or doc name in any reply on the phone — Home's chat, a chat, an aside — opens it.
   *
   * The hold bar and the toasts are this page's own (the phone has no Mac toasts): a mail's hold shows here with its
   * Undo whether or not the sheet is open, so closing the sheet never leaves a mail going with no Undo in sight.
   * Drafts are the phone's own (`refDrafts`, this page's storage) and are kept whatever the link does.
   *
   * **This phone must be allowed to send** (item 993g): a tap is signed with a key only this page holds
   * (`phoneKey.ts`), and the Mac takes it only from a phone he allowed in the Mac's window. Until then the sheet
   * reads (details, Open, Copy), its actions are off with the reason, and "Allow this phone to send" asks the Mac:
   * the code shown here is the one the Mac shows beside its Allow. Drafts typed meanwhile are kept.
   */
  import { onMount } from "svelte";
  import { NEEDS_HTTPS, phoneName, spacedCode, webSigner, type PhoneSigner } from "./phoneKey";
  import RefCardHost from "../lib/RefCardHost.svelte";
  import { MAIL_HOLD_MS, type HoldToast } from "../lib/mailHold";
  import { ApiError, type Client } from "./client";
  import { phoneRefCards } from "./phoneRefAct";

  let {
    mac,
    offline,
    holdMs = MAIL_HOLD_MS,
    signer = webSigner(),
    pollMs = 4000,
  }: { mac: () => Client | null; offline: () => string | null; holdMs?: number; signer?: PhoneSigner; pollMs?: number } = $props();

  // Where this phone's key stands on the Mac. "unknown" until the Mac was asked; "cannot" on a page with no WebCrypto.
  // `said` is the Mac's own refusal to say (its Keychain could not be read): then nothing is allowed.
  type Stand = { state: "unknown" | "allowed" | "waiting" | "none" | "cannot"; id?: string; code?: string; said?: string };
  let stand = $state<Stand>({ state: "unknown" });
  let asking = $state(false);
  let seq = 0;

  /** Ask the Mac where this phone's key stands. A phone with no key yet has none to ask about. */
  async function look(): Promise<void> {
    if (signer.cannot()) return void (stand = { state: "cannot" });
    const c = mac();
    if (!c) return;
    const n = ++seq;
    try {
      const pub = await signer.have();
      const s = pub ? await c.refKey(pub) : null;
      if (n === seq) stand = s ? { state: s.state, id: s.id, code: s.code } : { state: "none" };
    } catch (e) {
      // The Mac answered and would not say (its Keychain is locked, or it is an older build): nothing is allowed, and
      // the sheet says why. Not reached at all: what was known stands; the next look tries again.
      if (n === seq && e instanceof ApiError) stand = { state: "unknown", said: e.message || `Your Mac answered ${e.status}, so this phone cannot send yet.` };
    }
  }

  /** His "Allow this phone to send": the key is made here if there is none, and the Mac is asked. */
  async function ask(): Promise<void> {
    const c = mac();
    if (!c || asking || signer.cannot()) return;
    asking = true;
    const n = ++seq;
    try {
      const s = await c.refEnroll(await signer.make(), phoneName());
      if (n === seq) stand = { state: s.state, id: s.id, code: s.code };
    } catch (e) {
      toast(`Could not ask your Mac: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      asking = false;
    }
  }

  // Look when the Mac is reachable (again), when the page comes back to the front, and while waiting for his Allow.
  $effect(() => {
    if (offline() === null) void look();
  });
  $effect(() => {
    if (stand.state !== "waiting") return;
    const t = setInterval(() => document.visibilityState === "visible" && offline() === null && void look(), pollMs);
    return () => clearInterval(t);
  });
  onMount(() => {
    const again = () => document.visibilityState === "visible" && offline() === null && void look();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  });

  /** Why this phone cannot send now: the link first, then its own standing. Null when it can. */
  function why(): string | null {
    const lost = offline();
    if (lost) return lost;
    switch (stand.state) {
      case "allowed":
        return null;
      case "cannot":
        return NEEDS_HTTPS;
      case "waiting":
        return `Waiting for your Mac. Open Nightloom there (Settings → Phone) and press Allow beside the code ${spacedCode(stand.code ?? "")}. Your words are kept.`;
      case "none":
        return "This phone can read here, and is not allowed to send yet. Your words are kept.";
      case "unknown":
        return stand.said ?? "Checking with your Mac that this phone may send…";
    }
  }
  function whyAct(): { label: string; run: () => void } | null {
    if (offline()) return null;
    if (stand.state === "none") return { label: asking ? "Asking your Mac…" : "Allow this phone to send", run: () => void ask() };
    if (stand.state === "waiting" || (stand.state === "unknown" && stand.said)) return { label: "Check again", run: () => void look() };
    return null;
  }

  const hands = phoneRefCards(() => mac(), {
    get signer() {
      return signer;
    },
    id: () => (stand.state === "allowed" ? (stand.id ?? null) : null),
    refused: () => void look(),
  });

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
  offline={why}
  offlineAct={whyAct}
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
