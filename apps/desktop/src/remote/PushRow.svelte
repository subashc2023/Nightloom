<script lang="ts">
  /**
   * Notifications on this phone (nightshift item 739): the Subscribe
   * control and its off switch, in the settings sheet under the look row.
   * The logic is `push.ts`; this is the row. Like the look, it is this
   * phone's own setting — nothing on the Mac changes when it is switched.
   *
   * What a notification says is the chat's name and its state ("Finished",
   * "Waiting for your approval") and nothing of the reply (blocker 2011).
   */
  import { onMount } from "svelte";
  import { browserEnv, disablePush, enablePush, pushSummary, refreshPush, supportHere, supportWords, type HostPush, type PushEnv, type PushHost, type PushSupport } from "./push";
  import type { HostRole } from "./hosts";

  interface Props {
    /** Every paired host's push routes. */
    hosts: PushHost[];
    /** Tests and the harness: the support verdict and the browser's half. */
    support?: PushSupport;
    env?: PushEnv;
  }
  let { hosts, support = supportHere(), env }: Props = $props();

  const words = $derived(supportWords(support));
  let mode = $state<"off" | "on" | "denied">("off");
  let standing = $state<Partial<Record<HostRole, HostPush>>>({});
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let tested = $state<string | null>(null);

  const the = () => env ?? browserEnv();

  onMount(() => {
    if (support !== "ok") return;
    const e = the();
    if (e.permission() === "denied") {
      mode = "denied";
      return;
    }
    if (!e.remembered()) return;
    // On here already: show it at once, then bring the hosts up to date.
    mode = "on";
    void refreshPush(e, hosts).then((r) => {
      if (r?.state === "on") standing = r.hosts;
      else if (r) problem = r.problem ?? null;
    });
  });

  // Straight from the tap: the permission prompt needs the gesture.
  async function turnOn() {
    busy = true;
    problem = null;
    tested = null;
    try {
      const r = await enablePush(the(), hosts);
      if (r.state === "on") {
        mode = "on";
        standing = r.hosts;
      } else if (r.state === "denied") mode = "denied";
      else problem = r.problem ?? "Notifications could not be turned on.";
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function turnOff() {
    busy = true;
    problem = null;
    tested = null;
    try {
      await disablePush(the(), hosts);
      mode = "off";
      standing = {};
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function sendTest() {
    busy = true;
    tested = null;
    try {
      const results = await Promise.all(hosts.filter((h) => standing[h.role] === "on").map((h) => h.test().catch(() => null)));
      const sent = results.reduce((n, r) => n + (r?.sent ?? 0), 0);
      tested = sent > 0 ? "Sent — it should arrive in a few seconds." : "No host could send one just now.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="pr-label">Notifications on this phone</div>
{#if words}
  <small class="pr-small" data-push="unavailable">{words}</small>
{:else if mode === "denied"}
  <small class="pr-small" data-push="denied">Notifications are turned off for Nightloom in the iPhone's Settings → Notifications → Nightloom. Allow them there, then come back.</small>
{:else}
  <button class="pr-switch" role="switch" aria-checked={mode === "on"} aria-label="Notifications on this phone" disabled={busy} data-act="push" onclick={() => (mode === "on" ? turnOff() : turnOn())}>
    <span class="pr-grow">
      {mode === "on" ? "On" : "Off"}
      <small>{mode === "on" ? pushSummary(standing) : "A turn finished, failed or paused; an approval or a question waiting."}</small>
    </span>
    <span class="pr-knob" class:on={mode === "on"}></span>
  </button>
  {#if mode === "on"}
    <button class="pr-test" disabled={busy || !Object.values(standing).includes("on")} data-act="push-test" onclick={sendTest}>Send a test notification</button>
    {#if tested}<small class="pr-small" role="status">{tested}</small>{/if}
  {/if}
  <small class="pr-small">It shows the chat's name and its state — never the reply. None are sent while you are at the Mac.</small>
{/if}
{#if problem}<p class="pr-bad" role="alert">{problem}</p>{/if}

<style>
  .pr-label {
    font-size: 13px;
    color: var(--dim);
    margin: 4px 0 -4px;
  }
  .pr-small {
    font-size: 12px;
    color: var(--dim);
    margin-top: -4px;
    line-height: 1.4;
  }
  /* The settings sheet's own switch (RailSheet's .rs-switch / .rs-knob):
     the whole row is the button. */
  .pr-switch {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    min-height: 44px;
    box-sizing: border-box;
    background: var(--paper);
    border-radius: 14px;
    cursor: pointer;
  }
  .pr-switch:disabled {
    opacity: 0.6;
  }
  .pr-switch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .pr-grow {
    flex: 1;
    min-width: 0;
  }
  .pr-switch small {
    display: block;
    font-size: 12px;
    color: var(--dim);
  }
  .pr-knob {
    width: 46px;
    height: 28px;
    border-radius: 14px;
    background: var(--line2);
    position: relative;
    flex: none;
    transition: background 0.2s;
  }
  .pr-knob::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--sheet);
    transition: transform 0.2s;
  }
  .pr-knob.on {
    background: var(--accent);
  }
  .pr-knob.on::after {
    transform: translateX(18px);
  }
  .pr-test {
    all: unset;
    cursor: pointer;
    box-sizing: border-box;
    min-height: 44px;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
  }
  .pr-test:disabled {
    opacity: 0.5;
  }
  .pr-bad {
    font-size: 13px;
    color: var(--failed);
    margin: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .pr-knob,
    .pr-knob::after {
      transition: none;
    }
  }
</style>
