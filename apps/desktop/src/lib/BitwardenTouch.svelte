<script lang="ts">
  // Settings → Subscription → Bitwarden → Touch ID unlock (nightshift item
  // 826): set up once (the master password, accepted by bw, then kept in the
  // Keychain), unlock now, lock now, forget the stored password. The typed
  // password is this component's state until handed to the app, then emptied.
  import * as api from "./api";
  import { BW_MASTER_WHERE, BW_TOUCH_TIP } from "./secret";
  import { tip } from "./tip";

  let { status, onchange }: { status: api.BitwardenTouchStatus | null; onchange: () => void } = $props();

  let master = $state("");
  let busy = $state(false);
  let note = $state<string | null>(null);

  $effect(() => () => {
    master = "";
  });

  async function run(f: () => Promise<unknown>, done: string) {
    if (busy) return;
    busy = true;
    note = null;
    try {
      const r = await f();
      note = r === "unauthenticated" ? "Bitwarden is signed out. In Terminal: bw login" : r === "missing" ? "Bitwarden's command line is not installed." : done;
    } catch (e) {
      note = String(e).replace(/^Error:\s*/, "");
    } finally {
      busy = false;
      onchange();
    }
  }

  function setup() {
    if (!master) return;
    const pw = master;
    master = "";
    void run(() => api.bitwardenTouchSetup(pw), "Set up, and unlocked until quit, sleep or screen lock.");
  }
</script>

<div class="bwt">
  {#if status === null}
    <p class="note small">Reading…</p>
  {:else}
    {#if !status.stored}
      <div class="row">
        <input
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="Bitwarden master password"
          aria-label="Bitwarden master password"
          bind:value={master}
          disabled={busy}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setup();
            }
          }}
        />
        <button class="ns-btn small" disabled={busy || !master} onclick={setup}>Save and unlock</button>
      </div>
    {:else}
      <div class="row">
        <button class="ns-btn accent small" disabled={busy || status.session} use:tip={BW_TOUCH_TIP} onclick={() => void run(() => api.bitwardenTouchUnlock(), "Unlocked until quit, sleep or screen lock.")}>Unlock with Touch ID</button>
        <button class="ns-btn ghost small" disabled={busy || !status.session} onclick={() => void run(() => api.bitwardenForgetSession(), "Locked.")}>Lock now</button>
        <button class="ns-btn ghost small" disabled={busy} onclick={() => void run(() => api.bitwardenTouchForget(), "The stored master password is gone from the Keychain.")}>Forget the password</button>
      </div>
    {/if}
    <!-- Item 917: the not-set-up state says what setting up gives. -->
    <p class="note small">{status.stored ? (status.session ? "Unlocked for Nightloom." : "Set up · locked.") : "Not set up. Type the master password once; after that one Touch ID press unlocks Bitwarden for Nightloom."} {BW_MASTER_WHERE}</p>
    {#if note}<p class="note small" role="status">{note}</p>{/if}
  {/if}
</div>

<style>
  .bwt {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .row input {
    flex: 1;
    min-width: 180px;
  }
  /* Item 917: Settings' `.note.small` is scoped to SettingsModal, so this
     part's notes and empty state drew at the body size; the same look here. */
  .note {
    margin: 0;
    color: var(--dim);
    font-size: 12px;
    line-height: 1.45;
  }
  :global(:where(:root:not([data-layout="classic"]))) .note {
    font-size: 12.5px;
  }
</style>
