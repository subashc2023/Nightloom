<script lang="ts">
  /**
   * One project's page (item 300, row A4; blocker 1090's default, the
   * Claude app's project page `inferred`): its name and ⋯ (Rename, Forget),
   * its instructions, a New chat that starts a chat in it, and its chats
   * newest first. Full screen over the chat, above the Projects list.
   *
   * A rename being typed is kept as a draft (practices §7): leaving the
   * page keeps it, only Save or a confirmed Discard drops it.
   */
  import { untrack } from "svelte";
  import { loadDraft, saveDraft, shortWhen, type ChatRow } from "./client";
  import { lastActive } from "./recents";

  interface Props {
    id: string;
    name: string;
    /** Its chats, or null while they are read. */
    chats: ChatRow[] | null;
    /** The chat on screen, when it is one of this project's. */
    here: string | null;
    /** Opens its instructions (AGENTS.md) in Notes; null when this host
     *  cannot reach them from here (an older host: notes are only its open
     *  project's; 300 B1 lifted that for one that takes `?project=`). */
    instructions: (() => void) | null;
    /** Rename and forget; null when the host cannot. Each answers a
     *  sentence when it failed. */
    onrename: ((name: string) => Promise<string | null>) | null;
    onforget: (() => Promise<string | null>) | null;
    onchat: (id: string) => void;
    onnew: () => void;
    onback: () => void;
  }
  let { id, name, chats, here, instructions, onrename, onforget, onchat, onnew, onback }: Props = $props();

  const renameKey = $derived(`projectrename:${id}`);
  let menu = $state(false);
  // The page is keyed by project: its id does not change under it.
  const kept = loadDraft(`projectrename:${untrack(() => id)}`);
  let renaming = $state(kept !== "");
  let renameText = $state(kept);
  let confirmForget = $state(false);
  let confirmDiscard = $state(false);
  let busy = $state(false);
  let problem = $state<string | null>(null);

  const sorted = $derived(chats ? [...chats].sort((a, b) => Date.parse(lastActive(b)) - Date.parse(lastActive(a))) : null);

  function startRename() {
    menu = false;
    renaming = true;
    if (!renameText) renameText = name;
  }

  function typed() {
    saveDraft(renameKey, renameText === name ? "" : renameText);
  }

  async function saveRename() {
    const next = renameText.trim();
    if (!onrename || !next || busy) return;
    busy = true;
    problem = await onrename(next);
    busy = false;
    if (problem === null) {
      saveDraft(renameKey, "");
      renaming = false;
      renameText = "";
    }
  }

  function discardRename() {
    if (renameText.trim() && renameText !== name && !confirmDiscard) {
      confirmDiscard = true;
      return;
    }
    saveDraft(renameKey, "");
    renaming = false;
    renameText = "";
    confirmDiscard = false;
    problem = null;
  }

  async function forget() {
    if (!onforget || busy) return;
    busy = true;
    problem = await onforget();
    busy = false;
    confirmForget = false;
  }
</script>

