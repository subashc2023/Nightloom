<script lang="ts">
  /**
   * The Projects list (item 300, row A4; blocker 1090's default, the Claude
   * app's shape `inferred`): full screen over the chat, opened from the
   * drawer's Projects row. Each project's name, chat count and last
   * activity, most recently used first; New project at the top; a search
   * that filters by name. Tapping one opens its page (`ProjectPage`).
   */
  import { shortWhen } from "./client";
  import { chatCount, type ProjectSummary } from "./recents";

  interface Props {
    projects: ProjectSummary[];
    /** The host can make a project (feature `projects`). */
    canNew: boolean;
    onopen: (id: string) => void;
    onnew: () => void;
    onclose: () => void;
  }
  let { projects, canNew, onopen, onnew, onclose }: Props = $props();

  let query = $state("");
  const shown = $derived(projects.filter((p) => !query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase())));
</script>

<div class="pj" role="dialog" aria-modal="true" aria-label="Projects">
  <header class="pj-top">
    <button class="pj-btn" onclick={onclose} aria-label="Close">Done</button>
    <span class="pj-name">Projects</span>
    <span class="pj-btn" aria-hidden="true"></span>
  </header>
  <div class="pj-body">
    <label class="pj-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>
      <input type="search" placeholder="Search projects" bind:value={query} autocomplete="off" />
    </label>
    {#if canNew}
      <button class="pj-new" onclick={onnew}>
        <span class="pj-plus" aria-hidden="true">+</span>
        New project
      </button>
    {/if}
    {#each shown as p (p.id)}
      <button class="pj-row" onclick={() => onopen(p.id)}>
        <span class="pj-row-name">{p.name}</span>
        <span class="pj-row-meta">
          {p.chats === null ? "…" : chatCount(p.chats)}{p.last ? ` · ${shortWhen(p.last)}` : ""}
        </span>
      </button>
    {:else}
      <p class="pj-empty">{query.trim() ? "No project matches." : "No projects yet."}</p>
    {/each}
  </div>
</div>

<style>
  .pj {
    position: fixed;
    inset: 0;
    z-index: 20;
    background: var(--paper);
    display: flex;
    flex-direction: column;
    -webkit-user-select: none;
    user-select: none;
  }
  .pj-top {
    display: flex;
    align-items: center;
    gap: 8px;
    /* The header paints the status bar's strip itself (no grey band, A38). */
    padding: calc(8px + env(safe-area-inset-top, 0px)) 12px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--sheet);
    flex: none;
  }
  .pj-name {
    flex: 1;
    text-align: center;
    font-weight: 600;
    font-size: 17px;
  }
  .pj-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    min-width: 56px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    color: var(--accent-ink);
    box-sizing: border-box;
  }
  .pj-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 12px 12px calc(24px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pj-search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 4px 8px;
    padding: 0 12px;
    border-radius: 12px;
    background: var(--well);
    color: var(--dim);
  }
  .pj-search svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    flex: none;
  }
  .pj-search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    padding: 10px 0;
    font: inherit;
    color: var(--ink);
    -webkit-user-select: text;
    user-select: text;
  }
  .pj-search input::-webkit-search-cancel-button {
    -webkit-appearance: none;
    appearance: none;
  }
  .pj-new,
  .pj-row {
    all: unset;
    cursor: pointer;
    display: flex;
    box-sizing: border-box;
    width: 100%;
    border-radius: 12px;
    padding: 8px 12px;
  }
  .pj-new {
    align-items: center;
    gap: 12px;
    min-height: 48px;
    color: var(--accent-ink);
    font-weight: 500;
  }
  .pj-plus {
    font-size: 22px;
    line-height: 1;
    width: 22px;
    text-align: center;
  }
  .pj-row {
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-height: 60px;
  }
  .pj-new:active,
  .pj-row:active {
    background: var(--well);
  }
  .pj-row-name {
    font-size: 16px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pj-row-meta {
    font-size: 13px;
    color: var(--dim);
  }
  .pj-empty {
    color: var(--dim);
    font-size: 14px;
    padding: 12px;
    margin: 0;
  }
</style>
