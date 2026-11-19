<script module lang="ts">
  export interface HudSelectRow {
    id: string;
    label: string;
    detail?: string;
    /** A short mono note at the row's right (a time, "current"). */
    right?: string;
    on?: boolean;
    /** An action, not a value (New thread…): drawn with a +, never checked. */
    action?: boolean;
  }
</script>

<script lang="ts">
  /**
   * Item 705 (his "that thread dropdown is ugly asf"): a themed select for the
   * hand-off card — a well button with a mono kicker, the value and a chevron,
   * and the app's shared HUD menu under it (`hudMenu.ts`, placed by
   * `floatMenu` so a scrolling column never cuts it). Option A, Console:
   * the thread and the next chat's model use it. Classic draws it plainly
   * (no glass, its own radius), as every Classic menu is.
   */
  import { hudIn, hudOut } from "./hudMenu";
  import { floatMenu } from "./floatMenu";
  import { tip } from "./tip";


  let {
    kicker,
    value,
    note = "",
    head,
    rows,
    disabled = false,
    hint = "",
    label,
    onpick,
  }: {
    kicker: string;
    value: string;
    note?: string;
    head: string;
    rows: HudSelectRow[];
    disabled?: boolean;
    hint?: string;
    label: string;
    onpick: (id: string) => void;
  } = $props();

  let open = $state(false);
  let btn = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLElement | null>(null);

  function toggle(): void {
    if (disabled) return;
    open = !open;
    if (open) queueMicrotask(() => menuEl?.querySelector<HTMLElement>('[aria-checked="true"], [role^="menuitem"]')?.focus());
  }

  function pick(r: HudSelectRow): void {
    open = false;
    onpick(r.id);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      open = false;
      btn?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuEl?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
    next?.focus();
  }

  $effect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuEl?.contains(t) || btn?.contains(t)) return;
      open = false;
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  });

  $effect(() => {
    if (disabled) open = false;
  });
</script>

<button
  type="button"
  class="hsel"
  class:open
  bind:this={btn}
  {disabled}
  aria-haspopup="menu"
  aria-expanded={open}
  aria-label={label}
  use:tip={hint}
  onclick={toggle}
>
  <span class="hsel-k">{kicker}</span>
  <span class="hsel-v">{value}</span>
  {#if note}<span class="hsel-note">{note}</span>{/if}
  <span class="hsel-chev" aria-hidden="true">▾</span>
</button>
{#if open}
  <div
    class="hsel-menu hud-m"
    role="menu"
    tabindex="-1"
    aria-label={head}
    bind:this={menuEl}
    use:floatMenu={{ anchor: btn }}
    in:hudIn|global={{ anchor: btn }}
    out:hudOut|global
    onkeydown={onKey}
  >
    <div class="hud-head hsel-head">{head}</div>
    {#each rows as r (r.id + (r.action ? ":act" : ""))}
      {#if r.action}<div class="hud-rule hsel-rule"></div>{/if}
      <button
        type="button"
        class="hsel-row"
        class:hud-cur={r.on}
        role={r.action ? "menuitem" : "menuitemradio"}
        aria-checked={r.action ? undefined : (r.on ?? false)}
        tabindex="-1"
        onclick={() => pick(r)}
      >
        <span class="hsel-mark" aria-hidden="true">{r.action ? "+" : r.on ? "✓" : ""}</span>
        <span class="hsel-label">{r.label}</span>
        {#if r.right}<span class="hsel-right">{r.right}</span>{/if}
        {#if r.detail}<span class="hsel-detail">{r.detail}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .hsel {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    max-width: 100%;
    min-width: 0;
    padding: 0 8px 0 10px;
    border: 1px solid var(--line2);
    color: var(--ink);
    font: inherit;
    font-size: 12.5px;
    white-space: nowrap;
    cursor: pointer;
  }
  .hsel:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .hsel-k {
    font: 500 10px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .hsel-v {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .hsel-note {
    font: 11px var(--mono);
    color: var(--dim);
  }
  .hsel-chev {
    color: var(--dim);
    font-size: 10px;
  }
  .hsel-menu {
    min-width: 260px;
    max-width: 380px;
    overflow-y: auto;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border: 1px solid var(--line2);
    font-family: var(--sans);
  }
  .hsel-head {
    padding: 4px 6px 6px;
  }
  .hsel-row {
    display: grid;
    grid-template-columns: 14px 1fr auto;
    gap: 2px 8px;
    align-items: center;
    padding: 6px 8px;
    border: none;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .hsel-mark {
    color: var(--accent-ink, var(--accent));
    font-size: 11px;
  }
  .hsel-right {
    font: 10.5px var(--mono);
    color: var(--dim);
  }
  .hsel-detail {
    grid-column: 2 / 4;
    font-size: 11.5px;
    color: var(--dim);
  }
  .hsel-rule {
    height: 1px;
    margin: 4px 2px;
  }
  /* Jarvis (item 705, option A): the well button and the glass menu. */
  :global(:where(:root:not([data-layout="classic"]))) .hsel {
    border-radius: var(--r1);
    background: var(--well);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  :global(:where(:root:not([data-layout="classic"]))) .hsel.open {
    border-color: color-mix(in srgb, var(--accent) 70%, var(--line2));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .hsel-menu {
    border-radius: var(--r2);
    background: color-mix(in srgb, var(--raised) 97%, var(--term));
  }
  /* Classic (a backup): plain, the sheet and its 6 px corners. */
  :global(:where([data-layout="classic"])) .hsel {
    border-radius: 6px;
    background: var(--paper);
  }
  :global(:where([data-layout="classic"])) .hsel-menu {
    border-radius: 8px;
    background: var(--sheet);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  :global(:where([data-layout="classic"])) .hsel-row:hover,
  :global(:where([data-layout="classic"])) .hsel-row:focus-visible {
    background: var(--paper);
    outline: none;
  }
</style>
