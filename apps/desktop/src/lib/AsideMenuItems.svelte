<script lang="ts">
  /**
   * A chat's asides in its row menu (item 265, his "being able to list all
   * of the asides not only in the icon in the top right, but also in the
   * chat menu"): the open ones — a click shows the thread in a tab — then
   * the past ones — a click opens the chat and reopens the thread as a
   * card under its passage, as the asides list does. Drawn nothing when the
   * chat has neither. Each list is capped; the rest are in the chat's
   * asides list (the pill at its top-right).
   */
  import { openSession } from "./state.svelte";
  import Icon from "./Icon.svelte";
  import { asideLabel } from "./asides";
  import { asideTick } from "./asides.svelte";
  import { pastOf, reopenPast } from "./asideHistory.svelte";
  import { asidesListedOf, openAsideTab } from "./asideSidebar.svelte";

  let { session, onpick }: { session: string; onpick: () => void } = $props();

  const SHOWN = 8;
  const open = $derived(asidesListedOf(session));
  const past = $derived.by(() => {
    void asideTick.n;
    return [...pastOf(session)].reverse();
  });

  async function reopen(key: string) {
    onpick();
    await openSession(session);
    reopenPast(key);
  }
</script>

{#if open.length > 0 || past.length > 0}
  <div class="row-sep"></div>
  {#if open.length > 0}
    <div class="sec">Asides ({open.length})</div>
    {#each open.slice(-SHOWN).reverse() as a (a.id)}
      <button
        role="menuitem"
        onclick={() => {
          onpick();
          void openAsideTab(session, a.id);
        }}><span class="lbl"><Icon name="think" size={11} /> {asideLabel(a, 44)}</span></button
      >
    {/each}
    {#if open.length > SHOWN}<div class="more">{open.length - SHOWN} more in the chat's asides list</div>{/if}
  {/if}
  {#if past.length > 0}
    <div class="sec">Past asides ({past.length})</div>
    {#each past.slice(0, SHOWN) as p (p.key)}
      <button role="menuitem" class="past" onclick={() => void reopen(p.key)}
        ><span class="lbl">{asideLabel(p.thread, 44)}</span><span class="row-key">reopen</span></button
      >
    {/each}
    {#if past.length > SHOWN}<div class="more">{past.length - SHOWN} more in the chat's asides list</div>{/if}
  {/if}
{/if}

<style>
  /* Inside the sidebar's `.row-menu`; its buttons' look is repeated here
     because that style is the sidebar's own. */
  button {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--ink2);
    font: inherit;
    font-size: 12.5px;
    padding: 6px 10px;
    cursor: pointer;
    max-width: 320px;
  }
  button:hover {
    background: var(--well);
    color: var(--ink);
  }
  button.past {
    color: var(--dim);
  }
  .lbl {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .row-key {
    flex-shrink: 0;
    color: var(--dim);
    font-size: 11.5px;
  }
  .row-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--line);
  }
  .sec,
  .more {
    padding: 4px 10px 2px;
    font-size: 10.5px;
    color: var(--dim);
    font-family: var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .more {
    text-transform: none;
    letter-spacing: 0;
  }
</style>
