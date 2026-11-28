<script module lang="ts">
  // One block on screen: with two views side by side (Split) only the first Steps rail draws it.
  let owner = $state<symbol | null>(null);
</script>

<script lang="ts">
  // "Left behind?" on Home's Steps rail (nightshift item 771, his pick B on blocker 2362): once a day, at most
  // three chats he has not gone back to, high first — a reply never opened (amber node), or opened and not read
  // to the end (violet ring). Open goes to the reply, or where he stopped; Left it settles the chat (10 s Undo,
  // here and in a toast); Not now holds it a week. Rows answered stay, dimmed, with the answer, until tomorrow.
  // The rail's own row look (stage.css `.sp-*`) and buttons (`.jb`), so Classic follows stage.css's overrides.
  import { onDestroy, onMount } from "svelte";
  import Btn from "./Btn.svelte";
  import { tip } from "../tip";
  import { chatName, doneLine, whyLine, type Row } from "../leftBehind";
  import { leftBehind, openLeft, refreshLeftBehind, rowsNow, settleLeft, snoozeLeft, undoSettle } from "../leftBehind.svelte";

  const me = Symbol("left-behind");
  if (owner === null) owner = me;
  onDestroy(() => {
    if (owner === me) owner = null;
  });
  onMount(() => void refreshLeftBehind());

  const rows = $derived(owner === me ? rowsNow() : []);
  const open = $derived(rows.filter((r) => !r.done).length);
  function ago(r: Row): string {
    return `${r.days}d`;
  }
  function rowTip(r: Row): string {
    const where = r.chat.project ? `In ${r.chat.project.name}` : "Not in a project";
    return r.level === "high" ? `A reply came ${r.days} day${r.days === 1 ? "" : "s"} ago and you haven't opened it\n${where}` : `You opened it after the reply but didn't reach the end\n${where}`;
  }
</script>

{#if rows.length > 0}
  <div class="lb" role="region" aria-label="Left behind?" data-left-behind>
    <div class="lb-cap"><span class="ns-cap lb-t">Left behind?</span><span class="h9-ph-sub">{open > 0 ? `${open} chat${open === 1 ? "" : "s"}` : "all answered"}</span></div>
    <div class="lb-list">
      {#each rows as r, i (r.chat.id)}
        {@const name = chatName(r.chat)}
        <div class="sp-row lb-row" class:hi={r.level === "high"} class:lo={r.level === "low"} class:done={!!r.done} data-left-row={r.chat.id} style="--i:{i}">
          <i class="sp-node lb-node" aria-hidden="true"></i>
          <div class="sp-head lb-head" use:tip={rowTip(r)}><span class="sp-title">{name}</span><span class="sp-ms">{ago(r)}</span></div>
          {#if r.done}
            <span class="sp-out lb-out">{doneLine(r.done)}{#if r.done === "settled" && (leftBehind.undo[r.chat.id] ?? 0) > Date.now()}<span class="lb-sep">{" · "}</span><button class="lb-undo" onclick={() => undoSettle(r.chat.id)}>Undo</button>{/if}</span>
          {:else}
            <span class="sp-why lb-why">{whyLine(r)}{#if r.chat.project}{` · ${r.chat.project.name}`}{/if}</span>
            <div class="lb-acts">
              <Btn kind="home" small tip={r.level === "high" ? "Open it at the reply" : "Open it where you stopped reading"} onclick={() => void openLeft(r)}>{r.level === "high" ? "Open" : "Open where I stopped"}</Btn>
              <Btn small tip={"Move it to Settled in the sidebar\nWrite in it and it comes back"} onclick={() => settleLeft(r.chat.id, name)}>Left it</Btn>
              <Btn small tip={"Not asked about again for 7 days"} onclick={() => snoozeLeft(r.chat.id)}>Not now</Btn>
            </div>
          {/if}
        </div>
      {/each}
    </div>
    <div class="sp-foot lb-foot"><span>{rows.length} of 3 today</span><span style="flex:1"></span><span>next: tomorrow</span></div>
  </div>
{/if}

<style>
  .lb { flex: none; border-bottom: 1px solid var(--line); }
  .lb-cap { display: flex; align-items: center; gap: 8px; padding: 9px 12px 5px; }
  .lb-t { flex: 1; }
  .lb-list { padding: 2px 10px 6px 12px; }
  .lb-row { animation-delay: calc(var(--i, 0) * 120ms); }
  .lb-head { cursor: default; }
  .lb-head:hover { background: none; }
  /* High: amber, filled — the chat's own "you" node. Low: a hollow violet ring. */
  .lb-node::after { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: var(--home); }
  .lb-row.hi .lb-node { border-color: var(--accent); }
  .lb-row.hi .lb-node::after { background: var(--accent); }
  .lb-row.lo .lb-node::after { background: none; }
  .lb-row.hi .lb-head { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .lb-row.done .lb-head { opacity: 0.55; background: none; border-color: transparent; }
  .lb-why { display: block; padding: 1px 6px 4px; font-size: 11.5px; color: var(--ink2); }
  .lb-acts { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 6px 6px; }
  .lb-out { color: var(--done); }
  .lb-sep { color: var(--dim); }
  .lb-undo { border: 0; padding: 0; background: none; font: inherit; color: var(--accent-ink); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .lb-undo:hover { color: var(--ink); }
  .lb-foot { border-top: 0; padding-top: 2px; }
</style>
