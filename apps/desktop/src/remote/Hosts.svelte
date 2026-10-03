<script lang="ts">
  /**
   * The two hosts on the phone page (item 246 wave 4B): the chip in the top
   * bar that says which host is answering — the Mac or Away — and, as a
   * sheet, the place to pair, re-pair or forget each one. One component,
   * two `mode`s, so the chip and the sheet read the same words.
   *
   * Pairing is by link, as the QR does it: the link's `#token=…` fragment
   * never leaves the phone. A page served over HTTPS (Away) cannot call
   * the Mac's plain-HTTP address (mixed content, until the Mac serves
   * HTTPS — blocker 660), so the sheet says that in one sentence and offers
   * the Mac's own page instead.
   */
  import {
    ROLES,
    addressOf,
    hostLabel,
    hostName,
    mixedBlocked,
    openLink,
    pairLink,
    type HostEntry,
    type HostRole,
    type Hosts,
    type Tried,
  } from "./hosts";

  interface Props {
    mode: "chip" | "sheet";
    hosts: Hosts;
    /** The host answering now, or null while none is. */
    active: HostRole | null;
    /** `online` while the active host's stream is open. */
    link: "connecting" | "online" | "offline" | "off";
    /** What the last host choice found on the hosts it did not take. */
    tried?: Tried[];
    /** The page's own origin (`location.origin`). */
    origin?: string;
    onopen?: () => void;
    onpair?: (role: HostRole, entry: HostEntry) => void;
    onforget?: (role: HostRole) => void;
    onretry?: () => void;
  }
  let { mode, hosts, active, link, tried = [], origin = "", onopen, onpair, onforget, onretry }: Props = $props();

  /** The role whose pair box is open, and what he pasted into it. */
  let pairing = $state<HostRole | null>(null);
  let pasted = $state("");
  let problem = $state<string | null>(null);
  /** The role whose Forget is asking to be confirmed. */
  let forgetting = $state<HostRole | null>(null);

  const chipText = $derived(
    active && link === "online" ? hostLabel(active) : link === "off" ? "Not paired" : link === "connecting" ? "…" : "Offline",
  );

  function blocked(role: HostRole): boolean {
    const e = hosts[role];
    return !!e && !!origin && mixedBlocked(origin, e.base);
  }

  function line(role: HostRole): string {
    const e = hosts[role];
    if (!e) return "Not paired on this phone.";
    if (blocked(role))
      return `This page is served over HTTPS, so it cannot call ${hostName(role)}'s plain-HTTP address until ${hostName(role)} serves HTTPS — use its own page (a second home-screen icon).`;
    if (role === active && link === "online") return "Answering — sends, actions and reads go here.";
    const t = tried.find((x) => x.role === role);
    if (t?.why === "refused") return "Its token was refused — pair it again from its link.";
    if (t?.why === "timeout") return `Did not answer within 1.5 s at ${addressOf(e.base)}.`;
    if (t?.why === "unreachable") return `Could not be reached at ${addressOf(e.base)}.`;
    if (role === active) return "Connecting…";
    return "Paired — tried when the other host does not answer.";
  }

  function beginPair(role: HostRole) {
    pairing = role;
    pasted = "";
    problem = null;
    forgetting = null;
  }

  function savePair() {
    if (!pairing) return;
    const entry = pairLink(pasted, origin);
    if (!entry) {
      problem = "That is not a Nightloom link or token. Copy the link under the QR code (it ends in #token=…).";
      return;
    }
    onpair?.(pairing, entry);
    pairing = null;
    pasted = "";
    problem = null;
  }
</script>

