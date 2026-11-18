<script lang="ts">
  // "From Bitwarden" on the secret-request card (nightshift item 766 part 2):
  // he picks a vault item and a field; the host reads that one value through
  // `bw` into the same private file a typed value goes to, then the card
  // answers a bare Allow (`onstored`). This component holds names and field
  // names only — never a value. The pasted session key (Mac only) is this
  // component's state until it is handed to the app, then emptied.
  // Shared by the Mac's card (`SecretCard`) and the phone's (`SecretAsk`).
  import { onMount } from "svelte";
  import { tip } from "./tip";
  import {
    BW_ALWAYS_TIP,
    BW_KEY_WHERE,
    BW_NO_COMMAND_TIP,
    BW_ONCE_TIP,
    bwNotReady,
    commandPrefix,
    defaultQuery,
    fieldChip,
    firstField,
    type BwApi,
    type BwItem,
    type BwReady,
  } from "./secret";

  let {
    api,
    name,
    command,
    where,
    disabled = false,
    onstored,
  }: {
    api: BwApi;
    name: string;
    command: string | null;
    where: "mac" | "phone";
    disabled?: boolean;
    /** The value is stored: answer the card. The error to show, or null. */
    onstored: () => Promise<string | null>;
  } = $props();

  let ready = $state<BwReady | null>(null);
  let key = $state("");
  let query = $state("");
  let items = $state<BwItem[] | null>(null);
  let picked = $state<string | null>(null);
  let field = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const prefix = $derived(commandPrefix(command));
  const pickedItem = $derived(items?.find((i) => i.id === picked) ?? null);
  const notReady = $derived(ready ? bwNotReady(ready, where) : null);

  // The Mac's buttons are the app's own; the phone page has its own look.
  function btn(kind: "primary" | "plain" | "ghost"): string {
    if (where === "mac") return kind === "primary" ? "ns-btn accent" : kind === "ghost" ? "ns-btn ghost small" : "ns-btn";
    return `bw-btn ${kind}`;
  }

  function why(e: unknown): string {
    return String(e).replace(/^Error:\s*/, "");
  }

  async function check() {
    try {
      ready = await api.ready();
    } catch {
      ready = "missing";
    }
    if (ready === "unlocked" && items === null) {
      query = query || defaultQuery(name);
      if (query) await search();
    }
  }

  // Once, when the card is drawn: `bw status` runs only here, never at launch.
  onMount(() => {
    void check();
  });
  // Nothing pasted outlives the card.
  $effect(() => () => {
    key = "";
  });

  async function unlock() {
    if (!api.useSession || !key.trim() || busy) return;
    busy = true;
    error = null;
    try {
      ready = await api.useSession(key);
      key = "";
      if (ready === "unlocked") {
        query = query || defaultQuery(name);
        if (query) await search();
      }
    } catch (e) {
      error = why(e);
    } finally {
      key = "";
      busy = false;
    }
  }

  async function search() {
    if (!query.trim()) return;
    error = null;
    try {
      items = await api.search(query);
      if (items.length === 1) pick(items[0]);
      else if (!items.some((i) => i.id === picked)) {
        picked = null;
        field = null;
      }
    } catch (e) {
      error = why(e);
      // A lapsed session reads as locked again.
      void api.ready().then((r) => (ready = r)).catch(() => {});
    }
  }

  function pick(item: BwItem) {
    picked = item.id;
    field = firstField(item);
  }

  async function use(always: boolean) {
    if (busy || disabled || !picked || !field) return;
    busy = true;
    error = null;
    try {
      await api.store(picked, field, always ? command : null);
    } catch (e) {
      error = `Not read: ${why(e)}`;
      busy = false;
      return;
    }
    const e = await onstored();
    if (e) error = e;
    busy = false;
  }
</script>

