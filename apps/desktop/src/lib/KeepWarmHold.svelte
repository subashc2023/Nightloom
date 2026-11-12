<script lang="ts">
  /*
   * The keep-warm switch's "hold longer" menu (nightshift item 643, his
   * "is there a way i can jus like click hold for logner"): opened by a
   * right-click or a held press on the composer's ♨ switch. Three rows —
   * the default cap (6 h), 12 h and 24 h — each with what it costs beyond
   * the default in the 5-hour window, and the cost per extra hour at the
   * foot. The pick is kept with the chat by the backend (`keep-warm-hold.json`)
   * and runs out after a whole hold with no reply.
   */
  import { onDestroy, onMount } from "svelte";
  import { floatMenu } from "./floatMenu";
  import { hudIn, hudOut } from "./hudMenu";
  import { holdRows, perHourWords, type KeepWarmStatus } from "./keepWarm";

  let {
    anchor,
    status,
    onpick,
    onclose,
  }: {
    anchor: HTMLElement;
    status: KeepWarmStatus | null;
    onpick: (hours: number) => void;
    onclose: () => void;
  } = $props();

  const rows = $derived(holdRows(status));
  let menu: HTMLDivElement | null = $state(null);

  const outside = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && (menu?.contains(t) || anchor.contains(t))) return;
    onclose();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    }
  };
  onMount(() => {
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    menu?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });
  onDestroy(() => {
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key, true);
  });
</script>

<div
  class="kw-hold hud-m"
  role="menu"
  tabindex="-1"
  aria-label="Keep this chat warm for"
  bind:this={menu}
  use:floatMenu={{ anchor }}
  in:hudIn|global={{ anchor }}
  out:hudOut|global
>
  <div class="kw-hold-head hud-head">Keep this chat warm for</div>
  {#each rows as r (r.hours)}
    <button
      type="button"
      class="kw-hold-row"
      class:on={r.on}
      role="menuitemradio"
      aria-checked={r.on}
      tabindex="-1"
      onclick={() => onpick(r.hours)}
    >
      <span class="kw-hold-label">{r.label}</span>
      <span class="kw-hold-detail">{r.detail}</span>
    </button>
  {/each}
  <div class="kw-hold-foot">{perHourWords(status)}. Runs out after a whole hold with no reply; then back to the default.</div>
</div>

<style>
  .kw-hold {
    position: fixed;
    z-index: 80;
    width: 300px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-family: var(--sans);
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
  }
  .kw-hold-head {
    padding: 5px 8px 3px;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    white-space: nowrap;
  }
  .kw-hold-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    font: 12.5px var(--sans);
    color: var(--ink);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .kw-hold-row:hover,
  .kw-hold-row:focus-visible {
    background: var(--well);
    outline: none;
  }
  .kw-hold-row.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .kw-hold-label {
    flex: none;
  }
  .kw-hold-detail {
    margin-left: auto;
    font-size: 11px;
    color: var(--dim);
  }
  .kw-hold-foot {
    margin: 4px 2px 0;
    padding: 6px 6px 2px;
    border-top: 1px solid var(--line);
    font-size: 11px;
    line-height: 1.4;
    color: var(--dim);
    white-space: normal;
  }
  /* Filament IV: the raised card and its type (the HUD glass is hudMenu.css's). */
  :global(:where(:root:not([data-layout="classic"]))) .kw-hold {
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.6);
  }
  :global(:where(:root:not([data-layout="classic"]))) .kw-hold-head {
    padding: 6px 8px;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .kw-hold-row {
    border-radius: var(--r1);
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .kw-hold-row:hover,
  :global(:where(:root:not([data-layout="classic"]))) .kw-hold-row:focus-visible {
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .kw-hold-row.on {
    background: var(--well2);
    color: var(--ink);
    font-weight: 500;
  }
  :global(:where(:root:not([data-layout="classic"]))) .kw-hold-detail {
    font-family: var(--mono);
    font-size: 10.5px;
  }
</style>
