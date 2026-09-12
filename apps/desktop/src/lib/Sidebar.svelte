<script lang="ts">
  import {
    app,
    addProject,
    addToast,
    closeNightshift,
    deleteSession,
    enableNightshift,
    newSession,
    openSession,
    refreshNightshift,
    refreshSessions,
    selectNightshiftProject,
    showNightshift,
  } from "./state.svelte";
  import * as api from "./api";
  import type { NightshiftInfo, NightshiftRow, SessionHit } from "./types";
  import { relativeTime } from "./time";
  import { sameMorning } from "./nightshift";
  import NotesPanel from "./NotesPanel.svelte";
  import ProjectMenu from "./ProjectMenu.svelte";
  import Icon from "./Icon.svelte";
  import DisableDialog from "./DisableDialog.svelte";

  // Two-click delete: the first click arms the button, the second deletes.
  let confirming = $state<string | null>(null);
  let menu = $state(false);

  function onDelete(id: string) {
    if (confirming !== id) {
      confirming = id;
      return;
    }
    confirming = null;
    void deleteSession(id);
  }

  // Inline rename. A name is generated once, from the first exchange, so a
  // long chat that has moved on keeps describing where it started; renaming
  // it automatically would mean guessing when a conversation has drifted,
  // which the user can see and the app cannot.
  let renaming = $state<string | null>(null);
  let draft = $state("");

  function startRename(id: string, current: string) {
    renaming = id;
    draft = current;
  }

  async function commitRename(id: string) {
    const name = draft.trim();
    renaming = null;
    // Unchanged or emptied is a cancel, not a rename: an empty name would
    // leave the row labelled by its opening message with no way back.
    if (!name) return;
    try {
      await api.renameSession(id, name);
      await refreshSessions();
    } catch (e) {
      addToast(String(e));
    }
  }

  // The search box. `query` is what is typed and `hits` is what came back;
  // an empty query means "not searching" rather than "everything matched",
  // so the list falls back to `app.sessions` on its own.
  let query = $state("");
  let hits = $state<SessionHit[] | null>(null);
  let searching = $state(false);

  // Debounced, because every keystroke would otherwise re-read every log in
  // the directory. `seq` is what makes a slow early request unable to
  // overwrite a fast later one — the results would be for a query nobody is
  // looking at any more.
  let seq = 0;
  $effect(() => {
    // Read so switching projects re-runs the search: `search_sessions` looks
    // in whichever log directory is open, and results from the folder you
    // just left would be rows that no longer list.
    void app.project?.id;
    const q = query.trim();
    if (!q) {
      hits = null;
      searching = false;
      return;
    }
    searching = true;
    const mine = ++seq;
    const timer = setTimeout(() => {
      void api
        .searchSessions(q)
        .then((found) => {
          if (mine !== seq) return;
          hits = found;
        })
        .catch(() => {
          if (mine === seq) hits = [];
        })
        .finally(() => {
          if (mine === seq) searching = false;
        });
    }, 180);
    return () => clearTimeout(timer);
  });

  /**
   * The path, shortened from the left. A project root is usually deep and the
   * distinguishing part is the tail — `…/dev/Nightloom` identifies it where
   * `C:\Users\someone\code\…` does not.
   */
  function shortPath(path: string): string {
    return path.length <= 34 ? path : `…${path.slice(-33)}`;
  }

  /**
   * Open blockers summed across every enabled project, not just the one
   * open — the badge is a signal to go look, and a blocker on a project
   * that is not the current one is exactly the kind of thing a per-project
   * count would hide.
   */
  const nightshiftBlockers = $derived(
    app.nightshift.rows.reduce(
      (sum, r) => sum + (r.nightshift?.open_blockers ?? 0),
      0,
    ),
  );
  /** A morning page this window has not opened, on any enabled project. */
  const nightshiftNewPage = $derived(
    app.nightshift.rows.some((r) => {
      const newest = r.nightshift?.newest_morning;
      if (!newest) return false;
      return !(app.nightshift.read[r.id] ?? []).some((n) => sameMorning(n, newest));
    }),
  );

  // The three modes. Chats and Notes leave the Nightshift screens if they
  // were showing; Nightshift opens them.
  function goChats() {
    if (app.view === "nightshift") closeNightshift();
    app.leftTab = "chats";
  }
  function goNotes() {
    if (app.view === "nightshift") app.view = "chat";
    app.leftTab = "notes";
  }

  // ---- Nightshift mode: the project list and the Enable form (screen 3.1),
  // moved here from the surface so the list lives where lists live.

  /** Projects Nightshift detection accepted — the list's top section. */
  const enabledRows = $derived(
    app.nightshift.rows.filter(
      (r): r is NightshiftRow & { nightshift: NightshiftInfo } =>
        r.nightshift !== null,
    ),
  );
  /** Everything else — candidates for **Enable Nightshift**. */
  const otherRows = $derived(
    app.nightshift.rows.filter((r) => r.nightshift === null),
  );

  /** The two conditions worth a dim warning under a row, joined into one line. */
  function rowHints(info: NightshiftInfo): string {
    const h: string[] = [];
    if (!info.git) h.push("no git repo");
    if (!info.runner_present) h.push(`no runner at ${info.runner}`);
    return h.join(" · ");
  }

  /** `38 items · 3 open · 2026-09-11` */
  function rowMeta(info: NightshiftInfo): string {
    const page = info.newest_morning
      ? info.newest_morning.replace(/\.md$/, "")
      : "no page yet";
    return `${info.items} items · ${info.open_blockers} open · ${page}`;
  }

  /**
   * The Enable form: which row it is open on and the runner path typed into
   * it. Prefilled with the one install a registered project shows (the
   * nightshift repo, when it is a project here); an empty path enables with
   * no `runner` key. Item 038 / blocker 024: one install, named by path.
   */
  let enabling = $state<string | null>(null);
  let runnerPath = $state("");

  function openEnable(id: string): void {
    enabling = id;
    runnerPath = app.nightshift.defaultRunner ?? "";
  }

  async function confirmEnable(): Promise<void> {
    const id = enabling;
    if (!id) return;
    enabling = null;
    await enableNightshift(id, runnerPath.trim() || undefined);
  }

  /**
   * Disable, behind the warning (item 037). The dialog is opened on a row;
   * confirming renames the config through the backend and re-reads the
   * list, which the project then leaves. If it was the selected project the
   * selection is dropped so the refresh picks another.
   */
  let disabling = $state<NightshiftRow | null>(null);
  let disableBusy = $state(false);

  async function confirmDisable(): Promise<void> {
    const row = disabling;
    if (!row) return;
    disableBusy = true;
    try {
      await api.nightshiftDisable(row.id);
    } catch (e) {
      addToast(String(e));
      disableBusy = false;
      return;
    }
    disableBusy = false;
    disabling = null;
    if (app.nightshift.selected === row.id) app.nightshift.selected = null;
    await refreshNightshift();
    addToast(`Nightshift disabled on ${row.name}; the files stay`);
  }