<div class="bw" class:phone={where === "phone"} role="group" aria-label="From Bitwarden">
  <div class="bw-head"><span class="rule"></span><span>or from Bitwarden</span><span class="rule"></span></div>

  {#if ready === null}
    <div class="bw-line">Checking Bitwarden…</div>
  {:else if notReady}
    {@const m = /^(.*In Terminal: )(.+?)( — .*)?$/.exec(notReady)}
    <div class="bw-line" data-bw-state={ready}>{#if m}{m[1]}<code>{m[2]}</code>{m[3] ?? ""}{:else}{notReady}{/if}</div>
    {#if ready === "locked" && where === "mac" && api.useSession}
      <div class="bw-row">
        <input
          type="password"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Paste the session key"
          aria-label="Bitwarden session key"
          bind:value={key}
          disabled={busy || disabled}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void unlock();
            }
          }}
        />
        <button class={btn("ghost")} type="button" disabled={busy || disabled || !key.trim()} onclick={() => void unlock()}>Unlock</button>
      </div>
      <div class="bw-line small">{BW_KEY_WHERE}</div>
    {:else}
      <div class="bw-line small">The field above still works.</div>
    {/if}
  {:else}
    <div class="bw-row">
      <input
        type="search"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="Search the vault"
        aria-label="Search Bitwarden"
        bind:value={query}
        disabled={busy || disabled}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            void search();
          }
        }}
      />
      <button class={btn("ghost")} type="button" disabled={busy || disabled || !query.trim()} onclick={() => void search()}>Search</button>
    </div>
    {#if items && items.length === 0}
      <div class="bw-line small">Nothing in the vault matches “{query}”.</div>
    {:else if items}
      <ul class="bw-items">
        {#each items as item (item.id)}
          <li>
            <button type="button" class="bw-item" class:on={item.id === picked} aria-pressed={item.id === picked} disabled={busy || disabled} onclick={() => pick(item)}>
              <span class="bw-name">{item.name}</span>
              {#if item.host}<span class="bw-host">{item.host}</span>{/if}
            </button>
            {#if item.id === picked && item.fields.length}
              <div class="bw-fields" role="radiogroup" aria-label="Which field">
                {#each item.fields as f (f)}
                  <button type="button" role="radio" class="chip" class:on={f === field} aria-checked={f === field} disabled={busy || disabled} onclick={() => (field = f)}>{fieldChip(f)}</button>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if pickedItem}
      <div class="bw-acts">
        <button class="{btn('primary')} bw-once" type="button" disabled={busy || disabled || !field} use:tip={BW_ONCE_TIP} onclick={() => void use(false)}>Use once</button>
        <span use:tip={prefix ? BW_ALWAYS_TIP : BW_NO_COMMAND_TIP}>
          <button class="{btn('plain')} bw-always" type="button" disabled={busy || disabled || !field || !prefix} onclick={() => void use(true)}>
            {#if prefix}Always for <code>{prefix}</code>{:else}Always for this command{/if}
          </button>
        </span>
      </div>
    {/if}
  {/if}
  {#if error}<div class="bw-line err">{error}</div>{/if}
</div>

<style>
  .bw {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bw-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .rule {
    flex: 1;
    height: 1px;
    background: var(--line2, var(--line));
  }
  .bw-line {
    font-size: 13px;
    line-height: 1.5;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  .bw-line[data-bw-state] {
    color: var(--ink);
  }
  .bw-line code {
    font-family: var(--mono);
    font-size: 12px;
  }
  .bw-line.small {
    font-size: 12px;
  }
  .bw-line.err {
    color: var(--danger, var(--accent));
  }
  .bw-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .bw-row input {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--ink);
    background: var(--paper, var(--well));
    border: 1px solid var(--line2, var(--line));
    border-radius: 8px;
    padding: 6px 10px;
  }
  .bw-row input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .bw-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 180px;
    overflow-y: auto;
  }
  .bw-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    text-align: left;
    font: inherit;
    font-size: 13px;
    color: var(--ink);
    background: none;
    border: 1px solid var(--line2, var(--line));
    border-radius: 8px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .bw-item.on {
    border-color: var(--accent);
  }
  .bw-name {
    font-weight: 600;
  }
  .bw-host {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bw-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 0 2px 10px;
  }
  .chip {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    background: none;
    border: 1px solid var(--line2, var(--line));
    border-radius: 999px;
    padding: 1px 9px;
    cursor: pointer;
  }
  .chip.on {
    color: var(--ink);
    border-color: var(--accent);
  }
  .bw-acts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .bw-acts code {
    font-family: var(--mono);
    font-size: 12px;
  }
  /* The phone: its own sizes (16 px fields so iOS does not zoom, 36 px taps). */
  .phone .bw-row input {
    font-size: 16px;
    min-height: 36px;
  }
  .phone .bw-item {
    font-size: 14px;
    min-height: 36px;
  }
  .phone .chip {
    font-size: 13px;
    min-height: 30px;
    padding: 2px 12px;
  }
  .bw-btn {
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
  .bw-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .bw-btn.ghost {
    background: none;
    color: var(--dim);
  }
  .bw-btn:disabled {
    opacity: 0.5;
  }
</style>
