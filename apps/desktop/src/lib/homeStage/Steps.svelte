<script lang="ts">
  // Home's steps (item 845; 809 round 5 point 3): the Home chat's tool calls in plain words on a rail, each opening
  // for detail. It follows the newest step like the chat — stuck to the bottom until he scrolls up, then it stays
  // put and offers "↓ new steps". Kind A throughout: nothing here calls the model.
  import { untrack } from "svelte";
  import Icon from "../Icon.svelte";
  import type { IconName } from "../icons";
  import { isScanMessage } from "../home";
  import Btn from "./Btn.svelte";
  import Detail from "./Detail.svelte";
  import { bag } from "./stageState.svelte";
  import { stageHost } from "./host";
  import { stepsOf } from "./steps";

  let { id }: { id: string } = $props();
  // svelte-ignore state_referenced_locally
  const ui = bag(`steps:${id}`, { open: {} as Record<string, boolean> });
  const rows = $derived(stepsOf(stageHost.now.events(), 3, isScanMessage));
  const working = $derived(stageHost.now.busy());

  let box = $state<HTMLElement | null>(null);
  let stick = $state(true);
  let fresh = $state(0);
  let count = -1;
  $effect(() => {
    const n = rows.length;
    if (!box) return;
    if (count < 0) count = n;
    if (n < count) (stick = true), (fresh = 0);
    if (stick) box.scrollTop = box.scrollHeight;
    else if (n > count) fresh = untrack(() => fresh) + n - count;
    count = n;
  });
  function toggle(key: string, last: boolean) {
    ui.open[key] = !ui.open[key];
    if (ui.open[key] && !last) stick = false;
  }
  function onscroll() {
    if (!box) return;
    stick = box.scrollHeight - box.scrollTop - box.clientHeight < 28;
    if (stick) fresh = 0;
  }
  function jump() {
    stick = true;
    fresh = 0;
    box?.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  }
</script>

<div class="sp">
  <!-- Item 771: once a day, the chats he has not gone back to, above the rail's own steps (the Mac's host only). -->
  {#if stageHost.now.LeftBehind}{@const LB = stageHost.now.LeftBehind}<LB />{/if}
  <div class="sp-list" bind:this={box} {onscroll}>
    {#each rows as r, ri (r.key)}
      {@const open = !!ui.open[r.key]}
      <div class="sp-row {r.kind === 'you' ? 'say' : r.kind}" class:you={r.kind === "you"} class:isopen={open}>
        <i class="sp-node"><Icon name={r.icon as IconName} size={8} /></i>
        <button class="sp-head" aria-expanded={open} onclick={() => toggle(r.key, ri === rows.length - 1)}>
          <span class="sp-title">{r.title}</span>
          <span class="h9-chev self">▸</span>
        </button>
        {#if r.out && !open}<span class="sp-out">{r.out}</span>{/if}
        {#if open}<Detail rows={r.detail} />{/if}
      </div>
    {/each}
    {#if working}
      <div class="sp-row do live">
        <i class="sp-node"><Icon name="play" size={8} /></i>
        <span class="sp-head h9-brk home"><i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i><span class="sp-title h9-caret">Working</span><span class="sp-ms">now</span></span>
      </div>
    {/if}
    {#if rows.length === 0 && !working}<p class="h9-dim" style="margin:8px 4px;font-size:12px">Nothing yet — Home's steps land here as it works.</p>{/if}
  </div>
  {#if !stick && fresh > 0}<span class="sp-new"><Btn kind="home" small onclick={jump}>↓ {fresh} new step{fresh === 1 ? "" : "s"}</Btn></span>{/if}
  <div class="sp-foot"><span>{rows.filter((r) => r.kind !== "you").length} steps</span><span style="flex:1"></span><span>{stick ? "following the newest" : "paused where you are reading"}</span></div>
</div>
