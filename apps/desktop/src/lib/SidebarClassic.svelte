<script lang="ts">
  import { home } from "./home.svelte";
  import { BY_HOME_TIP } from "./homeRoutes";
  import { BY_DOOR_GLYPH, byDoorTip } from "./door";
  import { door } from "./door.svelte";
  import { canLeaveProject, canDeleteChat, app, openProjectFolder, showNewProject, useProject, endContentDrag, newChatInThread, startContentDrag, enableNightshift, MODE_GLYPH, MODE_LINES, KIND_LINES, defaultKind, kindLabel, newChatLabel, newChatSelected, threadPlusSelected, threadSelected, newSession, openSession, showNightshift } from "./state.svelte";
  import { tip } from "./tip";
  import { selectAllOnMount } from "./renameField";
  // Item 556: a running chat's row says so (the Classic twin of 534's live row).
  import { ctxText, handoffCueTip, liveClock } from "./chatList";
  import { hasBoxDraft, hasThreadDraft, newDraftKey, readDraft } from "./drafts.svelte";
  import { scheduledFor } from "./scheduled.svelte";
  import { dueAt } from "./schedule";
  import { rowName, scheduleWhen } from "./waitingChat";
  import TerminalButton from "./TerminalButton.svelte";
  import { forkLine } from "./edit";
  import { FORK_GLYPH, forkMark } from "./forkMark";
  import { type SidebarRow } from "./forkTree";
  import { newInThreadTip } from "./thread";
  import { openThreadAs, openThreadView, revealThread } from "./threadPanel.svelte";
  // Edits as versions (item 299): Make main, and the chat made main in
  // its original's row.
  import { canMakeMain } from "./versions";
  import { versions } from "./versions.svelte";
  // A chat's asides under its row and in its menu (item 265).
  import SidebarAsides from "./SidebarAsidesClassic.svelte";
  import AsideMenuItems from "./AsideMenuItems.svelte";
  import { asidesListedOf, asidesShown, toggleAsidesOf } from "./asideSidebar.svelte";
  import { relativeTime } from "./time";
  import NotesPanel from "./NotesPanel.svelte";
  import SearchPanel from "./SearchPanel.svelte";
  import ProjectMenu from "./ProjectMenu.svelte";
  import HomeRow from "./HomeRow.svelte";
  import Icon from "./Icon.svelte";
  import { runMenuCommand } from "./state/menu.svelte";
  import DisableDialog from "./DisableDialog.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { tabPlace } from "./tabPlace";
  import { dragScroll } from "./dragScroll";
  import { sidebarLogic, type SidebarLogicProps } from "./sidebar/logic.svelte";

  // Item 856: the behaviour lives once, in `sidebar/logic.svelte.ts`; this file is the look.
  const props: SidebarLogicProps = $props();
  const T = sidebarLogic(() => props);
</script>