</script>

<aside class="sidebar">
  <div class="project">
    <button
      class="chip"
      class:unfiled={!app.project}
      aria-expanded={menu}
      onclick={() => (menu = !menu)}
      title={app.project?.root ??
        (app.project ? "No folder — notes and chats only" : "No project — chats are not tied to a folder")}
    >
      <span class="chip-main">
        <span class="chip-name">{app.project?.name ?? "No project"}</span>
        <span class="caret"><Icon name="chev" /></span>
      </span>
      <span class="chip-path">
        {#if !app.project}
          unfiled chats
        {:else if app.project.root}
          {shortPath(app.project.root)}
        {:else}
          no folder
        {/if}
      </span>
    </button>
    {#if menu}
      <!-- Click-away, not a modal: switching projects is a navigation, and a
           full-screen scrim for it would read as a decision. -->
      <button
        class="scrim"
        aria-label="Close project menu"
        onclick={() => (menu = false)}
      ></button>
      <ProjectMenu close={() => (menu = false)} />
    {/if}
  </div>

  <nav class="nav" aria-label="Mode">
    <button
      aria-current={app.leftTab === "chats" ? "page" : undefined}
      class:on={app.leftTab === "chats"}
      onclick={goChats}
    >
      <Icon name="chat" size={16} />
      <span>Chats</span>
      {#if app.sessions.length > 0}<span class="count">{app.sessions.length}</span>{/if}
    </button>
    <button
      aria-current={app.leftTab === "notes" ? "page" : undefined}
      class:on={app.leftTab === "notes"}
      onclick={goNotes}
    >
      <Icon name="note" size={16} />
      <span>Notes</span>
      {#if app.notes.length > 0}<span class="count">{app.notes.length}</span>{/if}
    </button>
    <button
      aria-current={app.leftTab === "nightshift" ? "page" : undefined}
      class:on={app.leftTab === "nightshift"}
      onclick={() => showNightshift()}
    >
      <Icon name="moon" size={16} />
      <span>Nightshift</span>
      <!-- Two signals, two pills: open blockers (amber, a count) and an
           unread morning page (blue). Glued into one they read as "3 new
           pages" (2026-09-11 review). -->
      {#if nightshiftBlockers > 0 || nightshiftNewPage}
        <span class="badges">
          {#if nightshiftBlockers > 0}<span class="badge" title="{nightshiftBlockers} open blocker(s)">{nightshiftBlockers} open</span>{/if}
          {#if nightshiftNewPage}<span class="badge page" title="An unread morning page">new page</span>{/if}
        </span>
      {/if}
    </button>
  </nav>

  {#if app.leftTab === "chats"}
    <button class="new-chat" onclick={() => void newSession()} disabled={app.busy}>
      New chat
    </button>
    {#if app.sessions.length > 0 || query}
      <input
        class="search"
        type="search"
        placeholder="Search chats"
        aria-label="Search chats"
        bind:value={query}
      />
    {/if}
    {#if hits !== null}
      <!-- Searching replaces the list rather than filtering it in place: the
           rows carry an excerpt and a hit count that the ordinary listing has
           nothing to put in. -->
      {#if hits.length === 0}
        <p class="hint">
          {searching ? "Searching…" : `Nothing mentions “${query.trim()}”.`}
        </p>
      {:else}
        <div class="session-list">
          {#each hits as s (s.id)}
            <div
              class="session-item"
              class:active={s.id === app.activeSessionId}
            >
              <button
                class="session-row"
                onclick={() => void openSession(s.id)}
                disabled={app.busy}
              >
                <span class="snippet"
                  >{s.title ?? s.first_user ?? "empty session"}</span
                >
                <span class="excerpt">{s.excerpt}</span>
                <span class="meta"
                  >{s.hits}
                  {s.hits === 1 ? "mention" : "mentions"} · {relativeTime(
                    s.modified,
                  )}</span
                >
              </button>
            </div>
          {/each}
        </div>
      {/if}
    {:else if app.sessions.length === 0}
      <p class="hint">
        No chats {app.project ? "in this project" : "yet"}.
        {#if !app.project}
          <br />Chats started without a project stay in the app's own folder —
          <button class="link" onclick={() => void addProject()}>
            open a folder
          </button>
          to share notes between them.
        {/if}
      </p>
    {:else}
      <div class="session-list">
        {#each app.sessions as s (s.id)}
          <div class="session-item" class:active={s.id === app.activeSessionId}>
            {#if renaming === s.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="rename"
                aria-label="Session name"
                bind:value={draft}
                autofocus
                onblur={() => void commitRename(s.id)}
                onkeydown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  else if (e.key === "Escape") renaming = null;
                }}
              />
            {:else}
              <button
                class="session-row"
                onclick={() => void openSession(s.id)}
                ondblclick={() =>
                  startRename(s.id, s.title ?? s.first_user ?? "")}
                disabled={app.busy}
              >
                <span class="snippet"
                  >{s.title ?? s.first_user ?? "empty session"}</span
                >
                <span class="meta"
                  >{s.id.slice(0, 8)} · {relativeTime(s.modified)}</span
                >
              </button>
              <button
                class="rename-btn"
                title="Rename session"
                aria-label="Rename session"
                onclick={() => startRename(s.id, s.title ?? s.first_user ?? "")}
              >
                ✎
              </button>
            {/if}
            <button
              class="delete"
              class:confirming={confirming === s.id}
              title={confirming === s.id
                ? "Click again to delete"
                : "Delete session"}
              aria-label="Delete session"
              onclick={() => onDelete(s.id)}
              onmouseleave={() => confirming === s.id && (confirming = null)}
              disabled={app.busy}
            >
              {confirming === s.id ? "sure?" : "×"}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {:else if app.leftTab === "notes"}
    <NotesPanel />
  {:else}
    <div class="ns-scroll">
      {#if app.nightshift.rows.length === 0}
        <p class="hint">No projects yet — open a folder as a project first.</p>
      {:else}
        <div class="ns-side-h">Projects with a contract</div>
        {#if enabledRows.length === 0}
          <p class="hint">No project has Nightshift enabled yet.</p>
        {:else}
          <div class="ns-list">
            {#each enabledRows as row (row.id)}
              <button
                class="ns-row"
                class:on={row.id === app.nightshift.selected && app.view === "nightshift"}
                onclick={() => { if (app.view !== "nightshift") showNightshift(); void selectNightshiftProject(row.id); }}
              >
                <span class="t ns-top">
                  <span class="ns-name">{row.name}</span>
                  {#if row.nightshift.live}
                    <span class="ns-pill live" title="A shift is running; editing is locked">live</span>
                  {/if}
                </span>
                <span class="m">{rowMeta(row.nightshift)}</span>
                <span
                  class="disable-link"
                  role="button"
                  tabindex="0"
                  title="Disable Nightshift on this project (behind a warning)"
                  onclick={(e) => { e.stopPropagation(); disabling = row; }}
                  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); disabling = row; } }}
                >Disable…</span>
                {#if row.nightshift.config_error}
                  <span class="row-error">{row.nightshift.config_error}</span>
                {/if}
                {#if rowHints(row.nightshift)}
                  <span class="row-hint">{rowHints(row.nightshift)}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}

        {#if otherRows.length > 0}
          <div class="ns-side-h">Other projects</div>
          <div class="ns-list">
            {#each otherRows as row (row.id)}
              <div class="other-row" class:enabling={enabling === row.id}>
                <span class="other-top">
                  <span class="ns-name">
                    {row.name}
                    {#if !row.exists}<span class="missing">folder missing</span>{/if}
                  </span>
                  {#if row.disabled}
                    <button
                      class="enable-link"
                      disabled={!row.exists}
                      title={!row.exists
                        ? "folder missing"
                        : `Restore the disabled Nightshift root at ${row.disabled}`}
                      onclick={() => void enableNightshift(row.id)}
                    >
                      Enable again
                    </button>
                  {:else if enabling !== row.id}
                    <button
                      class="enable-link"
                      disabled={!row.exists || row.workspace === null}
                      title={!row.exists
                        ? "folder missing"
                        : row.workspace === null
                          ? "This project has no folder"
                          : undefined}
                      onclick={() => openEnable(row.id)}
                    >
                      Enable…
                    </button>
                  {/if}
                </span>
                {#if row.disabled}
                  <span class="row-hint">disabled · {row.disabled}</span>
                {/if}
                {#if enabling === row.id}
                  <form
                    class="enable-form"
                    onsubmit={(e) => {
                      e.preventDefault();
                      void confirmEnable();
                    }}
                  >
                    <label class="enable-label" for="ns-runner-{row.id}">
                      Runner — the folder holding bin/nightshift.sh
                    </label>
                    <input
                      id="ns-runner-{row.id}"
                      class="ns-fld enable-input"
                      type="text"
                      bind:value={runnerPath}
                      placeholder="leave empty to set it later in nightshift.json"
                      spellcheck="false"
                    />
                    <span class="enable-actions">
                      <button class="ns-btn small" type="submit">Enable</button>
                      <button class="link" type="button" onclick={() => (enabling = null)}>Cancel</button>
                    </span>
                  </form>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if disabling}
    <DisableDialog
      row={disabling}
      busy={disableBusy}
      onconfirm={() => void confirmDisable()}
      onclose={() => (disabling = null)}
    />
  {/if}

  <div class="side-foot">
    <button class="foot-btn" onclick={() => (app.showSettings = true)}>
      <Icon name="gear" />
      <span>Settings</span>
      <span class="spacer"></span>
      <span class="kbd">⌘,</span>
    </button>
  </div>

</aside>

<style>
  .sidebar {
    position: relative;
    background: var(--paper);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    font-family: var(--sans);
  }
  /* The project block is the same 82px as the Nightshift top bar, with the
     name centred, so the sidebar's name and the page title share one
     baseline and one rule across the window (mock-up revision 2d). */
  .project {
    position: relative;
    height: 82px;
    flex: none;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .chip {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    background: transparent;
    border: none;
    padding: 0 18px;
    cursor: pointer;
    color: var(--ink);
    text-align: left;
    font-family: inherit;
  }
  .chip:hover .chip-name {
    color: var(--accent-ink);
  }
  .chip.unfiled {
    background: transparent;
  }
  .chip-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .chip-name {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.01em;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .caret {
    color: var(--dim);
    flex-shrink: 0;
    display: inline-flex;
  }
  .chip-path {
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--dim);
    margin-top: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    direction: ltr;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 35;
    background: transparent;
    border: none;
    cursor: default;
  }
  /* The three modes, as rows. */
  .nav {
    padding: 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: none;
  }
  .nav button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--ink2);
    font-size: 14px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }
  .nav button:hover {
    background: var(--well);
  }
  .nav button.on {
    background: var(--sheet);
    color: var(--ink);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .count {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .badges {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }
  .badge {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--paper);
    background: var(--accent);
    border-radius: 999px;
    padding: 1px 7px;
    font-weight: 500;
    white-space: nowrap;
  }
  .badge.page {
    color: var(--paper);
    background: var(--live);
  }

  /* Nightshift mode: the project list. */
  .ns-scroll {
    overflow-y: auto;
    min-height: 0;
    flex: 1;
    padding-bottom: 10px;
  }
  .ns-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .ns-name {
    font-size: 13.5px;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-error {
    font-size: 11.5px;
    color: var(--failed);
  }
  /* Shown on hover only: a destructive-looking link on every row would read
     as an invitation. */
  .disable-link {
    font-size: 11px;
    color: var(--dim);
    align-self: flex-end;
    opacity: 0;
    transition: opacity 0.12s;
    cursor: pointer;
  }
  .ns-row:hover .disable-link,
  .disable-link:focus-visible {
    opacity: 1;
  }
  .disable-link:hover {
    color: var(--failed);
    text-decoration: underline;
  }
  .row-hint {
    font-size: 11.5px;
    color: var(--dim);
    opacity: 0.85;
  }
  .missing {
    color: var(--failed);
    font-size: 11px;
    margin-left: 0.35rem;
  }
  .other-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 6px;
  }
  .other-row.enabling {
    background: var(--sheet);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .other-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .enable-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 11.5px;
    color: var(--accent);
    cursor: pointer;
    flex-shrink: 0;
  }
  .enable-link:hover:not(:disabled) {
    color: var(--accent-ink);
    text-decoration: underline;
  }
  .enable-link:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .enable-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .enable-label {
    font-size: 11px;
    color: var(--dim);
  }
  .enable-input {
    font-size: 12px;
    padding: 5px 8px;
  }
  .enable-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .side-foot {
    margin-top: auto;
    border-top: 1px solid var(--line);
    flex: none;
  }
  .foot-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 18px;
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 12.5px;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
  }
  .foot-btn:hover {
    color: var(--ink);
  }
  .spacer {
    flex: 1;
  }
  .kbd {
    font-family: var(--mono);
    font-size: 11px;
  }
  .new-chat {
    margin: 0 0.75rem 0.6rem;
    padding: 0.45rem 0.75rem;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.85rem;
    font-family: inherit;
    text-align: left;
  }
  .new-chat:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .new-chat:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hint {
    margin: 0;
    padding: 0 0.75rem;
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--dim);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
  .session-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .session-item {
    display: flex;
    align-items: stretch;
    border-radius: 8px;
  }
  .session-item:hover {
    background: var(--well);
  }
  .session-item.active {
    background: var(--sheet);
    box-shadow: 0 0 0 1px var(--line2);
  }
  .session-row {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    cursor: pointer;
    color: var(--text);
  }
  .session-row:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .delete {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 0.85rem;
    padding: 0 0.5rem;
    cursor: pointer;
    border-radius: 8px;
    flex-shrink: 0;
    visibility: hidden;
  }
  .session-item:hover .delete {
    visibility: visible;
  }
  .delete:hover,
  .delete.confirming {
    color: var(--error);
  }
  .delete.confirming {
    font-size: 0.72rem;
  }
  .delete:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .snippet {
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 0.72rem;
    color: var(--dim);
    font-family: var(--mono);
  }

  .search {
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 0.4rem;
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.78rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  .search:focus {
    outline: none;
    border-color: var(--accent);
  }

  .search::placeholder {
    color: var(--dim);
  }

  /* Why the session matched. Wraps to two lines and stops: it is evidence,
     not the message. */
  .excerpt {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--dim);
  }

  .rename {
    flex: 1;
    min-width: 0;
    padding: 0.35rem 0.45rem;
    font: inherit;
    font-size: 0.8rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 4px;
  }

  .rename:focus {
    outline: none;
  }

  .rename-btn {
    padding: 0 0.3rem;
    font-size: 0.75rem;
    color: var(--dim);
    background: none;
    border: none;
    cursor: pointer;
    opacity: 0;
  }

  .session-item:hover .rename-btn,
  .rename-btn:focus-visible {
    opacity: 1;
  }

  .rename-btn:hover {
    color: var(--text);
  }
</style>