<div class="pp" role="dialog" aria-modal="true" aria-label={name}>
  <header class="pp-top">
    <button class="pp-btn" onclick={onback} aria-label="Back to projects">‹ Projects</button>
    <span class="pp-grow"></span>
    {#if onrename || onforget}
      <button class="pp-btn more" onclick={() => (menu = !menu)} aria-label="Project actions" aria-expanded={menu}>⋯</button>
    {/if}
  </header>
  {#if menu}
    <div class="pp-menu" role="menu">
      {#if onrename}<button role="menuitem" onclick={startRename}>Rename</button>{/if}
      {#if onforget}
        <button role="menuitem" class="danger" onclick={() => ((menu = false), (confirmForget = true))}>Forget…</button>
      {/if}
    </div>
  {/if}
  <div class="pp-body">
    {#if renaming}
      <div class="pp-rename">
        <input bind:value={renameText} oninput={typed} aria-label="Project name" autocomplete="off" />
        <div class="pp-actions">
          <button class="pp-pill" onclick={discardRename}>{confirmDiscard ? "Discard the new name?" : "Cancel"}</button>
          <button class="pp-pill accent" disabled={busy || !renameText.trim()} onclick={saveRename}>Save</button>
        </div>
      </div>
    {:else}
      <h1 class="pp-name">{name}</h1>
    {/if}
    {#if confirmForget}
      <div class="pp-confirm">
        <p>Forget “{name}”? It leaves the list; its folder and chats stay on disk.</p>
        <div class="pp-actions">
          <button class="pp-pill" onclick={() => (confirmForget = false)}>Keep</button>
          <button class="pp-pill danger" disabled={busy} onclick={forget}>Forget</button>
        </div>
      </div>
    {/if}
    {#if problem}<p class="pp-bad">{problem}</p>{/if}

    <button class="pp-new" onclick={onnew}>
      <span class="pp-plus" aria-hidden="true">+</span>
      New chat in this project
    </button>
    {#if instructions}
      <button class="pp-card" onclick={instructions}>
        <span class="pp-card-title">Instructions</span>
        <span class="pp-card-sub">AGENTS.md — every chat in this project reads it</span>
      </button>
    {:else}
      <div class="pp-card off">
        <span class="pp-card-title">Instructions</span>
        <span class="pp-card-sub">AGENTS.md — this host’s Nightloom reaches only its open project’s notes; update it to edit these here.</span>
      </div>
    {/if}

    <p class="pp-head">Chats</p>
    {#if sorted === null}
      <p class="pp-empty">Loading…</p>
    {:else}
      {#each sorted as c (c.id)}
        <button class="pp-row" class:here={c.id === here} onclick={() => onchat(c.id)}>
          <span class="pp-row-label">{c.label}</span>
          <span class="pp-row-meta">{shortWhen(lastActive(c))}{c.mode !== "normal" ? ` · ${c.mode}` : ""}</span>
        </button>
      {:else}
        <p class="pp-empty">No chats yet — start one above.</p>
      {/each}
    {/if}
  </div>
</div>

<style>
  .pp {
    position: fixed;
    inset: 0;
    z-index: 21;
    background: var(--paper);
    display: flex;
    flex-direction: column;
    -webkit-user-select: none;
    user-select: none;
  }
  .pp-top {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: calc(8px + env(safe-area-inset-top, 0px)) 8px 8px;
    border-bottom: 1px solid var(--line);
    /* The colour of Safari's strip above it (theme-color = --paper) and
       of the chat's header, so the top is one colour (300 B7). */
    background: var(--paper);
    flex: none;
  }
  .pp-grow {
    flex: 1;
  }
  .pp-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    min-width: 44px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    color: var(--accent-ink);
    box-sizing: border-box;
  }
  .pp-btn.more {
    font-size: 22px;
  }
  .pp-menu {
    position: absolute;
    right: 12px;
    top: calc(56px + env(safe-area-inset-top, 0px));
    z-index: 2;
    background: var(--sheet);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    min-width: 180px;
    overflow: hidden;
  }
  .pp-menu button {
    all: unset;
    cursor: pointer;
    padding: 14px 16px;
    font-size: 16px;
  }
  .pp-menu button + button {
    border-top: 1px solid var(--line);
  }
  .pp-menu button:active {
    background: var(--well);
  }
  .danger {
    color: var(--failed);
  }
  .pp-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: 16px 12px calc(24px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .pp-name {
    font-size: 24px;
    font-weight: 650;
    margin: 0 4px 8px;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }
  .pp-rename,
  .pp-confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 4px 8px;
  }
  .pp-rename input {
    font: inherit;
    font-size: 18px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--line2, var(--line));
    background: var(--sheet);
    color: var(--ink);
    -webkit-user-select: text;
    user-select: text;
  }
  .pp-confirm p {
    margin: 0;
    font-size: 15px;
  }
  .pp-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .pp-pill {
    all: unset;
    cursor: pointer;
    padding: 9px 16px;
    border-radius: 999px;
    background: var(--well);
    font-size: 15px;
  }
  .pp-pill.accent {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 600;
  }
  .pp-pill.danger {
    background: var(--well);
    font-weight: 600;
  }
  .pp-pill:disabled {
    opacity: 0.5;
  }
  .pp-bad {
    color: var(--failed);
    font-size: 14px;
    margin: 0 4px;
  }
  .pp-new,
  .pp-card,
  .pp-row {
    all: unset;
    cursor: pointer;
    box-sizing: border-box;
    width: 100%;
    display: flex;
    border-radius: 12px;
  }
  .pp-new {
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 0 12px;
    color: var(--accent-ink);
    font-weight: 500;
  }
  .pp-plus {
    font-size: 22px;
    line-height: 1;
    width: 22px;
    text-align: center;
  }
  .pp-card {
    flex-direction: column;
    gap: 2px;
    padding: 12px 14px;
    background: var(--sheet);
    border: 1px solid var(--line);
  }
  .pp-card.off {
    cursor: default;
  }
  .pp-card-title {
    font-weight: 600;
    font-size: 15px;
  }
  .pp-card-sub {
    font-size: 13px;
    color: var(--dim);
  }
  .pp-head {
    margin: 14px 12px 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--dim);
  }
  .pp-row {
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    min-height: 52px;
    padding: 6px 12px;
  }
  .pp-row.here {
    background: var(--sheet);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .pp-new:active,
  .pp-card:not(.off):active,
  .pp-row:active {
    background: var(--well);
  }
  .pp-row-label {
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pp-row-meta {
    font-size: 12px;
    color: var(--dim);
  }
  .pp-empty {
    color: var(--dim);
    font-size: 14px;
    padding: 6px 12px;
    margin: 0;
  }
</style>
