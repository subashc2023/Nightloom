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
      <div class="hs-row" class:off={!isRead(r)}>
        <span class="hs-dot" class:ok={isRead(r)} class:warn={r.status === "denied" || r.status === "write_only"}></span>
        <div class="hs-main">
          <div class="hs-top">
            <span class="hs-name">{r.name}</span>
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
    gap: 10px;
    align-items: flex-start;
    padding: 9px 0;
    border-top: 1px solid var(--line);
    min-width: 0;
  }
  .hs-dot {
    flex: none;
    width: 8px;
    height: 8px;
    margin-top: 6px;
    border-radius: 50%;
    background: var(--line2, var(--line));
  }
  .hs-dot.ok {
    background: var(--done, var(--ink));
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
    align-items: baseline;
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