{#if mode === "chip"}
  <button
    class="hc-chip"
    class:ok={link === "online"}
    class:away={active === "away" && link === "online"}
    onclick={onopen}
    aria-label={active && link === "online" ? `Answering: ${hostName(active)} — hosts` : "Hosts"}
  >
    <span class="hc-dot"></span>{chipText}
  </button>
{:else}
  <div class="hs-title">Hosts</div>
  <p class="hs-note">The page tries the Mac first, then Away. Each has its own token; a chat stays with the host it came from.</p>
  {#each ROLES as role (role)}
    {@const e = hosts[role]}
    <section class="hs-host" class:on={role === active && link === "online"}>
      <div class="hs-head">
        <span class="hs-name">{hostLabel(role)}</span>
        {#if e}<span class="hs-addr">{addressOf(e.base)}</span>{/if}
        {#if role === active && link === "online"}<span class="hs-badge">Answering</span>{/if}
      </div>
      <p class="hs-line" class:bad={!!e && (blocked(role) || tried.some((t) => t.role === role))}>{line(role)}</p>
      {#if e && blocked(role)}
        <a class="hs-btn" href={openLink(e)} rel="noopener">Open {hostName(role)}'s page</a>
      {/if}
      {#if pairing === role}
        <input
          class="hs-input"
          type="text"
          placeholder={role === "mac" ? "The link from Settings → Remote on the Mac" : "The away server's link (…#token=…)"}
          bind:value={pasted}
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
        />
        {#if problem}<p class="hs-line bad">{problem}</p>{/if}
        <div class="hs-row">
          <button class="hs-btn accent" disabled={!pasted.trim()} onclick={savePair}>Pair</button>
          <button class="hs-btn" onclick={() => (pairing = null)}>Cancel</button>
        </div>
      {:else if forgetting === role}
        <p class="hs-line">Forget {hostName(role)} on this phone? Its token goes; pairing again needs its link.</p>
        <div class="hs-row">
          <button class="hs-btn danger" onclick={() => (onforget?.(role), (forgetting = null))}>Forget</button>
          <button class="hs-btn" onclick={() => (forgetting = null)}>Keep</button>
        </div>
      {:else}
        <div class="hs-row">
          <button class="hs-btn" onclick={() => beginPair(role)}>{e ? "Pair again" : "Pair"}</button>
          {#if e}<button class="hs-btn" onclick={() => ((forgetting = role), (pairing = null))}>Forget</button>{/if}
        </div>
      {/if}
    </section>
  {/each}
  {#if link !== "online"}
    <button class="hs-btn accent wide" onclick={onretry}>Try again</button>
  {/if}
  <p class="hs-note">Scanning a host's QR code with the camera opens that host's own page and pairs it there.</p>
{/if}

<style>
  .hc-chip {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 30px;
    padding: 0 9px;
    margin: 0 2px;
    border-radius: 15px;
    border: 1px solid var(--line2);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink2);
    white-space: nowrap;
    flex: none;
    box-sizing: border-box;
  }
  .hc-chip:active {
    background: var(--well);
  }
  .hc-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--failed);
  }
  .hc-chip.ok .hc-dot {
    background: var(--done);
  }
  .hc-chip.away {
    border-color: var(--live);
    color: var(--live);
  }
  .hc-chip.away .hc-dot {
    background: var(--live);
  }
  .hs-title {
    font-weight: 600;
    font-size: 17px;
  }
  .hs-note {
    font-size: 13px;
    color: var(--dim);
    margin: 0;
  }
  .hs-host {
    background: var(--paper);
    border-radius: 16px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-left: 3px solid var(--line2);
  }
  .hs-host.on {
    border-left-color: var(--done);
  }
  .hs-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .hs-name {
    font-weight: 600;
    font-size: 16px;
  }
  .hs-addr {
    font-size: 13px;
    color: var(--dim);
    font-family: var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .hs-badge {
    font-size: 12px;
    font-weight: 600;
    color: var(--done);
    margin-left: auto;
  }
  .hs-line {
    font-size: 14px;
    color: var(--ink2);
    margin: 0;
    overflow-wrap: anywhere;
  }
  .hs-line.bad {
    color: var(--failed);
  }
  .hs-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hs-input {
    font: inherit;
    font-size: 16px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--line2);
    background: var(--sheet);
    color: var(--ink);
    min-width: 0;
  }
  .hs-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
    color: var(--ink);
  }
  .hs-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .hs-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .hs-btn.danger {
    color: var(--failed);
    border-color: var(--failed);
  }
  .hs-btn.wide {
    width: 100%;
  }
</style>
