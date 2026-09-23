<script module lang="ts">
  /** The query and scope the kept answer is for, so reopening the panel
   *  shows the last results and selection rather than searching again. */
  let answered = "";
</script>

<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { addToast, app, openSession, showNote, useProject } from "./state.svelte";
  import * as api from "./api";
  import Icon from "./Icon.svelte";
  import { relativeTime } from "./time";
  import { SEARCH_CHORD_LABEL } from "./find";
  import { foldToFit } from "./fold";
  import { growForSearch, shrinkAfterSearch } from "./search.svelte";
  import {
    countLine,
    emptyLine,
    escapeClosesPanel,
    findBar,
    flatten,
    groupKey,
    matchesSuffix,
    SCOPES,
    stepRow,
    whoLabel,
    type FlatRow,
  } from "./search";
  import type { ChatGroup, SearchScope } from "./types";

  /**
   * Search everywhere (nightshift backlog 117, with 106's second half;
   * boards 11a–11c). Takes the sidebar's column, widened to 380, in place
   * of its nav, list and foot: the field, the scope — *this project · all
   * chats · notes* — the count line, the results grouped by chat (or by
   * note) with the passage, who said it and when, and the keys along the
   * foot. ↑↓ moves the selection and the chat behind follows — opened at
   * the message, every match marked by ⌘F's bar, which the panel hands
   * the query to. ↵ commits: the panel closes, the sidebar returns with
   * the query in its box and a `14 ▸` to reopen, the bar stays so ⌘G
   * steps on. esc closes and leaves the chat where it is — from anywhere
   * while the panel is open, not only from its field (backlog 138: after
   * a click on a row or a fold the next esc reached the window, where
   * macOS leaves full screen), except from another text field, whose own
   * esc it is; and the × at the head closes it by mouse. The column grows
   * a little on open and comes back on close, eased (`search.svelte.ts`).
   *
   * The query, scope, answer and selection live in `app.search` so a
   * preview that switches the project (a chat from another project
   * under *all chats*, blocker 154) does not lose them.
   */

  let field = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLDivElement | null>(null);
  let searching = $state(false);
  let folded = $state<Record<string, boolean>>({});
  let seq = 0;

  // The scope row folds by measurement (backlog 183): ~~an `@container
  // (max-width: 330px)` rule~~, which WebKit under page zoom queries at
  // the width × the zoom, so it tightened a zoom step late. Level 1 is
  // the tighter labels; `data-fold` mirrors what `foldToFit` wrote so the
  // attribute is dynamic markup and Svelte keeps the rule.
  //
  // The key line along the foot folds the same way (measured 2026-09-23:
  // at 100 % it needs a 365 px column and was cut off below that, the
  // chord and "esc close" first): level 1 drops "in the chat", level 2
  // the chord at the right as well.
  const SCOPE_FOLD_MAX = 1;
  const FOOT_FOLD_MAX = 2;
  let scopeRow = $state<HTMLDivElement | null>(null);
  let footRow = $state<HTMLDivElement | null>(null);
  let scopeFold = $state("0");
  let footFold = $state("0");
  function refold(): void {
    const row = scopeRow;
    if (row) scopeFold = String(foldToFit(row, () => [...row.querySelectorAll(".search-scope button")], SCOPE_FOLD_MAX));
    const foot = footRow;
    if (foot) footFold = String(foldToFit(foot, () => [...foot.children], FOOT_FOLD_MAX));
  }
  $effect(() => {
    const row = scopeRow;
    const foot = footRow;
    if (!row || !foot || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => refold());
    ro.observe(row);
    ro.observe(foot);
    return () => ro.disconnect();
  });

  const rows = $derived(flatten(app.search.result));
  const count = $derived(app.search.result ? countLine(app.search.result, app.search.scope) : null);

  /** The answer keyed by what it answers, for `answered` above. */
  function key(q: string, scope: SearchScope): string {
    return `${scope}\n${q}`;
  }

  // Debounced, as the sidebar's box was: every keystroke would otherwise
  // read every log in the scope. `seq` keeps a slow early answer from
  // landing over a fast later one. The kept answer is not re-fetched on
  // reopening — the boards want the last results and selection back.
  $effect(() => {
    const q = app.search.query.trim();
    const scope = app.search.scope;
    if (!q) {
      app.search.result = null;
      app.search.selected = 0;
      answered = "";
      searching = false;
      seq++;
      return;
    }
    if (app.search.result && answered === key(q, scope)) return;
    searching = true;
    const mine = ++seq;
    const timer = setTimeout(() => {
      void api
        .searchEverywhere(q, scope)
        .then((r) => {
          if (mine !== seq) return;
          app.search.result = r;
          app.search.selected = 0;
          answered = key(q, scope);
          folded = {};
        })
        .catch((e) => {
          if (mine !== seq) return;
          app.search.result = null;
          addToast(String(e));
        })
        .finally(() => {
          if (mine === seq) searching = false;
        });
    }, 180);
    return () => clearTimeout(timer);
  });

  onMount(() => {
    field?.focus();
    field?.select();
    growForSearch(app.layout.sidebarWidth);
  });
  onDestroy(shrinkAfterSearch);

  /** esc from anywhere while the panel is open: closed here, never let
   *  through to the window (backlog 138). Another text field's esc is
   *  that field's; the panel's own field is handled in `fieldKeys`. */
  function windowKeys(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!escapeClosesPanel(e.target as { tagName?: string; isContentEditable?: boolean } | null, field)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function setScope(scope: SearchScope) {
    if (app.search.scope === scope) return;
    app.search.scope = scope;
  }

  function close() {
    app.search.open = false;
  }

  /** Whether the group's chat is filed somewhere other than the open
   *  project: under *all chats*, another project's, or unfiled while a
   *  project is open. */
  function elsewhere(g: ChatGroup): boolean {
    return app.search.scope === "all" && (g.project?.id ?? null) !== (app.project?.id ?? null);
  }

  /**
   * Show the row's chat (or note) behind the panel with the bar on its
   * match. The chat is opened only when it is not already the active one,
   * so stepping between two hits in one chat is a scroll, not a reload; a
   * chat filed elsewhere switches the project first (blocker 154).
   */
  async function preview(row: FlatRow) {
    const q = app.search.query.trim();
    if (row.kind === "chat") {
      if (elsewhere(row.group)) await useProject(row.group.project?.id ?? null);
      if (app.activeSessionId !== row.group.id || app.view !== "chat") await openSession(row.group.id);
      // The events are set; the transcript draws them on the flush. The
      // bar must not search the chat just left — its turns carry the same
      // numbers — so wait for the DOM before handing over.
      await tick();
      findBar()?.openWith(q, row.row.who === "name" ? undefined : row.row.index);
    } else {
      if (app.openNote?.scope !== row.group.scope || app.openNote?.name !== row.group.name)
        showNote(row.group.scope, row.group.name);
      await tick();
      findBar()?.openWith(q);
    }
  }

  async function select(i: number) {
    app.search.selected = i;
    const row = rows[i];
    if (!row) return;
    await tick();
    list?.querySelector<HTMLElement>(`[data-row="${i}"]`)?.scrollIntoView({ block: "nearest" });
    await preview(row);
  }

  /** ↵ or a click: preview and close; the bar keeps the query. */
  async function commit(i: number) {
    await select(i);
    close();
  }

  function fieldKeys(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      void select(stepRow(app.search.selected, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows.length > 0) void commit(Math.min(app.search.selected, rows.length - 1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  /** The chat's line under its title: `5eb30ca1 · 8 min ago`. */
  function groupMeta(g: ChatGroup): string {
    return `${g.id.slice(0, 8)} · ${relativeTime(g.modified)}`;
  }

  function toggleFold(k: string) {
    folded[k] = !folded[k];
  }

  /** The flat index of a chat row, for the selection and the anchor. */
  function flatIndex(kind: "chat" | "note", groupKeyOf: string, rowKey: number): number {
    return rows.findIndex(
      (r) =>
        r.kind === kind &&
        groupKey(r.group) === groupKeyOf &&
        (r.kind === "chat" ? r.row.index : r.row.line) === rowKey,
    );
  }
</script>

<svelte:window onkeydown={windowKeys} />

<div class="search-panel" role="search" aria-label="Search everywhere">
  <div class="search-head">
    <div class="search-field-wrap">
      <Icon name="search" size={14} />
      <input
        class="search-field"
        bind:this={field}
        bind:value={app.search.query}
        onkeydown={fieldKeys}
        placeholder="Search chats"
        aria-label="Search everywhere"
        autocomplete="off"
        spellcheck="false"
      />
      {#if app.search.query}
        <button class="search-clear" title="Clear" aria-label="Clear the search" onclick={() => { app.search.query = ""; field?.focus(); }}>
          <Icon name="x" size={12} />
        </button>
      {/if}
    </div>
    <!-- The way out by mouse (backlog 138): the sidebar comes back, the
         query stays in its box. -->
    <button class="search-close" title="Close search (esc)" aria-label="Close search" onclick={close}>
      <Icon name="x" size={14} />
    </button>
  </div>

  <!-- The scope. His note on board 11a: a little wider and bigger than
       drawn — 13px and 5px 14px against the board's 12px and 3px 10px. -->
  <div class="search-scope-row" bind:this={scopeRow} data-fold={scopeFold}>
    <div class="search-scope" role="radiogroup" aria-label="Where to search">
      {#each SCOPES as s (s.scope)}
        <button
          role="radio"
          aria-checked={app.search.scope === s.scope}
          class:on={app.search.scope === s.scope}
          onclick={() => setScope(s.scope)}
        >{s.label}</button>
      {/each}
    </div>
  </div>

  {#if searching}
    <div class="search-count">searching…</div>
    <div class="search-res" aria-busy="true">
      {#each [0, 1, 2] as i (i)}
        <div class="search-hit skel"><span class="who"></span><span class="pass"></span><span class="when"></span></div>
      {/each}
    </div>
  {:else if !app.search.result}
    <p class="search-empty">
      {app.search.scope === "this"
        ? "Every chat in this project is searched as you type."
        : app.search.scope === "all"
          ? "Every chat in every project, and the unfiled ones, is searched as you type."
          : "The project's notes and the vault are searched as you type."}
    </p>
  {:else if app.search.result.chats === 0}
    <p class="search-empty">
      {emptyLine(app.search.query.trim(), app.search.scope)}
      {#if app.search.scope === "this"}
        <button class="search-link" onclick={() => setScope("all")}>search all chats instead →</button>
      {/if}
    </p>
  {:else}
    {#if count}
      <div class="search-count">
        <span class="text">{count.text}</span>
        <span class="spacer"></span>
        {#if count.narrow}<span class="narrow">narrow it</span>{/if}
        <span>{count.elapsed}</span>
      </div>
    {/if}
    <div class="search-res" bind:this={list}>
      {#each app.search.result.groups as g (g.id)}
        {@const k = groupKey(g)}
        <div class="search-grp">
          <div class="search-gh">
            <button class="chev" class:closed={folded[k]} title={folded[k] ? "Unfold" : "Fold"} aria-expanded={!folded[k]} onclick={() => toggleFold(k)}>
              <Icon name="chev" size={11} />
            </button>
            <span class="gt">{g.title ?? g.first_user ?? "empty session"}</span>
            {#if elsewhere(g)}<span class="proj">{g.project?.name ?? "unfiled"}</span>{/if}
            <span class="gm">{groupMeta(g)}</span>
            <span class="gn">{g.hits}</span>
          </div>
          {#if !folded[k]}
            {#each g.rows as r (r.index)}
              {@const i = flatIndex("chat", k, r.index)}
              <button
                class="search-hit"
                class:on={i === app.search.selected}
                data-row={i}
                onclick={() => void commit(i)}
              >
                <span class="who" class:you={r.who === "you"}>{whoLabel(r.who)}</span>
                <span class="pass">{r.before}<mark class="search-mark">{r.matched}</mark>{r.after}</span>
                <span class="when">{relativeTime(r.at)}{matchesSuffix(r.matches)}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/each}
      {#each app.search.result.notes as g (groupKey(g))}
        {@const k = groupKey(g)}
        <div class="search-grp">
          <div class="search-gh">
            <button class="chev" class:closed={folded[k]} title={folded[k] ? "Unfold" : "Fold"} aria-expanded={!folded[k]} onclick={() => toggleFold(k)}>
              <Icon name="chev" size={11} />
            </button>
            <span class="gt">{g.name}</span>
            <span class="proj">{g.scope === "knowledge" ? "vault" : "project"}</span>
            <span class="gm">{relativeTime(g.modified)}</span>
            <span class="gn">{g.hits}</span>
          </div>
          {#if !folded[k]}
            {#each g.rows as r (r.line)}
              {@const i = flatIndex("note", k, r.line)}
              <button
                class="search-hit"
                class:on={i === app.search.selected}
                data-row={i}
                onclick={() => void commit(i)}
              >
                <span class="who">line {r.line}</span>
                <span class="pass">{r.before}<mark class="search-mark">{r.matched}</mark>{r.after}</span>
                <span class="when">{matchesSuffix(r.matches).replace(/^ · /, "")}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="search-foot" bind:this={footRow} data-fold={footFold}>
    <span><span class="k">↑↓</span> preview</span>
    <span><span class="k">↵</span> open</span>
    <span><span class="k">⌘G</span> next<span class="fold1"> in the chat</span></span>
    <span><span class="k">esc</span> close</span>
    <span class="k right">{SEARCH_CHORD_LABEL}</span>
  </div>
</div>

<style>
  .search-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    font-family: var(--sans);
    /* The scope row is sized to the column (backlog 138): the panel no
       longer forces 380px, so in a narrow column the three labels tighten
       — ~~under ~330px, by a container query~~ by measurement since
       2026-09-23 (backlog 183, `refoldScope`). */
  }
  .search-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px 0;
  }
  /* The field, in the `ns-fld` shape with the glass and the × inside it. */
  .search-field-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 7px 10px;
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 6px;
    color: var(--dim);
  }
  .search-field-wrap:focus-within {
    border-color: var(--accent);
  }
  .search-field {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 13.5px;
    color: var(--ink);
    outline: none;
  }
  .search-field::placeholder {
    color: var(--dim);
  }
  .search-clear {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: none;
    padding: 0;
    color: var(--dim);
    cursor: pointer;
  }
  .search-clear:hover {
    color: var(--ink);
  }
  .search-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 28px;
    height: 32px;
    background: transparent;
    border: none;
    border-radius: 6px;
    padding: 0;
    color: var(--dim);
    cursor: pointer;
  }
  .search-close:hover {
    color: var(--ink);
    background: var(--well);
  }
  /* The row the fold measures: its padding is the scope's old margin, so
     `foldToFit` reads the right edge the buttons must stay inside. */
  .search-scope-row {
    padding: 10px 14px 0;
    min-width: 0;
    overflow: hidden;
  }
  .search-scope {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    width: fit-content;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .search-scope button {
    padding: 5px 14px;
    border: none;
    border-radius: 6px;
    background: transparent;
    font: inherit;
    font-size: 13px;
    color: var(--dim);
    white-space: nowrap;
    cursor: pointer;
  }
  .search-scope button:hover {
    color: var(--ink2);
  }
  .search-scope button.on {
    background: var(--sheet);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  /* After the base rule, so the narrow case wins the cascade. */
  .search-scope-row[data-fold="1"] .search-scope button {
    padding: 5px 9px;
    font-size: 12.5px;
  }
  .search-count {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 4px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  /* One line at any width (measured 2026-09-23: at a 300 px column the
     count wrapped, "0.2 s" broken over two lines): the sentence gives
     way with an ellipsis, the time and "narrow it" keep their width. */
  .search-count {
    white-space: nowrap;
  }
  .search-count .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .search-count > span:not(.text, .spacer) {
    flex: none;
  }
  .search-count .spacer {
    flex: 1;
  }
  .search-count .narrow {
    color: var(--partial);
  }
  .search-res {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .search-grp {
    display: flex;
    flex-direction: column;
  }
  .search-gh {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 4px;
    font-size: 13px;
    color: var(--ink);
    min-width: 0;
  }
  .search-gh .chev {
    display: inline-flex;
    background: transparent;
    border: none;
    padding: 0;
    color: var(--dim);
    cursor: pointer;
  }
  .search-gh .chev.closed :global(svg) {
    transform: rotate(-90deg);
  }
  .search-gh .gt {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .search-gh .gm {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    white-space: nowrap;
  }
  .search-gh .gn {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink2);
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 0 6px;
  }
  .search-gh .proj {
    font-size: 10px;
    color: var(--dim);
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 0 6px;
    white-space: nowrap;
  }
  .search-hit {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 2px 8px;
    padding: 6px 8px 7px;
    margin-left: 14px;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 6px;
    background: transparent;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  .search-hit:hover {
    background: var(--well);
  }
  .search-hit.on {
    background: var(--sheet);
    border-left-color: var(--accent);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .search-hit .who {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    padding-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .search-hit .who.you {
    color: var(--ink2);
  }
  .search-hit .pass {
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--ink2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .search-hit.on .pass {
    color: var(--ink);
  }
  .search-hit .pass mark {
    background: var(--accent-soft);
    color: var(--ink);
    border-radius: 2px;
    padding: 0 1px;
  }
  .search-hit.on .pass mark {
    background: var(--accent);
    color: var(--paper);
  }
  .search-hit .when {
    grid-column: 2;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--dim);
  }
  .search-hit.skel {
    cursor: default;
  }
  .search-hit.skel .pass {
    background: var(--well);
    border-radius: 3px;
    height: 34px;
  }
  .search-empty {
    margin: 0;
    padding: 18px 14px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--dim);
  }
  .search-link {
    display: block;
    margin-top: 6px;
    padding: 0;
    background: none;
    border: none;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .search-link:hover {
    color: var(--accent-ink);
    text-decoration: underline;
  }
  .search-foot {
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    border-top: 1px solid var(--line);
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    white-space: nowrap;
    flex: none;
  }
  .search-foot .k {
    color: var(--ink2);
  }
  .search-foot .right {
    margin-left: auto;
  }
  .search-foot:is([data-fold="1"], [data-fold="2"]) .fold1 {
    display: none;
  }
  .search-foot[data-fold="2"] .right {
    display: none;
  }
</style>
