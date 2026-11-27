<script lang="ts">
  import CacheDot from "./CacheDot.svelte"; // Item 1022: the cache dot before a chat's name
  /*
   * Item 913 (his ask, 2026-11-23: a screen "to look at all of the open … cache
   * things that are … saving my cache so that i can easily … extend or stop any
   * of them from that screen directly"). Settings → Claude Code → Keeping caches
   * warm → Chats kept warm now: every chat whose cache the pings keep warm right
   * now (the backend's whole list, `keep_warm_list`, then its `keep-warm` events),
   * soonest to go cold first; Extend holds it longer (the ♨ switch's hold menu,
   * 12 h then 24 h), Stop ends the run now (the chat's switch stays as set).
   */
  import { onMount } from "svelte";
  import * as api from "./api";
  import { app } from "./state.svelte";
  import { holdKeepWarm, keepWarm, loadAllKeepWarm, stopKeeper } from "./keepWarm.svelte";
  import { keeperLine, keeperRows, nextHold } from "./keepWarm";
  import { tip } from "./tip";

  let now = $state(Date.now());
  let busy = $state<string | null>(null);
  let note = $state<string | null>(null);
  // A chat outside the open project has no title here: its project's name, read once.
  let homes = $state<Record<string, string>>({});

  onMount(() => {
    void loadAllKeepWarm();
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const rows = $derived(keeperRows(keepWarm.byChat, now));

  $effect(() => {
    for (const s of rows) {
      if (titleOf(s.chat) || s.chat in homes) continue;
      homes[s.chat] = "";
      void api
        .chatHome(s.chat)
        .then((h) => (homes[s.chat] = h.found ? `a chat in ${h.name ?? "no project"}` : "a chat"))
        .catch(() => (homes[s.chat] = "a chat"));
    }
  });

  function titleOf(chat: string): string | null {
    return app.sessions.find((s) => s.id === chat)?.title ?? null;
  }

  async function extend(chat: string, hours: number): Promise<void> {
    busy = chat;
    note = await holdKeepWarm(chat, hours);
    busy = null;
  }
  async function stop(chat: string): Promise<void> {
    busy = chat;
    note = null;
    await stopKeeper(chat);
    busy = null;
  }
</script>

<div class="keepers" aria-label="Chats kept warm now">
  {#if rows.length === 0}
    <p class="empty">
      No chat's cache is being kept warm right now. A chat shows here from its reply until its cache would go cold,
      unless you stop it; the ♨ switch under its message box turns it on or off.
    </p>
  {:else}
    <ul>
      {#each rows as s (s.chat)}
        {@const next = nextHold(s)}
        <li>
          <div class="who">
            <span class="name"><CacheDot session={s.chat} />{titleOf(s.chat) ?? (homes[s.chat] || "a chat")}</span>
            <span class="line" use:tip={keeperLine(s, now)}>{keeperLine(s, now)}</span>
          </div>
          <div class="acts">
            <button
              class="ns-btn small"
              disabled={busy === s.chat || next === null}
              use:tip={next === null ? `Held ${s.hold_hours} h, the longest` : `Keep warm up to ${next} h after its last reply${s.sleep_cut ? ", through your sleep" : ""}`}
              onclick={() => next !== null && void extend(s.chat, next)}>{next === null ? `Held ${s.hold_hours} h` : `Extend to ${next} h`}</button
            >
            <button
              class="ns-btn small danger"
              disabled={busy === s.chat}
              use:tip={"Stop the pings until its next message\nThe chat's switch stays as it is"}
              onclick={() => void stop(s.chat)}>Stop</button
            >
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  {#if note}<p class="empty err" role="status">{note}</p>{/if}
</div>

<style>
  .keepers {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px 7px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--well);
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .name,
  .line {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .name {
    font-size: 13px;
    color: var(--ink);
  }
  .line {
    font: 11px var(--mono);
    color: var(--dim);
  }
  .acts {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .empty {
    margin: 0;
    color: var(--dim);
    font-size: 12px;
    line-height: 1.45;
  }
  .empty.err {
    color: var(--failed);
  }
  :global(:where(:root:not([data-layout="classic"]))) li {
    border-radius: var(--r1);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .empty {
    font-size: 12.5px;
  }
</style>
