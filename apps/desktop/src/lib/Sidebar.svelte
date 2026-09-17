<script lang="ts">
  import {
    app,
    openProjectFolder,
    showNewProject,
    useProject,
    addToast,
    closeNightshift,
    deleteSession,
    enableNightshift,
    MODE_GLYPH,
    MODE_LINES,
    KIND_LINES,
    defaultKind,
    kindLabel,
    newChatLabel,
    newChatSelected,
    newSession,
    openSession,
    refreshNightshift,
    renameSession,
    showNightshift,
  } from "./state.svelte";
  import * as api from "./api";
  import { hasDraft, newDraftKey } from "./drafts.svelte";
  import { forkLine } from "./edit";
  import { isMac } from "./platform";
  import { untrack } from "svelte";
  import type { ChatKind, ChatMode, NightshiftInfo, NightshiftRow, SessionHit, SessionMeta } from "./types";
  import { relativeTime } from "./time";
  import { sameMorning } from "./nightshift";
  import NotesPanel from "./NotesPanel.svelte";
  import ProjectMenu from "./ProjectMenu.svelte";
  import Icon from "./Icon.svelte";
  import DisableDialog from "./DisableDialog.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";

  // Delete confirms in a dialog and moves the log to a trash folder
  // (review round 1, 2026-09-13; memory never-lose-work). It replaced a ×
  // that turned into "sure?" on the first click — arming a button in place
  // is the pattern he called clunky, and it gave the row no way to say what
  // was about to happen to what.
  let deleting = $state<SessionMeta | null>(null);
  let menu = $state(false);
  // The New chat button's other half (nightshift backlog 059, 2026-09-15):
  // the kinds of chat, one line each, in the project menu's popover shape
  // — never a modal. Two axes since backlog 102 (2026-09-16, his review
  // of boards 8a/8b): the kind rows — Claude Code · Chat — each start a
  // chat of that kind, with a dot on the project's default; the privacy
  // rows below start one of the default kind. No row reads "New chat":
  // the wide button is that.
  let kinds = $state(false);
  const mod = isMac ? "⌘" : "Ctrl+";
  const alt = isMac ? "⌥⌘" : "Ctrl+Alt+";
  const KIND_ROWS: { kind: ChatKind; key: string }[] = [
    { kind: "build", key: `${mod}N` },
    { kind: "chat", key: `${alt}N` },
  ];
  const KINDS: { mode: ChatMode; label: string; key: string }[] = [
    { mode: "incognito", label: "Incognito", key: `${mod}⇧N` },
    { mode: "ephemeral", label: "Ephemeral", key: "" },
  ];
  /** The engine the kind is named for: the connection's, else the draft's. */
  const engine = $derived(app.connection?.engine ?? app.draft.engine);
  function startKind(mode: ChatMode) {
    kinds = false;
    void newSession(mode === "normal" ? undefined : mode);
  }
  function startOfKind(kind: ChatKind) {
    kinds = false;
    void newSession(undefined, kind);
  }

  function confirmDelete() {
    if (!deleting) return;
    const id = deleting.id;
    deleting = null;
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
    // Through the state's version, which puts the inverse on the undo
    // stack and toasts a failure itself (nightshift backlog 064).
    await renameSession(id, name);
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
  /** The open project's Nightshift row, once the rows are read. */
  const openRow = $derived(
    app.project ? (app.nightshift.rows.find((r) => r.id === app.project?.id) ?? null) : null,
  );
  const nightshiftBlockers = $derived(openRow?.nightshift?.open_blockers ?? 0);
  /** A morning page this window has not opened, on the open project. */
  const nightshiftNewPage = $derived.by(() => {
    const r = openRow;
    const newest = r?.nightshift?.newest_morning;
    if (!r || !newest) return false;
    return !(app.nightshift.read[r.id] ?? []).some((n) => sameMorning(n, newest));
  });

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

  // ---- Nightshift mode: the open project's card (round 2, point 12). The
  // page shows the project in the top-left chip — there is no second list
  // and no second selection — so this mode shows that one project: its row
  // when it has a contract, the Enable form when it has none.


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

  // The Enable form opens on the open project as soon as its row says it
  // has no contract — the card is the form; nothing to click first. The
  // default runner arrives after the rows do, so a form opened on an empty
  // default is filled in when it lands (and never refilled over a value the
  // user typed or cleared: `runnerPath` is read untracked).
  $effect(() => {
    const r = openRow;
    const d = app.nightshift.defaultRunner;
    if (!r || r.nightshift || r.disabled || !r.exists || r.workspace === null) return;
    if (enabling !== r.id) {
      openEnable(r.id);
    } else if (d && !untrack(() => runnerPath).trim()) {
      runnerPath = d;
    }
  });

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
    <!-- The two actions worth a click without opening the menu (his ask,
         2026-09-16): a new project, and leaving this one. Open project…
         stays in the menu — it is a folder picker, rarer than either. -->
    <div class="project-actions">
      <button class="ns-btn small" onclick={showNewProject} disabled={app.busy}>New project…</button>
      {#if app.project}
        <button class="ns-btn small ghost" onclick={() => void useProject(null)} disabled={app.busy}>
          Leave project
        </button>
      {/if}
    </div>
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
    <!-- A split button: the wide half is New chat as it always was, the
         narrow ▾ half offers the other two kinds. Right-clicking the wide
         half opens the same menu, for whoever reaches for that.

         The wide half is drawn as the selected row while no chat is open
         (nightshift backlog 061, 2026-09-15): New chat is a state, not a
         file, so until the first message there is no row to select and
         this button is the thing that is pressed. It carries the pending
         kind's glyph — `New chat ◐` — when that kind is not the ordinary
         one, the way a row would. -->
    <div class="new-chat-wrap">
      <button
        class="new-chat"
        class:active={newChatSelected()}
        aria-current={newChatSelected() ? "true" : undefined}
        onclick={() => void newSession()}
        oncontextmenu={(e) => {
          e.preventDefault();
          kinds = !kinds;
        }}
        disabled={app.busy}
      >
        {newChatLabel()}{#if hasDraft(newDraftKey(app.project?.id, app.pendingMode))} <span class="mark draft" title="has a draft">✎</span>{/if}
      </button>
      <button
        class="new-chat more"
        title="A Claude Code chat or a Chat; incognito or ephemeral"
        aria-label="Other kinds of chat"
        aria-expanded={kinds}
        onclick={() => (kinds = !kinds)}
        disabled={app.busy}
      >
        ▾
      </button>
      {#if kinds}
        <button class="scrim" aria-label="Close" onclick={() => (kinds = false)}></button>
        <div class="kinds" role="menu">
          <div class="kinds-head">New chat · kind</div>
          {#each KIND_ROWS as k (k.kind)}
            <button class="kind" role="menuitem" onclick={() => startOfKind(k.kind)}>
              <span class="kind-glyph" aria-hidden="true">{defaultKind() === k.kind ? "●" : "○"}</span>
              <span class="kind-text">
                <span class="kind-name">{kindLabel(k.kind, engine)}{#if defaultKind() === k.kind} <span class="kind-tag">default here</span>{/if}</span>
                <span class="kind-line">{KIND_LINES[k.kind]}</span>
              </span>
              <span class="kind-key">{k.key}</span>
            </button>
          {/each}
          <div class="kind-sep"></div>
          {#each KINDS as k (k.mode)}
            <button class="kind" role="menuitem" onclick={() => startKind(k.mode)}>
              <span class="kind-glyph" aria-hidden="true">{MODE_GLYPH[k.mode] || "▢"}</span>
              <span class="kind-text">
                <span class="kind-name">{k.label}</span>
                <span class="kind-line">{MODE_LINES[k.mode]}</span>
              </span>
              {#if k.key}<span class="kind-key">{k.key}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
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
                  >{#if s.mode === "incognito"}<span class="mark" title="Incognito: writes nothing, unread by other chats">{MODE_GLYPH.incognito}</span> {/if}{#if hasDraft(s.id)}<span class="mark draft" title="has a draft">✎</span> {/if}{s.title ?? s.first_user ?? "empty session"}</span
                >
                <span class="excerpt">{s.excerpt}</span>
                <span class="meta"
                  >{s.hits}
                  {s.hits === 1 ? "mention" : "mentions"} · {relativeTime(
                    s.modified,
                  )}{#if forkLine(s, app.sessions)} · <span class="from">{forkLine(s, app.sessions)}</span>{/if}</span
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
          <button class="link" onclick={() => void openProjectFolder()}>
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
                  >{#if s.mode === "incognito"}<span class="mark" title="Incognito: writes nothing, unread by other chats">{MODE_GLYPH.incognito}</span> {/if}{#if hasDraft(s.id)}<span class="mark draft" title="has a draft">✎</span> {/if}{s.title ?? s.first_user ?? "empty session"}</span
                >
                <!-- A fork says where it came from (backlog 062): the
                     parent's name as its own row shows it, or that the
                     parent is gone. -->
                <span class="meta"
                  >{s.id.slice(0, 8)}{#if s.kind === "chat"} · chat{/if}{#if s.mode === "incognito"} · incognito{/if} · {relativeTime(s.modified)}{#if forkLine(s, app.sessions)} · <span class="from" title="Forked from that chat; the parent is unchanged">{forkLine(s, app.sessions)}</span>{/if}</span
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
              title="Delete chat…"
              aria-label="Delete chat"
              onclick={() => (deleting = s)}
              disabled={app.busy}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {:else if app.leftTab === "notes"}
    <NotesPanel />
  {:else}
    <div class="ns-scroll">
      {#if !app.project}
        <p class="hint">Open a project to use Nightshift — the page shows the project in the top-left chip.</p>
        <div class="ns-card open-card">
          <button class="ns-btn small" onclick={showNewProject}>New project…</button>
          <button class="ns-btn small ghost" onclick={() => void openProjectFolder()}>Open project…</button>
        </div>
      {:else if !openRow}
        <p class="hint">{app.nightshift.loading ? "Reading the project…" : `${app.project.name} is not in the project list yet.`}</p>
      {:else}
        <div class="ns-side-h">This project</div>
        {#if openRow.nightshift}
          <div class="ns-list">
            <div class="ns-row on open-card">
              <span class="t ns-top">
                <span class="ns-name">{openRow.name}</span>
                {#if openRow.nightshift.live}
                  <span class="ns-pill live" title="A shift is running; editing is locked">live</span>
                {/if}
              </span>
              <span class="m">{rowMeta(openRow.nightshift)}</span>
              {#if openRow.nightshift.config_error}
                <span class="row-error">{openRow.nightshift.config_error}</span>
              {/if}
              {#if rowHints(openRow.nightshift)}
                <span class="row-hint">{rowHints(openRow.nightshift)}</span>
              {/if}
              <button
                type="button"
                class="disable-link always"
                title="Disable Nightshift on this project (behind a warning)"
                onclick={() => (disabling = openRow)}
              >Disable…</button>
            </div>
          </div>
        {:else}
          <div class="ns-list">
            <div class="other-row enabling open-card">
              <span class="other-top">
                <span class="ns-name">
                  {openRow.name}
                  {#if !openRow.exists}<span class="missing">folder missing</span>{/if}
                </span>
              </span>
              {#if openRow.disabled}
                <span class="row-hint">Nightshift is disabled here · {openRow.disabled}</span>
                <span class="enable-actions">
                  <button class="ns-btn small" disabled={!openRow.exists} onclick={() => void enableNightshift(openRow.id)}>Enable again</button>
                </span>
              {:else if openRow.workspace === null}
                <span class="row-hint">This project has no folder; Nightshift needs one.</span>
              {:else if !openRow.exists}
                <span class="row-hint">The folder is missing; put it back to enable Nightshift.</span>
              {:else}
                <span class="row-hint">Nightshift is not enabled on this project.</span>
                <form
                  class="enable-form"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void confirmEnable();
                  }}
                >
                  <label class="enable-label" for="ns-runner-{openRow.id}">
                    Runner — the folder holding bin/nightshift.sh
                  </label>
                  <input
                    id="ns-runner-{openRow.id}"
                    class="ns-fld enable-input"
                    type="text"
                    bind:value={runnerPath}
                    placeholder="leave empty to set it later in nightshift.json"
                    spellcheck="false"
                  />
                  <span class="enable-actions">
                    <button class="ns-btn small" type="submit">Enable Nightshift on this project</button>
                  </span>
                </form>
              {/if}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if deleting}
    <ConfirmDialog
      title="Delete this chat?"
      lead="It moves to the trash folder beside the other logs, out of the list but still on disk."
      facts={[
        ["chat", deleting.title ?? deleting.first_user ?? "empty session"],
        ["id", deleting.id.slice(0, 8)],
        ["last used", relativeTime(deleting.modified)],
      ]}
      confirmLabel="Move to trash"
      onconfirm={confirmDelete}
      onclose={() => (deleting = null)}
    />
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
  /* ~~The project block is the same 82px as the Nightshift top bar, with the
     name centred, so the sidebar's name and the page title share one
     baseline and one rule across the window (mock-up revision 2d).~~
     2026-09-16 (his ask): the name sits on the chat top bar's line instead —
     that bar is 52px, its title centred at 26px, so a 12px top padding puts
     the 22px name's line there; the path and the actions flow below and the
     block takes the height they need. */
  .project {
    position: relative;
    flex: none;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    padding: 12px 0 10px;
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
  .project-actions {
    display: flex;
    gap: 6px;
    padding: 6px 18px 0;
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
  .disable-link:focus-visible,
  .disable-link.always {
    opacity: 1;
  }
  .disable-link.always {
    background: none;
    border: none;
    font: inherit;
    font-size: 11px;
  }
  .open-card {
    cursor: default;
  }
  .ns-card.open-card {
    margin: 0 10px;
    padding: 10px;
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
  .new-chat-wrap {
    position: relative;
    display: flex;
    margin: 0 0.75rem 0.6rem;
  }
  .new-chat {
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0.75rem;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px 0 0 8px;
    cursor: pointer;
    font-size: 0.85rem;
    font-family: inherit;
    text-align: left;
  }
  .new-chat.more {
    flex: none;
    padding: 0.45rem 0.5rem;
    border-left: none;
    border-radius: 0 8px 8px 0;
    color: var(--dim);
  }
  .mark {
    color: var(--dim);
  }
  /* A chat with words waiting in its composer (nightshift backlog 065):
     the incognito mark's style, a size down so it reads as a note on the
     row and not part of the title. */
  .mark.draft {
    font-size: 0.8em;
  }
  /* The kinds menu: the project menu's popover, under the split button. */
  .kinds {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 40;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .kinds-head {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    padding: 6px 8px 4px;
  }
  .kind {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text);
    text-align: left;
    padding: 7px 8px;
    cursor: pointer;
    font: inherit;
  }
  .kind:hover {
    background: var(--well);
  }
  .kind-glyph {
    color: var(--dim);
    flex: none;
    width: 1.1em;
  }
  .kind-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .kind-name {
    font-size: 0.85rem;
  }
  .kind-line {
    font-size: 0.72rem;
    line-height: 1.35;
    color: var(--dim);
  }
  .kind-key {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    flex: none;
  }
  /* The kind rows (backlog 102): a dot for the project's default, a tag
     saying so, and a rule between the two axes. */
  .kind-tag {
    font-size: 0.7rem;
    color: var(--dim);
    margin-left: 4px;
  }
  .kind-sep {
    height: 1px;
    background: var(--line2);
    margin: 4px 6px;
  }
  .new-chat:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* Selected: the row's own active tokens (`.session-item.active` below),
     so "no chat open" and "this chat open" read as the same kind of
     highlight. */
  .new-chat.active {
    background: var(--sheet);
    border-color: var(--line2);
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
  /* The row's tools (rename, trash) are out of the flow until the row is
     hovered or one of them has keyboard focus — zero width, no padding —
     so the name gets the whole row before it truncates (nightshift backlog
     110: "it should say as much as it can"). On hover they take their
     width back and the name shortens to make room, where it did before.
     Invisible-but-present (`opacity: 0` alone) kept their width reserved
     and the name was cut with space sitting empty at its right. */
  .delete {
    background: transparent;
    border: none;
    color: var(--dim);
    padding: 0;
    width: 0;
    overflow: hidden;
    cursor: pointer;
    border-radius: 8px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    opacity: 0;
  }
  .session-item:hover .delete,
  .delete:focus-visible {
    width: auto;
    padding: 0 0.4rem;
    opacity: 1;
  }
  .delete:hover {
    color: var(--error);
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
  /* The fork's lineage, in the interface face so the parent's name reads
     as a name and not as an id. */
  .meta .from {
    font-family: var(--sans);
    font-style: italic;
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
    padding: 0;
    width: 0;
    overflow: hidden;
    flex-shrink: 0;
    font-size: 0.75rem;
    color: var(--dim);
    background: none;
    border: none;
    cursor: pointer;
    opacity: 0;
  }

  .session-item:hover .rename-btn,
  .rename-btn:focus-visible {
    width: auto;
    padding: 0 0.3rem;
    opacity: 1;
  }

  .rename-btn:hover {
    color: var(--text);
  }
</style>