<svelte:window onkeydown={T.windowKeys} />

  {#snippet chatRow(r: SidebarRow, group: string | null = null)}
    {@const s = r.meta}
    <!-- A fork carries ⑂ before its title (backlog 379), its parent named
         on hover; `r.meta` is the row as drawn, so a version made main
         over a top-level original has no mark. -->
    {@const fork = forkMark(s, app.sessions)}
    <!-- A message scheduled here (backlog 532): ◷ before the name, and a
         chat with nothing sent yet is named by it and says when. -->
    {@const waitsFor = scheduledFor(s.id)}
    {@const live = T.liveBy.get(s.id)}
    <!-- Item 856: Classic gains the row's context reading and its hand-off
         cue (items 534, 597, 702), drawn plainly. -->
    {@const ctx = T.rowCtx(s.id)}
    {@const cue = T.rowCue(s, ctx)}
    <div class="session-item" class:active={T.rowLit(s.id)} class:live={!!live} class:waiting={!!live && live.waiting > 0} class:fork={r.depth > 0} style:--depth={r.depth > 0 ? r.depth : undefined}>
      {#if T.renaming === s.id}
        <!-- Opens with the whole title selected (backlog 376): typing
             replaces it, Esc leaves the name as it was. -->
        <input autocorrect="off" autocapitalize="off" spellcheck="false"
          class="rename"
          aria-label="Session name"
          bind:value={T.draft}
          use:selectAllOnMount
          onblur={() => void T.commitRename(s.id)}
          onkeydown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") {
              T.renaming = null;
              T.draft = "";
            }
          }}
        />
      {:else}
        {#if cue}
          <!-- Item 597: the left edge says handed off (a hollow tick) or
               needs a hand-off (a solid hot one). -->
          <span class="ho-cue {cue.kind}" role="img" aria-label={cue.kind === "handed" ? "handed off" : "needs a hand-off"} use:tip={handoffCueTip(cue)}></span>
        {/if}
        <!-- Draggable (backlog 140 pass 2): onto a strip for a tab
             of this chat at that slot, onto a pane's half to open
             it beside. The drag carries `{kind: "chat", session}`. -->
        <button
          class="session-row"
          onclick={(e) => {
            // ⌘-click opens the chat in a new tab (nightshift
            // backlog 099, blocker 140); a plain click replaces the
            // active tab, as it replaced the centre before tabs.
            if (e.metaKey || e.ctrlKey) app.openNext = "new";
            void openSession(s.id);
          }}
          ondblclick={() =>
            T.startRename(s.id, s.title ?? s.first_user ?? "")}
          oncontextmenu={(e) => T.openRowMenu(e, s)}
          draggable="true"
          ondragstart={(e) => startContentDrag(e, { kind: "chat", session: s.id })}
          ondragend={endContentDrag}
          use:tip={T.rowTip(s)}
        >
          <span class="snippet"
            >{#if s.mode === "incognito"}<span class="mark" use:tip={"Incognito: knows nothing about you, writes nothing, unread by other chats"}>{MODE_GLYPH.incognito}</span> {/if}{#if hasBoxDraft(s.id)}<span class="mark draft" role="img" aria-label="has a draft" use:tip={"has a draft"}></span> {/if}{#if home.startedByHome.includes(s.id)}<span class="mark by-home" role="img" aria-label={BY_HOME_TIP} data-by-home use:tip={BY_HOME_TIP}>⌂</span> {/if}{#if door.startedBy[s.id]}<span class="mark by-door" role="img" aria-label={byDoorTip(door.startedBy[s.id])} data-by-door use:tip={byDoorTip(door.startedBy[s.id])}>{BY_DOOR_GLYPH}</span> {/if}{#if fork}<span class="mark fork" role="img" aria-label={fork.tip} use:tip={fork.tip}>{FORK_GLYPH}</span> {/if}{#if waitsFor}<span class="mark sched" role="img" aria-label="scheduled message" data-sched-mark use:tip={`A message is scheduled here: it sends at ${scheduleWhen(dueAt(waitsFor))}`}>◷</span> {/if}{rowName(s, waitsFor?.text ?? null, readDraft(s.id).text)}</span
          >
          <!-- A fork says where it came from (backlog 062): the
               parent's name as its own row shows it, or that the
               parent is gone. -->
          <span class="meta"
            >{#if live}<span class="live-mark" class:wait={live.waiting > 0}><span class="live-dot" aria-hidden="true"></span>{live.waiting > 0 ? "waiting on you" : "running"}{#if live.startedAt !== null}{" "}{liveClock(T.liveNow - live.startedAt)}{/if}{#if T.toolsText(s.id)}{" "}{T.toolsText(s.id)}{/if}</span>{" · "}{/if}{#if waitsFor && s.user_turns === 0}scheduled · {scheduleWhen(dueAt(waitsFor))}{" · "}{/if}{s.id.slice(0, 8)}{#if s.kind === "chat"}{" · "}chat{/if}{#if s.mode === "incognito"}{" · "}incognito{/if} · {relativeTime(s.modified, T.dayNow)}{#if ctx && !live}{" · "}{ctxText(ctx.used)}{/if}{#if s.thread && s.thread !== group}{" · "}<span class="thread" use:tip={`Works from the research thread ${s.thread}`}>◇ {s.thread}</span>{/if}{#if r.depth === 0 && forkLine(s, app.sessions)}{" · "}<span class="from" use:tip={"Forked from that chat; the parent is unchanged"}>{forkLine(s, app.sessions)}</span>{/if}</span
          >
        </button>
        <!-- The origin's forks (backlog 207): a chevron and the count,
             always shown on a row that has any; closed by default. -->
        {#if r.forks > 0}
          {@const shown = r.expanded}
          <button
            class="forks-btn"
            class:open={shown}
            aria-expanded={shown}
            aria-label={`${shown ? "Hide" : "Show"} ${r.forks} fork${r.forks === 1 ? "" : "s"}`}
            use:tip={`${shown ? "Hide" : "Show"} the ${r.forks === 1 ? "chat" : `${r.forks} chats`} forked from this one`}
            onclick={() => T.toggleForks(s.id)}
          >
            <Icon name="chevr" size={11} />{r.forks}
          </button>
        {/if}
        <!-- Its asides (item 265): a toggle of their own beside the
             forks', the asides glyph and the count. -->
        {@const nAsides = asidesListedOf(s.id).length}
        {#if nAsides > 0}
          {@const shownA = asidesShown.open.has(s.id)}
          <button
            class="forks-btn asides-btn"
            class:open={shownA}
            aria-expanded={shownA}
            aria-label={`${shownA ? "Hide" : "Show"} ${nAsides} aside${nAsides === 1 ? "" : "s"}`}
            use:tip={`${shownA ? "Hide" : "Show"} this chat's ${nAsides === 1 ? "aside" : `${nAsides} asides`}`}
            onclick={() => toggleAsidesOf(s.id)}
          >
            <Icon name="chevr" size={11} /><Icon name="think" size={11} />{nAsides}
          </button>
        {/if}
        <!-- The row's one tool (backlog 208, design C): ··· opens the
             right-click menu — Open, new tab, beside, Rename, Delete…
             (Delete still confirms and moves to the trash folder). It
             replaced a ✎ and a bin he found clunky, most on the
             highlighted row. -->
        {@const menuHere = T.rowMenu?.s.id === s.id}
        <button
          class="more-btn"
          class:open={menuHere}
          use:tip={"Open, rename, delete…"}
          aria-label="More for this chat"
          aria-haspopup="menu"
          aria-expanded={menuHere}
          onclick={(e) => T.openRowMenuFrom(e, s)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" width="14" height="14" fill="currentColor"
            ><circle cx="4.5" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="15.5" cy="10" r="1.6" /></svg
          >
        </button>
      {/if}
    </div>
    {#if asidesShown.open.has(s.id)}<SidebarAsides session={s.id} depth={r.depth} />{/if}
  {/snippet}

<aside
  class="sidebar"
  bind:this={T.asideEl}
  ondragentercapture={T.onAsideDragEnter}
  ondragovercapture={T.onAsideDragOver}
  ondragleavecapture={T.onAsideDragLeave}
>
  <!-- Item 763 (H1): Home, pinned first above the projects. -->
  <HomeRow classic />
  <div class="project">
    <button
      class="chip"
      class:unfiled={!app.project}
      aria-expanded={T.menu}
      onclick={() => (T.menu = !T.menu)}
      use:tip={app.project?.root ??
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
          {T.shortPath(app.project.root)}
        {:else}
          no folder
        {/if}
      </span>
    </button>
    {#if T.menu}
      <!-- Click-away, not a modal: switching projects is a navigation, and a
           full-screen scrim for it would read as a decision. -->
      <button
        class="scrim"
        aria-label="Close project menu"
        onclick={() => (T.menu = false)}
      ></button>
      <ProjectMenu close={() => (T.menu = false)} />
    {/if}
    <!-- The two actions worth a click without opening the menu (his ask,
         2026-09-16): a new project, and leaving this one. Open project…
         stays in the menu — it is a folder picker, rarer than either. -->
    <div class="project-actions">
      <button class="ns-btn small" onclick={showNewProject} disabled={!canLeaveProject()}>New project…</button>
      {#if app.project}
        <button class="ns-btn small ghost" onclick={() => void useProject(null)} disabled={!canLeaveProject()}>
          Leave project
        </button>
      {/if}
    </div>
  </div>

  {#if app.search.open}
    <!-- The search panel takes the column (board 11a): the project block
         above stays, the nav, the list and the foot give way. -->
    <SearchPanel />
  {:else}
  <nav class="nav" aria-label="Mode">
    <button
      aria-current={app.leftTab === "chats" ? "page" : undefined}
      class:on={app.leftTab === "chats"}
      onclick={T.goChats}
    >
      <Icon name="chat" size={16} />
      <span>Chats</span>
      {#if app.sessions.length > 0}<span class="count">{app.sessions.length}</span>{/if}
    </button>
    <button
      aria-current={app.leftTab === "notes" ? "page" : undefined}
      class:on={app.leftTab === "notes"}
      onclick={T.goNotes}
    >
      <Icon name="note" size={16} />
      <span>Notes</span>
      {#if app.notes.length > 0}<span class="count">{app.notes.length}</span>{/if}
    </button>
    <!-- Draggable (backlog 140 pass 2): onto a strip for a Nightshift
         tab there, onto a pane's half to open it beside. -->
    <button
      aria-current={app.leftTab === "nightshift" ? "page" : undefined}
      class:on={app.leftTab === "nightshift"}
      onclick={() => showNightshift()}
      draggable="true"
      ondragstart={(e) => startContentDrag(e, { kind: "nightshift" })}
      ondragend={endContentDrag}
    >
      <Icon name="moon" size={16} />
      <span>Nightshift</span>
      <!-- Two signals, two pills: open blockers (amber, a count) and an
           unread morning page (blue). Glued into one they read as "3 new
           pages" (2026-09-11 review). -->
      {#if T.nightshiftBlockers > 0 || T.nightshiftNewPage}
        <span class="badges">
          {#if T.nightshiftBlockers > 0}<span class="badge" use:tip={`${T.nightshiftBlockers} held blocker(s)\nThey wait on you`}>{T.nightshiftBlockers} held</span>{/if}
          {#if T.nightshiftNewPage}<span class="badge page" use:tip={"An unread morning page"}>new page</span>{/if}
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
          T.kinds = !T.kinds;
        }}
      >
        {newChatLabel()}{#if hasBoxDraft(newDraftKey(app.project?.id, app.pendingMode))} <span class="mark draft" role="img" aria-label="has a draft" use:tip={"has a draft"}></span>{/if}
      </button>
      <button
        class="new-chat more"
        use:tip={"A Claude Code chat or a Chat; incognito or ephemeral"}
        aria-label="Other kinds of chat"
        aria-expanded={T.kinds}
        onclick={() => (T.kinds = !T.kinds)}
      >
        ▾
      </button>
      {#if T.kinds}
        <button class="scrim" aria-label="Close" onclick={() => (T.kinds = false)}></button>
        <div class="kinds" role="menu" use:T.fitBelow>
          <div class="kinds-head">New chat · kind</div>
          {#each T.KIND_ROWS as k (k.kind)}
            <button class="kind" role="menuitem" onclick={() => T.startOfKind(k.kind)}>
              <span class="kind-glyph" aria-hidden="true">{defaultKind() === k.kind ? "●" : "○"}</span>
              <span class="kind-text">
                <span class="kind-name">{kindLabel(k.kind, T.engine)}{#if defaultKind() === k.kind} <span class="kind-tag">default here</span>{/if}</span>
                <span class="kind-line">{KIND_LINES[k.kind]}</span>
              </span>
              <span class="kind-key">{k.key}</span>
            </button>
          {/each}
          <div class="kind-sep"></div>
          {#each T.KINDS as k (k.mode)}
            <button class="kind" role="menuitem" onclick={() => T.startKind(k.mode)}>
              <span class="kind-glyph" aria-hidden="true">{MODE_GLYPH[k.mode] || "▢"}</span>
              <span class="kind-text">
                <span class="kind-name">{k.label}</span>
                <span class="kind-line">{MODE_LINES[k.mode]}</span>
              </span>
              {#if k.key}<span class="kind-key">{k.key}</span>{/if}
            </button>
          {/each}
          {#if app.project && T.threads.length > 0}
            <!-- New chat in a thread (backlog 288): one row per thread of
                 the project, most recently touched first — a new chat
                 bound to it with the read order in its box, unsent. -->
            <div class="kind-sep"></div>
            <div class="kinds-head">New chat in a thread</div>
            <div class="kind-threads">
              {#each T.threads as t (t.slug)}
                <button
                  class="kind"
                  role="menuitem"
                  disabled={app.busy || app.connecting}
                  use:tip={t.status ? `${t.status} — ${newInThreadTip(t.slug)}` : newInThreadTip(t.slug)}
                  onclick={() => T.startInThread(t.slug)}
                >
                  <span class="kind-glyph" aria-hidden="true">◇</span>
                  <span class="kind-text">
                    <span class="kind-name">{t.title}</span>
                    <span class="kind-line">{t.status || t.slug}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
    {#if app.sessions.length > 0 || app.search.query}
      <!-- The panel's field, at rest (board 11b): typing or focusing opens
           the panel in place; the count reopens it. -->
      <div class="search-wrap">
        <input autocorrect="off" autocapitalize="off" spellcheck="false"
          class="search"
          type="search"
          placeholder="Search chats"
          aria-label="Search chats"
          bind:value={app.search.query}
          onfocus={T.openSearch}
        />
        {#if app.search.result && !app.search.open}
          <button class="search-cnt" use:tip={"Reopen the results"} onclick={T.openSearch}>{app.search.result.matches} ▸</button>
        {/if}
      </div>
    {/if}
    {#if app.sessions.length === 0 && T.groups.length === 0}
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
      <!-- Item 495: the chat list's scroll survives Notes and back, per project. -->
      <div class="session-list" use:tabPlace={`chat-list:${app.project?.id ?? "unfiled"}`} use:dragScroll>
        {#if T.groups.length > 0}
          <div class="section-head threads-head" role="heading" aria-level="3">Threads</div>
        {/if}
        {#each T.groups as g (g.slug)}
          <div
            class="thread-group"
            class:drop={T.dropOn === g.slug}
            class:ins-before={T.lineAt(g) === "before"}
            class:ins-after={T.lineAt(g) === "after"}
            class:dragging={T.draggedThread() === g.slug}
            role="group"
            aria-label={`Thread ${g.title}`}
            ondragover={(e) => T.overThread(e, g) || T.overDrop(e, g.slug)}
            ondragleave={T.leaveDrop}
            ondrop={(e) => T.dropThread(e) || T.onDropChat(e, g.slug)}
          >
            <!-- Backlog 292: the chevron folds the group; the name (and status
                 line) opens the thread's tab — what the thread stores. A slug
                 with no thread.md has nothing to show, so its name folds too. -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="tg-head" class:active={threadSelected(g.slug)} oncontextmenu={(e) => T.openThreadMenu(e, g)}>
              <button
                class="tg-toggle"
                class:open={g.open}
                aria-expanded={g.open}
                aria-label={`${g.open ? "Hide" : "Show"} the chats in the thread ${g.slug}`}
                use:tip={`${g.open ? "Hide" : "Show"} the chats in the thread ${g.slug}`}
                onclick={() => T.toggleThread(g.slug)}
              >
                <span class="tg-chev"><Icon name="chevr" size={13} /></span>
              </button>
              {#if T.threadRenaming === g.slug}
                <!-- Rename (item 424): the title only; the slug stays. -->
                <input autocorrect="off" autocapitalize="off" spellcheck="false"
                  class="rename tg-rename"
                  aria-label="Thread name"
                  bind:value={T.threadDraft}
                  use:selectAllOnMount
                  onblur={() => void T.commitThreadRename(g.slug)}
                  onkeydown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") {
                      e.stopPropagation();
                      T.threadRenaming = null;
                      T.threadDraft = "";
                    }
                  }}
                />
              {:else}
              <button
                class="tg-open"
                use:tip={g.missing
                  ? `${g.open ? "Hide" : "Show"} the chats bound to ${g.slug} (no thread.md in this project)`
                  : `Open what the thread ${g.slug} stores: thread.md (Start here, Queue, Claims, His view…), log.md, archive.md`}
                onclick={() => (g.missing ? T.toggleThread(g.slug) : void openThreadView(g.slug, g.title))}
                ondragend={endContentDrag}
                draggable={!g.missing}
                ondragstart={(e) => startContentDrag(e, g.title && g.title !== g.slug ? { kind: "thread", slug: g.slug, title: g.title } : { kind: "thread", slug: g.slug })}
              >
                <span class="tg-text">
                  <span class="tg-name"><span class="tg-mark" aria-hidden="true">◇</span> {g.title}{#if hasThreadDraft(app.project?.id, g.slug)} <span class="mark draft" role="img" aria-label="a new chat here has a draft" use:tip={"A new chat in this thread has a draft: its + opens it"}></span>{/if}</span>
                  <span class="tg-status">{g.missing ? "no thread.md in this project" : g.status || "no status line yet"}</span>
                </span>
                <span class="tg-count" aria-label={`${g.chats} chat${g.chats === 1 ? "" : "s"}`}>{g.chats}</span>
              </button>
              {/if}
              {#if !g.missing}
                <button
                  class="tg-new"
                  aria-label={`New chat in the thread ${g.slug}`}
                  class:active={threadPlusSelected(g.slug)}
                  use:tip={newInThreadTip(g.slug)}
                  onclick={() => void newChatInThread(g.slug)}
                >+</button>
              {/if}
            </div>
            {#if g.open}
              <div class="tg-rows">
                {#each g.rows as r (r.meta.id)}{@render chatRow(r, g.slug)}{/each}
                {#if g.rows.length === 0}
                  <p class="tg-empty">No chats yet — + starts one, or drag a chat here.</p>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
        {#if T.groups.length > 0}
          <div
            class="loose-head section-head"
            class:drop={T.dropOn === ""}
            role="group"
            aria-label="Chats in no thread"
            ondragover={(e) => T.overThreadsEnd(e) || T.overDrop(e, null)}
            ondragleave={T.leaveDrop}
            ondrop={(e) => T.dropThread(e) || T.onDropChat(e, null)}
          >
            <span role="heading" aria-level="3">Not in a thread</span>
            {#if T.loose.length === 0}
              <span class="loose-hint">Drop a chat here to take it out of its thread</span>
            {/if}
          </div>
        {/if}
        <div
          class="loose"
          role="group"
          aria-label="Chats"
          ondragover={(e) => T.groups.length > 0 && T.overDrop(e, null)}
          ondragleave={T.leaveDrop}
          ondrop={(e) => T.groups.length > 0 && T.onDropChat(e, null)}
        >
          {#each T.loose as r (r.meta.id)}{@render chatRow(r)}{/each}
        </div>
      </div>
      {#if T.threadMenu}
        {@const tg = T.threadMenu.g}
        <button class="scrim" aria-label="Close" onclick={() => (T.threadMenu = null)} oncontextmenu={(e) => { e.preventDefault(); T.threadMenu = null; }}></button>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="row-menu thread-menu"
          role="menu"
          tabindex="-1"
          aria-label={`Thread ${tg.title}`}
          use:T.placeRowMenu={T.threadMenu}
          onkeydown={(e) => T.menuKeys(e, false)}
        >
          {#if tg.missing}
            <p class="row-note">No thread.md for ◇ {tg.slug} in this project — nothing to open, rename or delete. Its chats can be moved out of it.</p>
          {:else}
            <button role="menuitem" onclick={() => T.threadPick((g) => void openThreadAs(g.slug, g.title, "replace"))}>Open</button>
            <button role="menuitem" onclick={() => T.threadPick((g) => void openThreadAs(g.slug, g.title, "new"))}>Open in a new tab</button>
            <button role="menuitem" onclick={() => T.threadPick((g) => void openThreadAs(g.slug, g.title, "beside"))}>Open beside <span class="row-key">drag</span></button>
            <div class="row-sep"></div>
            <button
              role="menuitem"
              use:tip={newInThreadTip(tg.slug)}
              onclick={() => T.threadPick((g) => void newChatInThread(g.slug))}>New chat in this thread</button
            >
            <button role="menuitem" use:tip={"The thread's name only; its folder and slug stay, so its chats still find it"} onclick={() => T.threadPick(T.startThreadRename)}>Rename</button>
            <button role="menuitem" onclick={() => T.threadPick((g) => void revealThread(g.slug))}>Reveal in Finder</button>
            <div class="row-sep"></div>
            <button role="menuitem" onclick={() => T.threadPick((g) => (T.deletingThread = g))}>Delete thread…</button>
          {/if}
        </div>
      {/if}
      {#if T.rowMenu}
        <button class="scrim" aria-label="Close" onclick={() => (T.rowMenu = null)} oncontextmenu={(e) => { e.preventDefault(); T.rowMenu = null; }}></button>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="row-menu"
          role="menu"
          tabindex="-1"
          bind:this={T.rowMenuEl}
          use:T.placeRowMenu={T.rowMenu}
          onpointermove={T.rowMenuMove}
          onkeydown={(e) => T.menuKeys(e, false)}
        >
          <button role="menuitem" onclick={() => T.rowOpen("replace")}>Open</button>
          <button role="menuitem" onclick={() => T.rowOpen("new")}>Open in a new tab <span class="row-key">{T.mod}-click</span></button>
          <button role="menuitem" onclick={() => T.rowOpen("beside")}>Open beside <span class="row-key">drag</span></button>
          <div class="row-sep"></div>
          <button role="menuitem" onclick={T.rowRename}>Rename</button>
          {#if canMakeMain(app.sessions, versions.map, T.rowMenu.s.id)}
            <!-- Item 299: the fork takes this chat's place; the chat it
                 replaces stays a version (‹ › under the edited message). -->
            <button
              role="menuitem"
              use:tip={"Put this fork in its original's row, name and place; the original stays a version under the edited message"}
              onclick={T.rowMakeMain}>Make main</button
            >
          {/if}
          {#if app.project && T.rowMenu.s.mode !== "ephemeral"}
            {@const inThread = T.rowMenu.s.thread ?? null}
            {#if T.rowOthers.length > 0}
              <button
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={T.rowSub === "thread"}
                class:on={T.rowSub === "thread"}
                data-sub="thread"
                onclick={(e) => T.rowSubClick(e, "thread")}
              >Move to thread <span class="row-key">▸</span></button>
            {/if}
            {#if inThread}
              <button role="menuitem" onclick={() => T.rowMove(null)}>Remove from thread <span class="row-key">◇ {inThread}</span></button>
            {/if}
          {/if}
          {#if T.rowMenu.s.mode !== "ephemeral" && (T.moveTargets.length > 0 || app.project)}
            <button
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={T.rowSub === "project"}
              class:on={T.rowSub === "project"}
              data-sub="project"
              disabled={!canDeleteChat(T.rowMenu.s.id)}
              onclick={(e) => T.rowSubClick(e, "project")}
            >Move to project <span class="row-key">▸</span></button>
          {/if}
          {#if T.rowMenu.s.mode !== "incognito" && T.rowMenu.s.mode !== "ephemeral"}
            <button
              role="menuitem"
              disabled={app.capturing || app.dreaming}
              use:tip={"Read this chat for things worth remembering — an imported or old one too — then offer Dream to file them"}
              onclick={T.rowSaveMemory}>Save memory from this chat</button
            >
          {/if}
          <button role="menuitem" disabled={!!T.rowMenu?.s && !canDeleteChat(T.rowMenu.s.id)} onclick={T.rowDelete}>Delete…</button>
          <AsideMenuItems session={T.rowMenu.s.id} onpick={() => (T.rowMenu = null)} />
        </div>
        {#if T.rowSub}
          {#key T.rowSub}
            <!-- The flyout (item 425): beside the menu, not inside it, so
                 the menu never grows and neither box clips the other. -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
              class="row-menu row-sub"
              role="menu"
              tabindex="-1"
              aria-label={T.rowSub === "thread" ? "Move to thread" : "Move to project"}
              bind:this={T.rowSubEl}
              use:T.placeRowSub
              onpointermove={T.rowSubMove}
              onkeydown={(e) => T.menuKeys(e, true)}
            >
              {#if T.rowSub === "thread"}
                {#each T.rowOthers as t (t.slug)}
                  <button role="menuitem" class="row-thread" use:tip={t.status || t.slug} onclick={() => T.rowMove(t.slug)}>◇ {t.title}</button>
                {/each}
              {:else}
                {#each T.moveTargets as p (p.id)}
                  <button role="menuitem" class="row-thread" use:tip={p.root ?? "No folder"} onclick={() => T.rowMoveProject(p.id)}>{p.name}</button>
                {/each}
                {#if app.project}
                  <button role="menuitem" class="row-thread" use:tip={"Unfiled chats: no project"} onclick={() => T.rowMoveProject(null)}>No project</button>
                {/if}
              {/if}
            </div>
          {/key}
        {/if}
      {/if}
    {/if}
  {:else if app.leftTab === "notes"}
    <NotesPanel />
  {:else}
    <div class="ns-scroll" use:tabPlace={`nightshift-side:${app.project?.id ?? "none"}`} use:dragScroll>
      {#if !app.project}
        <p class="hint">Open a project to use Nightshift — the page shows the project in the top-left chip.</p>
        <div class="ns-card open-card">
          <button class="ns-btn small" onclick={showNewProject}>New project…</button>
          <button class="ns-btn small ghost" onclick={() => void openProjectFolder()}>Open project…</button>
        </div>
      {:else if !T.openRow}
        <p class="hint">{app.nightshift.loading ? "Reading the project…" : `${app.project.name} is not in the project list yet.`}</p>
      {:else}
        <div class="ns-side-h">This project</div>
        {#if T.openRow.nightshift}
          <div class="ns-list">
            <div class="ns-row on open-card">
              <span class="t ns-top">
                <span class="ns-name">{T.openRow.name}</span>
                {#if T.openRow.nightshift.live}
                  <span class="ns-pill live" use:tip={"A shift is running; editing is locked"}>live</span>
                {/if}
              </span>
              <span class="m">{T.rowMeta(T.openRow.nightshift)}</span>
              {#if T.openRow.nightshift.config_error}
                <span class="row-error">{T.openRow.nightshift.config_error}</span>
              {/if}
              {#if T.rowHints(T.openRow.nightshift)}
                <span class="row-hint">{T.rowHints(T.openRow.nightshift)}</span>
              {/if}
              <button
                type="button"
                class="disable-link always"
                use:tip={"Disable Nightshift on this project (behind a warning)"}
                onclick={() => (T.disabling = T.openRow)}
              >Disable…</button>
            </div>
          </div>
        {:else}
          <div class="ns-list">
            <div class="other-row enabling open-card">
              <span class="other-top">
                <span class="ns-name">
                  {T.openRow.name}
                  {#if !T.openRow.exists}<span class="missing">folder missing</span>{/if}
                </span>
              </span>
              {#if T.openRow.disabled}
                <span class="row-hint">Nightshift is disabled here · {T.openRow.disabled}</span>
                <span class="enable-actions">
                  <button class="ns-btn small" disabled={!T.openRow.exists} onclick={() => void enableNightshift(T.openRow!.id)}>Enable again</button>
                </span>
              {:else if T.openRow.workspace === null}
                <span class="row-hint">This project has no folder; Nightshift needs one.</span>
              {:else if !T.openRow.exists}
                <span class="row-hint">The folder is missing; put it back to enable Nightshift.</span>
              {:else}
                <span class="row-hint">Nightshift is not enabled on this project.</span>
                <form
                  class="enable-form"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void T.confirmEnable();
                  }}
                >
                  <label class="enable-label" for="ns-runner-{T.openRow.id}">
                    Runner — the folder holding bin/nightshift.sh
                  </label>
                  <input autocorrect="off" autocapitalize="off"
                    id="ns-runner-{T.openRow.id}"
                    class="ns-fld enable-input"
                    type="text"
                    bind:value={T.runnerPath}
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

  <div class="side-foot">
    <!-- New terminal, moved here from the top bar (2026-09-18, his words). -->
    <TerminalButton variant="foot" />
    <!-- His feedback to the agent (item 805); also Nightloom ▸ Send Feedback… and ⌘K. -->
    <button class="foot-btn" onclick={() => runMenuCommand("feedback")}>
      <Icon name="send" />
      <span>Send feedback</span>
    </button>
    <button class="foot-btn" onclick={() => (app.showSettings = true)}>
      <Icon name="gear" />
      <span>Settings</span>
      <span class="spacer"></span>
      <span class="kbd">⌘,</span>
    </button>
  </div>
  {/if}

  {#if T.deleting}
    <ConfirmDialog
      title="Delete this chat?"
      lead="It moves to the trash folder beside the other logs, out of the list but still on disk."
      facts={[
        ["chat", T.deleting.title ?? T.deleting.first_user ?? (scheduledFor(T.deleting.id)?.text || null) ?? "a chat with nothing sent yet"],
        ["id", T.deleting.id.slice(0, 8)],
        ["last used", relativeTime(T.deleting.modified)],
      ]}
      confirmLabel="Move to trash"
      onconfirm={T.confirmDelete}
      onclose={() => (T.deleting = null)}
    />
  {/if}
  {#if T.deletingThread}
    {@const dt = T.deletingThread}
    {@const nBound = app.sessions.filter((x) => x.thread === dt.slug).length}
    <!-- Item 424: the folder moves to the project's trash, never unlinked;
         its chats stay, in no thread. -->
    <ConfirmDialog
      title="Delete this thread?"
      lead={`Its folder moves to the project's trash (.agents/.trash/threads/), out of the list but still on disk.${nBound ? ` ${nBound === 1 ? "Its chat moves" : `Its ${nBound} chats move`} to Not in a thread, messages untouched.` : ""}`}
      facts={[
        ["thread", dt.title],
        ["folder", `.agents/threads/${dt.slug}/`],
        ["chats", nBound === 0 ? "none" : `${nBound}`],
      ]}
      confirmLabel="Move to trash"
      onconfirm={T.confirmDeleteThread}
      onclose={() => (T.deletingThread = null)}
    />
  {/if}

  {#if T.disabling}
    <DisableDialog
      row={T.disabling}
      busy={T.disableBusy}
      onconfirm={() => void T.confirmDisable()}
      onclose={() => (T.disabling = null)}
    />
  {/if}

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
  /* A chat row's right-click menu (backlog 099, board 9a) — the tab
     strip's menu, in the same shape. */
  .row-menu {
    position: fixed;
    z-index: 36;
    display: flex;
    flex-direction: column;
    min-width: 200px;
    padding: 4px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    /* Item 425: placed by `placeMenu`; capped (and scrolling) only when
       taller than the window, so its rows never squash. */
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .row-menu > :global(*) {
    flex-shrink: 0;
  }
  /* The flyout beside it (item 425): Move to thread ▸ / Move to project ▸. */
  .row-sub {
    z-index: 37;
    min-width: 160px;
    max-width: 300px;
  }
  .row-menu button {
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
  }
  .row-menu button:hover:not(:disabled) {
    background: var(--well);
    color: var(--ink);
  }
  .row-menu button:disabled {
    color: var(--dim);
    cursor: default;
  }
  .row-key {
    color: var(--dim);
    font-size: 11.5px;
  }
  /* Item 424: a thread with no thread.md has nothing the menu can act on. */
  .row-note {
    margin: 4px 8px;
    max-width: 220px;
    color: var(--dim);
    font-size: 12px;
    line-height: 1.4;
  }
  .row-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--line);
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
    /* Positioned so a hovered half can sit over its neighbour (below). */
    position: relative;
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
  /* ~~`border-left: none`~~ — the ▾ half borrowed New chat's right edge,
     so its hover lit three sides (nightshift backlog 225, his screenshot
     of 2026-09-25). It has a left edge of its own now, laid over New
     chat's by a -1px margin — still one line between them — and the
     hovered half is raised over the other, so either one lights all four
     sides. */
  .new-chat.more {
    flex: none;
    margin-left: -1px;
    padding: 0.45rem 0.5rem;
    border-radius: 0 8px 8px 0;
    color: var(--dim);
  }
  .mark {
    color: var(--dim);
  }
  /* A row's marks sit before the title with a gap (nightshift backlog 239):
     the space written after each mark is the last thing in its {#if}
     block, which Svelte trims, so the dot and ◐ touched the title. */
  .snippet > .mark,
  .snippet > .mark.draft {
    margin-right: 0.35em;
  }
  /* A chat with words waiting in its composer (nightshift backlog 065):
     ~~the incognito mark's style, a size down~~ — an accent dot since
     backlog 208 (2026-09-25): the ✎ it was matched the rename button's,
     so a hovered row with a draft showed two pencils. */
  .mark.draft {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin: 0 1px 1px 0;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: middle;
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
    /* One scroller for the whole menu (backlog 512); fitBelow sets max-height. */
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .kinds > *,
  .kind-threads > .kind {
    flex: none;
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
    z-index: 2;
  }
  /* Selected: the row's own active tokens (`.session-item.active` below),
     so "no chat open" and "this chat open" read as the same kind of
     highlight. */
  .new-chat.active {
    background: var(--sheet);
    border-color: var(--line2);
    z-index: 1;
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
  /* Item 856 (from Jarvis's item 597): the hand-off cue on the row's left
     edge — solid in the hot colour when it needs a hand-off, hollow when
     handed off. */
  .session-item:has(.ho-cue) {
    position: relative;
  }
  .ho-cue {
    position: absolute;
    left: 2px;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 2px;
    z-index: 1;
  }
  .ho-cue.needs {
    background: var(--hot);
  }
  .ho-cue.handed {
    box-shadow: inset 0 0 0 1px var(--ink2);
  }
  .session-item.active {
    background: var(--sheet);
    box-shadow: 0 0 0 1px var(--line2);
  }
  /* Item 423 (his ask 2026-10-27): a right-click opens the row's menu
     without first selecting the word under the pointer, as WebKit does
     for selectable text; the tab strip's rows were already unselectable. */
  .session-row {
    -webkit-user-select: none;
    user-select: none;
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
  /* The row's tool — ~~rename and trash~~ one ··· since backlog 208
     (2026-09-25) — is out of the flow until the row is hovered, it has
     keyboard focus, or its menu is open: zero width, no margin, so the
     name gets the whole row before it truncates (nightshift backlog 110:
     "it should say as much as it can"). On hover it takes its width back
     and the name shortens to make room. Invisible-but-present (`opacity:
     0` alone) kept the width reserved and the name was cut with space
     sitting empty at its right. A small tile, dim at rest and a soft fill
     under the pointer — on the highlighted row too, where the old full-
     height strips read heaviest. */
  .more-btn {
    flex-shrink: 0;
    align-self: center;
    width: 0;
    height: 22px;
    padding: 0;
    margin: 0;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--dim);
    cursor: pointer;
    opacity: 0;
  }
  .session-item:hover .more-btn,
  .more-btn:focus-visible,
  .more-btn.open {
    width: 22px;
    margin-right: 5px;
    opacity: 1;
  }
  .more-btn:hover,
  .more-btn.open {
    background: var(--line);
    color: var(--ink);
  }
  .session-item.active .more-btn:hover,
  .session-item.active .more-btn.open {
    background: var(--well);
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
  /* Item 556: a running row — the live blue's dot and word before the id,
     flat (Classic has no glow); waiting on him in the accent. */
  .meta .live-mark {
    color: var(--live);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .meta .live-mark.wait {
    color: var(--accent);
  }
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .session-item.live {
    box-shadow: inset 2px 0 0 var(--live);
  }
  .session-item.live.waiting {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .session-item.active.live {
    box-shadow: inset 2px 0 0 var(--live), 0 0 0 1px var(--line2);
  }
  .session-item.active.live.waiting {
    box-shadow: inset 2px 0 0 var(--accent), 0 0 0 1px var(--line2);
  }
  .meta .from {
    font-family: var(--sans);
    font-style: italic;
  }
  /* The bound research thread (backlog 281): small and muted, as the
     rest of the line. */
  .meta .thread {
    font-family: var(--sans);
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
  /* The box with its count (backlog 117): the count sits inside the box's
     right edge, in the accent, and reopens the panel. */
  /* Inset as the New chat row above it (item 360): flush, the field's
     right edge ran under the sidebar's border at every zoom. */
  .search-wrap {
    position: relative;
    margin: 0 0.75rem;
  }
  .search-wrap:has(.search-cnt) .search {
    padding-right: 2.8rem;
  }
  .search-cnt {
    position: absolute;
    right: 0.45rem;
    top: 0;
    height: calc(100% - 0.4rem);
    background: transparent;
    border: none;
    padding: 0;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--accent-ink);
    white-space: nowrap;
    cursor: pointer;
  }

  .search::placeholder {
    color: var(--dim);
  }

  /* ~~Why the session matched (`.excerpt`): wraps to two lines and stops~~
     — retired 2026-09-16 with the inline hit list; the search panel's rows
     carry the passage (backlog 117). */

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

  /* ~~`.rename-btn`~~ — retired with the ✎ button (backlog 208); rename
     is in the ··· menu, and a double-click on the row still starts it. */

  /* Forks under their origin (backlog 207): one indent step with a thin
     rule at its left, so the group reads as belonging to the row above.
     A fork of a fork sits under its own parent one step further in
     (blocker 430, "nested is fine"); past three steps the indent stops
     growing so a deep chain keeps room for its names. */
  .session-item.fork {
    margin-left: calc(min(var(--depth, 1), 3) * 0.9rem);
    position: relative;
  }
  .session-item.fork::before {
    content: "";
    position: absolute;
    left: -0.45rem;
    top: 4px;
    bottom: 4px;
    width: 1px;
    background: var(--line2);
  }
  /* The disclosure: chevron and count, always visible on a row that has
     forks; the chevron turns down when the group is open. */
  .forks-btn {
    flex-shrink: 0;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 1px;
    margin-right: 0.25rem;
    padding: 2px 5px 2px 3px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--dim);
    font-family: var(--mono);
    font-size: 0.7rem;
    cursor: pointer;
  }
  .forks-btn:hover {
    background: var(--line);
    color: var(--text);
  }
  .forks-btn :global(.ns-ico) {
    transition: transform 0.12s;
  }
  .forks-btn.open :global(.ns-ico) {
    transform: rotate(90deg);
  }
  /* The asides toggle (item 265): the forks' disclosure with the asides
     glyph after its chevron; only the chevron turns. */
  .asides-btn {
    gap: 2px;
  }
  .forks-btn.asides-btn.open :global(.ns-ico + .ns-ico) {
    transform: none;
  }
  /* Threads in the sidebar (backlog 288): a group per thread — a header
     row (chevron, ◇ name, its status line, the count, a + for a new chat
     in it) over its chats, indented a step — then "Not in a thread". A
     group lights while a chat dragged over it would move there. */
  .thread-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-radius: 8px;
    outline: 1px dashed transparent;
    outline-offset: -1px;
  }
  /* Item 426: where a dragged thread lands — an accent line between groups;
     the thread being dragged is dimmed in place. */
  .thread-group {
    position: relative;
  }
  .thread-group.ins-before::before,
  .thread-group.ins-after::after {
    content: "";
    position: absolute;
    left: 6px;
    right: 6px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
    pointer-events: none;
  }
  .thread-group.ins-before::before {
    top: -2px;
  }
  .thread-group.ins-after::after {
    bottom: -2px;
  }
  .thread-group.dragging .tg-head {
    opacity: 0.5;
  }
  .tg-rename {
    margin: 3px 4px 3px 0;
  }
  .thread-group.drop,
  .loose-head.drop {
    outline-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .tg-head {
    display: flex;
    align-items: stretch;
    border-radius: 8px;
  }
  .tg-head:hover {
    background: var(--well);
  }
  /* Backlog 297: the thread's tab in front — the chat rows' selected look. */
  .tg-head.active {
    background: var(--sheet);
    box-shadow: 0 0 0 1px var(--line2);
  }
  /* Backlog 292: two buttons where 288 had one — the chevron folds, the
     name opens the thread view. */
  .tg-toggle {
    flex: none;
    display: flex;
    align-items: flex-start;
    padding: 6px 2px 6px 4px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--dim);
    cursor: pointer;
  }
  .tg-toggle:hover .tg-chev {
    color: var(--ink);
  }
  /* Item 690 (his bug, 2026-11-13: "a very very small button, has no
     highlight"; a click missed it): a 24-px-wide target with the forks
     button's hover. */
  .tg-toggle {
    min-width: 24px;
    justify-content: center;
    padding: 6px 4px;
  }
  .tg-toggle:hover {
    background: var(--line);
  }
  .tg-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 4px;
    padding: 6px 4px 6px 2px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--ink2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .tg-open:hover .tg-name {
    text-decoration: underline;
    text-decoration-color: var(--line2);
    text-underline-offset: 2px;
  }
  .tg-chev {
    flex: none;
    display: inline-flex;
    padding-top: 3px;
    color: var(--dim);
  }
  .tg-chev :global(.ns-ico) {
    transition: transform 0.12s;
  }
  .tg-toggle.open .tg-chev :global(.ns-ico) {
    transform: rotate(90deg);
  }
  .tg-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .tg-name {
    font-size: 0.82rem;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tg-mark {
    color: var(--accent);
  }
  .tg-status {
    font-size: 0.7rem;
    line-height: 1.35;
    color: var(--dim);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tg-count {
    flex: none;
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--dim);
    padding-top: 2px;
  }
  .tg-new {
    flex: none;
    align-self: flex-start;
    width: 22px;
    height: 22px;
    margin: 4px 4px 0 2px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--dim);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .tg-head:hover .tg-new {
    border-color: var(--line2);
    color: var(--ink2);
  }
  .tg-name .mark.draft {
    margin-left: 4px;
  }
  .tg-new.active {
    color: var(--accent);
  }
  .tg-new:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .tg-new:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tg-rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-left: 10px;
    padding-left: 4px;
    border-left: 1px solid var(--line);
  }
  .tg-empty {
    margin: 0;
    padding: 4px 8px 6px;
    font-size: 0.7rem;
    color: var(--dim);
  }
  /* Backlog 292: "Threads" over the groups and "Not in a thread" over the
     rest, the same small uppercase label. */
  .section-head {
    padding: 6px 8px 2px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .threads-head {
    margin-top: 2px;
  }
  .loose-hint {
    display: block;
    margin-top: 2px;
    font-size: 0.7rem;
    letter-spacing: 0;
    text-transform: none;
  }
  .loose-head {
    margin-top: 6px;
    padding: 6px 8px 2px;
    border-radius: 8px;
    outline: 1px dashed transparent;
    outline-offset: -1px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .loose {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 8px;
  }
  .row-menu button.on {
    background: var(--well);
  }
  .row-menu .row-thread {
    /* Backlog 401 (nightshift): never shrink — with more rows than the
       list's 180 px holds, the column squashed each one to slivers
       (overflow: hidden drops the min-height floor); the list scrolls. */
    flex-shrink: 0;
    justify-content: flex-start;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* ~~max-height: 220px; overflow-y: auto~~ — a second scroller, clipped
     with the menu at the window's bottom (backlog 512, 2026-11-09); the
     whole menu scrolls now. A row is its title on one line and at most two
     of status; the full status leads its tooltip. */
  .kind-threads {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .kind-threads .kind-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .kind-threads .kind-line {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .kind:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
