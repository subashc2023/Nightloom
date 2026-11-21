<script lang="ts">
  /**
   * Home on this Mac, on the phone (nightshift item 808): Messages,
   * Contacts, Reminders and the Calendar app, each with its status as the
   * Mac reads it now, and "Ask on the Mac" for one not allowed yet. The ask
   * opens Settings → Home on the Mac at that row; macOS's own dialog opens
   * only when he presses Allow there — never from the phone.
   *
   * Placed by the phone's Home screen (`HomeFirst.svelte`) under its own
   * heading; it draws no heading itself. Variables only from the page's
   * palettes, so it reads in Jarvis and Classic, light and dark.
   */
  import { onMount } from "svelte";
  import { canAsk, isRead, sourceStatusWords, sourcesSummary, type HomeSource, type SourceId } from "../lib/homeSources";
  import type { Client } from "./client";
  import Icon from "../lib/Icon.svelte";
  import { macLook } from "../lib/homeStage/sourceLook";

  interface Props {
    client: Pick<Client, "homeSources" | "homeSourceAsk">;
  }
  let { client }: Props = $props();

  let rows = $state<HomeSource[] | null>(null);
  /** This host has no such route (an older Mac). */
  let missing = $state(false);
  let problem = $state<string | null>(null);
  let busy = $state<SourceId | null>(null);
  /** What the Mac said after an ask, by row. */
  let said = $state<Partial<Record<SourceId, string>>>({});

  async function load(): Promise<void> {
    try {
      const got = await client.homeSources();
      if (got === null) missing = true;
      else rows = got;
      problem = null;
    } catch (e) {
      problem = `Could not read them — ${String(e)}`;
    }
  }

  async function ask(id: SourceId): Promise<void> {
    if (busy) return;
    busy = id;
    try {
      const r = await client.homeSourceAsk(id);
      said = { ...said, [id]: r.said };
    } catch (e) {
      said = { ...said, [id]: `The Mac did not take it — ${String(e)}` };
    } finally {
      busy = null;
    }
  }

  onMount(() => {
    void load();
    // He allows it on the Mac, then comes back to the phone: re-read.
    const again = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  });
</script>

<div class="hs" data-home-sources>
  {#if missing}
    <p class="hs-note">This Mac's Nightloom does not list these yet.</p>
  {:else if rows === null}
    <p class="hs-note">{problem ?? "Reading…"}</p>
  {:else}
    <p class="hs-note">{sourcesSummary(rows)}</p>
    {#if problem}<p class="hs-note hs-bad">{problem}</p>{/if}
    {#each rows as r (r.id)}
      {@const look = macLook(r.id)}
      <!-- Item 873: each app's own mark and tint, as on the Mac's Watch (sourceLook.ts). -->
      <div class="hs-row" class:off={!isRead(r)} style:--tint={look.tint}>
        <span class="hs-ico" aria-hidden="true"><Icon name={look.icon} size={17} /></span>
        <div class="hs-main">
          <div class="hs-top">
            <span class="hs-name">{r.name}</span>
            <span class="hs-dot" class:ok={isRead(r)} class:warn={r.status === "denied" || r.status === "write_only"}></span>
            <span class="hs-tag">{isRead(r) || r.status !== "allowed" ? sourceStatusWords(r.status) : "Off"}</span>
          </div>
          <div class="hs-why">{r.why}</div>
          {#if said[r.id]}<div class="hs-why hs-said">{said[r.id]}</div>{/if}
          {#if canAsk(r)}
            <button class="hs-ask" disabled={busy !== null} onclick={() => void ask(r.id)}>{busy === r.id ? "Asking…" : "Ask on the Mac"}</button>
          {/if}
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .hs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 0 10px;
    color: var(--ink);
  }
  .hs-note {
    margin: 0 0 6px;
    font-size: 13px;
    color: var(--dim);
  }
  .hs-bad {
    color: var(--accent);
  }
  .hs-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 9px 0;
    border-top: 1px solid var(--line);
    min-width: 0;
  }
  /* Item 873: the app's mark in its tint on a low-alpha fill of it; Classic keeps the tint on the mark alone. */
  .hs-ico {
    flex: none;
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    color: var(--tint);
    background: color-mix(in srgb, var(--tint) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--tint) 40%, transparent);
  }
  /* The phone page does not load app.css's `.ns-ico`: the line icon's stroke, here. */
  .hs-ico :global(svg) {
    stroke: currentColor;
    fill: none;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  :global([data-layout="classic"]) .hs-ico {
    background: var(--well, var(--raised));
    border-color: var(--line);
  }
  .off .hs-ico {
    opacity: 0.6;
  }
  .hs-dot {
    flex: none;
    align-self: center;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--line2, var(--line));
  }
  .hs-dot.ok {
    background: var(--done, var(--ink));
    box-shadow: 0 0 6px color-mix(in srgb, var(--done, var(--ink)) 60%, transparent);
  }
  :global([data-layout="classic"]) .hs-dot.ok {
    box-shadow: none;
  }
  .hs-dot.warn {
    background: var(--accent);
  }
  .hs-main {
    flex: 1 1 auto;
    min-width: 0;
  }
  .hs-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hs-name {
    flex: 1 1 auto;
    font-size: 15px;
  }
  .off .hs-name {
    color: var(--dim);
  }
  .hs-tag {
    flex: none;
    font-size: 12px;
    color: var(--dim);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 8px;
    white-space: nowrap;
  }
  .hs-why {
    font-size: 13px;
    color: var(--dim);
    overflow-wrap: anywhere;
    margin-top: 2px;
  }
  .hs-said {
    color: var(--ink);
  }
  .hs-ask {
    margin-top: 8px;
    min-height: 36px;
    padding: 0 14px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--raised, var(--well));
    color: var(--ink);
    font: inherit;
    font-size: 14px;
  }
  .hs-ask:disabled {
    opacity: 0.6;
  }
</style>
