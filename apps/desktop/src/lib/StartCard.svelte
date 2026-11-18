<script lang="ts">
  /**
   * A Start card (nightshift item 763, H5): Home wants to start a chat that may write, or to write into a
   * big cold chat. It shows where the work goes, whether that chat may write, and the prompt — editable,
   * his edit kept as a draft — and nothing begins until he taps. Dismiss asks once more, since it drops
   * the prompt. One component for the Mac (Home's chat, the Needs-you view) and the phone's Home.
   */
  import { fitToText } from "./boxGrow";
  import { routeChoices, routeWhere, routeWhy, type HomeRoute, type RoutePick } from "./homeRoutes";

  interface Props {
    route: HomeRoute;
    /** What the box shows: his draft, else Home's words. */
    text: string;
    busy?: boolean;
    /** Why the last tap did not start it. */
    problem?: string | null;
    phone?: boolean;
    ontext: (text: string | null) => void;
    onstart: (pick: RoutePick | null) => void;
    ondismiss: () => void;
  }
  let { route, text, busy = false, problem = null, phone = false, ontext, onstart, ondismiss }: Props = $props();

  const edited = $derived(text !== route.prompt);
  const choices = $derived(routeChoices(route));
  let sure = $state(false);
  let box = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    void text;
    if (box) fitToText(box);
  });
</script>

<div class="start-card" class:phone data-start-card={route.id} data-hold={route.hold}>
  <div class="sc-top">
    <span class="sc-kind">{route.hold === "cold" ? "Cold chat" : "Start"}</span>
    <span class="sc-where">{routeWhere(route)}</span>
    <span class="sc-may" class:write={route.write}>{route.write ? "may write" : "read-only"}</span>
  </div>
  <p class="sc-why">{route.note ? `${routeWhy(route)} · ${route.note}` : routeWhy(route)}</p>
  <textarea
    bind:this={box}
    class="sc-prompt"
    aria-label="The prompt Home wrote — edit it before you start"
    rows="2"
    value={text}
    disabled={busy}
    oninput={(e) => ontext(e.currentTarget.value === route.prompt ? null : e.currentTarget.value)}
  ></textarea>
  {#if problem}<p class="sc-problem">{problem}</p>{/if}
  <div class="sc-acts">
    {#each choices as c, i (c.label)}
      <button class="sc-btn" class:primary={i === 0} disabled={busy || !text.trim()} onclick={() => onstart(c.pick)}>{c.label}</button>
    {/each}
    {#if edited}<button class="sc-btn quiet" disabled={busy} onclick={() => ontext(null)}>Home's wording</button>{/if}
    <span class="sc-gap"></span>
    {#if sure}
      <button class="sc-btn danger" disabled={busy} onclick={ondismiss}>Dismiss — nothing starts</button>
      <button class="sc-btn quiet" onclick={() => (sure = false)}>Keep</button>
    {:else}
      <button class="sc-btn quiet" disabled={busy} onclick={() => (sure = true)}>Dismiss</button>
    {/if}
  </div>
</div>

<style>
  .start-card {
    margin: 8px 0;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--accent-ink) 45%, var(--line2));
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent-ink) 5%, var(--paper, transparent));
    font-family: var(--sans);
    min-width: 0;
  }
  .sc-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .sc-kind {
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent-ink);
  }
  .sc-where {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 500;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .sc-may {
    font-family: var(--mono);
    font-size: 10.5px;
    padding: 1px 6px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    color: var(--dim);
    white-space: nowrap;
  }
  .sc-may.write {
    color: var(--warn, #b26a00);
    border-color: color-mix(in srgb, var(--warn, #b26a00) 50%, transparent);
  }
  .sc-why {
    margin: 4px 0 8px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--dim);
  }
  .sc-prompt {
    display: block;
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    max-height: 40vh;
    padding: 8px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--paper, transparent);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.45;
    resize: vertical;
  }
  .phone .sc-prompt {
    font-size: 16px;
  }
  .sc-problem {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--bad, #b3261e);
  }
  .sc-acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .sc-gap {
    flex: 1;
  }
  .sc-btn {
    padding: 5px 11px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: transparent;
    color: var(--ink);
    font-family: var(--sans);
    font-size: 12.5px;
    cursor: pointer;
  }
  .phone .sc-btn {
    min-height: 40px;
    font-size: 14px;
  }
  .sc-btn.primary {
    border-color: var(--accent-ink);
    background: var(--accent-ink);
    color: var(--paper, #fff);
  }
  .sc-btn.quiet {
    border-color: transparent;
    color: var(--dim);
  }
  .sc-btn.danger {
    border-color: var(--bad, #b3261e);
    color: var(--bad, #b3261e);
  }
  .sc-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
