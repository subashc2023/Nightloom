<script lang="ts">
  /**
   * Settings → Phone: the phones allowed to send from a card (nightshift item 993g, blocker 2359).
   *
   * A reply, a forward, an RSVP or a saved draft from the phone's sheet runs on the Mac only when the phone signed
   * its tap with a key that never leaves that phone. A phone gets that right here and nowhere else: it asks (its
   * sheet's "Allow this phone to send"), the ask shows below with a six-digit code the phone shows too, and **his
   * Allow click on this row** is what allows it (`phone_key_allow`, a window command: nothing outside this window
   * can call it — not the listener, not a model's shell). Remove takes the right away again; it asks first.
   */
  import { onMount } from "svelte";
  import * as api from "./api";
  import type { PhoneKeyRow, PhoneKeys } from "./api";

  type Deps = {
    list: () => Promise<PhoneKeys>;
    allow: (id: string) => Promise<PhoneKeys>;
    deny: (id: string) => Promise<PhoneKeys>;
    revoke: (id: string) => Promise<PhoneKeys>;
    /** Calls `again` when the Mac says the lists changed; returns the stop. */
    changed: (again: () => void) => Promise<() => void>;
  };
  const real: Deps = {
    list: api.phoneKeysList,
    allow: api.phoneKeyAllow,
    deny: api.phoneKeyDeny,
    revoke: api.phoneKeyRevoke,
    changed: async (again) => {
      const { listen } = await import("@tauri-apps/api/event");
      const a = await listen("phone-key-asked", again);
      const b = await listen("phone-keys-changed", again);
      return () => (a(), b());
    },
  };
  let { deps = real }: { deps?: Deps } = $props();

  let keys = $state<PhoneKeys | null>(null);
  let busy = $state<string | null>(null);
  let failed = $state<string | null>(null);
  // The allowed phone whose Remove was pressed once: the row asks before it goes.
  let removing = $state<string | null>(null);

  async function read(): Promise<void> {
    try {
      keys = await deps.list();
    } catch (e) {
      failed = String(e);
    }
  }
  async function run(id: string, call: (id: string) => Promise<PhoneKeys>): Promise<void> {
    if (busy) return;
    busy = id;
    failed = null;
    try {
      keys = await call(id);
    } catch (e) {
      failed = String(e);
      await read();
    } finally {
      busy = null;
      removing = null;
    }
  }
  onMount(() => {
    void read();
    let stop: (() => void) | null = null;
    let gone = false;
    void deps.changed(() => void read()).then((s) => (gone ? s() : (stop = s)));
    return () => {
      gone = true;
      stop?.();
    };
  });

  const when = (r: PhoneKeyRow) => {
    const d = new Date(r.at);
    return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
</script>

<p class="pk-note">
  A phone can read everything once it is paired. To send from a card (a reply, a forward, an RSVP, a saved draft) it must
  also be allowed here: press "Allow this phone to send" on the phone, then Allow below. Nothing else can allow a phone.
</p>

{#if keys?.error}<p class="pk-err" role="alert">{keys.error}</p>{/if}
{#if failed}<p class="pk-err" role="alert">{failed}</p>{/if}

{#each keys?.asked ?? [] as r (r.id)}
  <div class="pk-row pk-ask" data-phone-ask={r.id}>
    <div class="pk-who">
      <span class="pk-name">{r.name} asks to send</span>
      <span class="pk-code" aria-label="Code {r.code}">{r.code}</span>
      <span class="pk-sub">Asked {when(r)}. Allow only if you just pressed it on your phone and the phone shows this code.</span>
    </div>
    <div class="pk-acts">
      <button type="button" class="ns-btn accent" disabled={busy !== null} onclick={() => void run(r.id, deps.allow)}>Allow</button>
      <button type="button" class="ns-btn" disabled={busy !== null} onclick={() => void run(r.id, deps.deny)}>Don't allow</button>
    </div>
  </div>
{/each}

{#each keys?.allowed ?? [] as r (r.id)}
  <div class="pk-row" data-phone-allowed={r.id}>
    <div class="pk-who">
      <span class="pk-name">{r.name}</span>
      <span class="pk-sub">Allowed to send since {when(r)}.</span>
    </div>
    <div class="pk-acts">
      {#if removing === r.id}
        <span class="pk-sub">It will read, and send nothing, until you allow it again.</span>
        <button type="button" class="ns-btn danger" disabled={busy !== null} onclick={() => void run(r.id, deps.revoke)}>Remove</button>
        <button type="button" class="ns-btn" onclick={() => (removing = null)}>Keep</button>
      {:else}
        <button type="button" class="ns-btn" disabled={busy !== null} onclick={() => (removing = r.id)}>Remove…</button>
      {/if}
    </div>
  </div>
{/each}

{#if keys && keys.asked.length === 0 && keys.allowed.length === 0 && !keys.error}
  <p class="pk-note">No phone is allowed to send yet.</p>
{/if}

<style>
  .pk-note,
  .pk-sub {
    margin: 0;
    color: var(--dim);
    font-size: 12px;
    line-height: 1.45;
  }
  .pk-err {
    margin: 0;
    color: var(--red, #c0392b);
    font-size: 12px;
  }
  .pk-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .pk-ask {
    border-color: var(--accent);
  }
  .pk-who {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 220px;
  }
  .pk-name {
    font-size: 13px;
    font-weight: 500;
  }
  .pk-code {
    font-family: var(--mono);
    font-size: 22px;
    letter-spacing: 0.08em;
  }
  .pk-acts {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
