<script lang="ts">
  /**
   * Files for you (nightshift backlog 377): a folder button in the top bar,
   * beside the bell, with a dot when the model has marked something for him
   * since he last opened the list. The list is the open project's (the
   * unfiled chats' when none is open), newest first: a file opens in a
   * Nightloom tab, a folder in the Finder, and every row has a Finder
   * button. Opening the list marks everything in it seen. The card is the
   * bell's: portalled, fixed by the button's rectangle, click-away and
   * Escape close it.
   */
  import { tip } from "./tip";
  import Icon from "./Icon.svelte";
  import { app } from "./state.svelte";
  import { portal, anchorBelow } from "./portal";
  import { relativeTime } from "./time";
  import { baseName } from "./forYou";
  import { forYou, forYouUnseen, markForYouSeen, openForYou, refreshForYou, revealForYou, startForYou } from "./forYou.svelte";

  let open = $state(false);
  let btnEl = $state<HTMLElement | null>(null);
  let panelEl = $state<HTMLElement | null>(null);
  let pos = $state({ top: 0, left: 0, width: 420 });

  const unseen = $derived(forYouUnseen());

  $effect(() => {
    startForYou();
  });
  // A project switch re-reads at once rather than on the next tick.
  $effect(() => {
    void app.project?.id;
    void refreshForYou();
  });

  function place(): void {
    if (!btnEl) return;
    const r = btnEl.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 40);
    pos = { ...anchorBelow({ left: r.left, right: r.right, bottom: r.bottom }, width, window.innerWidth, 6), width };
  }

  async function toggle(): Promise<void> {
    open = !open;
    if (open) {
      place();
      await refreshForYou(true);
      markForYouSeen();
    }
  }

  $effect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelEl?.contains(t) || btnEl?.contains(t)) return;
      open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
    };
  });
</script>

<span class="fy-wrap">
  <button
    class="ns-btn ghost small fy-btn"
    bind:this={btnEl}
    use:tip={unseen > 0 ? `Files for you: ${unseen} new` : "Files for you — what the model made for you"}
    aria-label={unseen > 0 ? `Files for you, ${unseen} new` : "Files for you"}
    aria-expanded={open}
    onclick={() => void toggle()}
  >
    <Icon name="folder" size={14} />{#if unseen > 0}<span class="fy-dot" aria-hidden="true"></span>{/if}
  </button>

  {#if open}
    <div class="fy-panel" bind:this={panelEl} use:portal style="top: {pos.top}px; left: {pos.left}px; width: {pos.width}px">
      <div class="fy-head">
        <span class="fy-title">Files for you</span>
        <span class="fy-where">{app.project ? `in ${app.project.name}` : "unfiled chats"}</span>
        <span class="spacer"></span>
        <button class="ns-btn ghost small" use:tip={"Close"} aria-label="Close" onclick={() => (open = false)}>×</button>
      </div>
      <div class="fy-body">
        {#if forYou.rows.length === 0}
          <p class="fy-empty">Nothing yet. When the model makes a file or folder for you, it lists it here.</p>
        {/if}
        {#each forYou.rows as r (r.path)}
          <div class="fy-row">
            <button
              class="fy-open"
              use:tip={r.folder ? `Open the folder in the Finder\n${r.path}` : `Open in a tab\n${r.path}`}
              onclick={() => {
                open = false;
                void openForYou(r);
              }}
            >
              <span class="fy-glyph" aria-hidden="true"><Icon name={r.folder ? "folder" : "note"} size={13} /></span>
              <span class="fy-text">
                <span class="fy-name">{r.title ?? baseName(r.path)}</span>
                <span class="fy-line mono">{r.rel} · {relativeTime(r.at)}</span>
              </span>
            </button>
            {#if !r.folder}
              <button class="ns-btn ghost small" use:tip={"Show it in the Finder"} onclick={() => void revealForYou(r.path)}>Finder</button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</span>

<style>
  .fy-wrap {
    position: relative;
    display: inline-flex;
    flex: none;
  }
  .fy-btn {
    position: relative;
    padding: 3px 8px;
    display: inline-flex;
    align-items: center;
  }
  .fy-dot {
    position: absolute;
    top: 2px;
    right: 3px;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--accent);
  }
  .fy-panel {
    position: fixed;
    max-height: min(560px, calc(100vh - var(--titlebar-h) - 100px));
    display: flex;
    flex-direction: column;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    /* The top bar's cards' level, as the bell's. */
    z-index: 80;
    font-family: var(--sans);
    font-size: 13px;
    text-align: left;
    white-space: normal;
  }
  .fy-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .fy-title {
    font-weight: 600;
  }
  .fy-where {
    color: var(--dim);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .fy-body {
    overflow-y: auto;
    min-height: 0;
    padding: 4px 6px 8px;
  }
  .fy-empty {
    color: var(--dim);
    margin: 12px 6px;
  }
  .fy-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .fy-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
  }
  .fy-open:hover {
    background: var(--well);
  }
  .fy-glyph {
    color: var(--dim);
    padding-top: 2px;
  }
  .fy-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .fy-name {
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fy-line {
    color: var(--dim);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
