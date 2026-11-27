<script lang="ts">
  import { hudIn, hudOut } from "./hudMenu";
  import { tip } from "./tip";
  import { plainLine } from "./homeStage/steps"; // Item 991: a row's line drops markdown marks
  /**
   * The bell and its panel (nightshift backlog 069): what waits on him,
   * six kinds with counts — proposals to a project's or his own
   * instructions, notes a dream changed, morning pages unread, blockers
   * open, a release installed, a newer Claude Code (backlog 182) — each
   * opening its existing review or offering its action, each
   * dismissable. Sits in the top bar of the chat view and the Nightshift
   * header alike. Plain text and buttons by tonight's UI standard (blocker
   * 082); the list is `app.centre.notices`, derived in `state.svelte.ts`.
   */
  import * as api from "./api";
  import {
    app,
    dismissNotice,
    markCentreSeen,
    openInstructions,
    openNotice,
    refreshCentre,
    revertApplied,
    revertDreamFile,
    runDailyPass,
  } from "./state.svelte";
  import { bellList, isInstructionsFile, memoryFileName, type Notice } from "./centre";
  import { homeNeedsNow } from "./needsBoard.svelte";
  import { relativeTime } from "./time";
  import { hourLabel } from "./nightshiftFace";
  import DiffView from "./DiffView.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import CliUpdateActions from "./CliUpdateActions.svelte";
  import { portal, anchorBelow } from "./portal";
  // Item 1026 (his pick, B): the bell and the Needs-you pill are one button; the card has two modes.
  import { needs, needsNow, replyTo, reviewProposalRow, setDraft } from "./needsBoard.svelte";
  import { badgeWords, groupNeeds, type NeedRow } from "./needsYou";
  import { withNote } from "./askQuestions";
  import { keyPicks } from "./cardKeys";
  import { openRun } from "./state/running.svelte";
  import { home } from "./home.svelte";
  import { faceOf, openingMode, saveCentreMode, saveNeedsSeen, type CentreMode } from "./oneButton";

  // Item 969: the bell is a daily digest — no number, a dot while a row is new; proposals and blockers are
  // counted in Needs you (item 968), so the bell lists neither.
  const bell = $derived(bellList(app.centre.notices, app.centre.seen, new Date()));
  /** What waits on him, left to Needs you: one quiet line at the panel's foot. Item 995: the pill's one number. */
  const asks = $derived(homeNeedsNow().waiting);

  // Item 1026: the one face — the amber number whenever anything needs him, else the bell (its dot while new).
  const rows = $derived(needsNow());
  const badge = $derived(badgeWords(rows, home.cards.length));
  const face = $derived(faceOf(badge, bell.fresh));
  /** Needs you now's rows: what waits on him, then what is ready for review. */
  const needGroups = $derived(groupNeeds(rows).filter((g) => (g.state === "waiting" || g.state === "review") && g.rows.length > 0));
  const faceTip = $derived(
    face.kind === "needs"
      ? ["Needs you — what waits on you, in every project", ...rows.filter((r) => r.state === "waiting").slice(0, 8).map((r) => `· ${r.tag} · ${r.title}`)].join("\n")
      : bell.fresh
        ? "Something new happened\nDreams, memory, pages, releases"
        : face.review
          ? "Ready for your review\nNothing waits on you"
          : "What happened lately\nNothing new",
  );
  function setMode(m: CentreMode): void {
    app.centre.mode = m;
    saveCentreMode(m);
  }
  // Looking at Needs you now marks the number seen, so it opens on his last mode until the number grows.
  $effect(() => {
    if (!app.centre.open || app.centre.mode !== "needs") return;
    const n = badge?.waiting ? badge.n : 0;
    if (n !== app.centre.needsSeen) {
      app.centre.needsSeen = n;
      saveNeedsSeen(n);
    }
  });
  function answer(row: NeedRow, label: string): void {
    void replyTo(row, withNote(label, needs.drafts[row.id]), []).then((ok) => {
      if (ok) setDraft(row.id, "");
    });
  }
  async function openRow(row: NeedRow): Promise<void> {
    app.centre.open = false;
    if (row.chat) await openRun({ session: row.chat, project: row.project, onScreen: false });
    else if (row.kind === "proposal") await reviewProposalRow(row);
  }
  const when = (at: number | null) => (at ? relativeTime(new Date(at).toISOString()) : "");

  /** The dream notice whose diff is open, and the diff itself. */
  let shown = $state<string | null>(null);
  let diff = $state("");
  let diffLoading = $state(false);
  let diffError = $state<string | null>(null);
  /** A file being reverted, so its button reads "…" while git runs. */
  let reverting = $state<string | null>(null);
  /** A Revert awaiting its confirmation — the app's dialog, not `window.confirm`. */
  let pendingRevert = $state<{ notice: Notice; file: string } | null>(null);

  let panelEl = $state<HTMLElement | null>(null);
  let bellEl = $state<HTMLElement | null>(null);

  // The card's place (nightshift backlog 298). ~~Absolute under the bell,
  // z-index 40~~ — inside the top bar's stacking context (z-index 1) no
  // z-index could lift it over a later sibling's, so the new-chat page's
  // title, folder bar, composer and note chips (and, in a split, the next
  // pane) painted over and through it. Portalled to `body` and fixed by
  // the bell's rectangle instead, as the model and gauge cards have been
  // since backlog 163; refreshed on resize and scroll while open.
  let panelPos = $state({ top: 0, left: 0, width: 560 });
  function placePanel(): void {
    if (!bellEl) return;
    const r = bellEl.getBoundingClientRect();
    const width = Math.min(560, window.innerWidth - 80);
    panelPos = { ...anchorBelow({ left: r.left, right: r.right, bottom: r.bottom }, width, window.innerWidth, 6), width };
  }
  $effect(() => {
    if (!app.centre.open) return;
    placePanel();
    window.addEventListener("resize", placePanel);
    window.addEventListener("scroll", placePanel, true);
    return () => {
      window.removeEventListener("resize", placePanel);
      window.removeEventListener("scroll", placePanel, true);
    };
  });

  function toggle() {
    app.centre.open = !app.centre.open;
    if (!app.centre.open) return;
    // The strip's other cards give way, as the pill's click did (753).
    app.showRail = false;
    app.showContext = false;
    app.showTasks = false;
    setMode(openingMode(app.centre.mode, badge?.waiting ? badge.n : 0, app.centre.needsSeen));
    void refreshCentre();
  }

  // A click outside the panel or the bell closes it, the top bar's
  // popover rule.
  $effect(() => {
    if (!app.centre.open) return;
    // While the Revert dialog is up it owns the scrim and Escape.
    const onDown = (e: MouseEvent) => {
      if (pendingRevert) return;
      const t = e.target as Node;
      if (panelEl?.contains(t) || bellEl?.contains(t)) return;
      app.centre.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (pendingRevert) return;
      if (e.key === "Escape") app.centre.open = false;
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  });

  async function showDiff(n: Notice) {
    if (!n.commit && !n.applied && !n.memory) return;
    if (shown === n.id) {
      shown = null;
      return;
    }
    shown = n.id;
    diff = "";
    diffError = null;
    diffLoading = true;
    try {
      diff = n.memory
        ? await api.centreClaudeMemoryDiff(n.memory.hash)
        : n.commit
          ? await api.centreDreamDiff(n.commit.repo, n.commit.hash)
          : await api.centreAppliedDiff(n.applied!.project?.id ?? null, n.applied!.entry.id);
    } catch (e) {
      diffError = String(e);
    } finally {
      diffLoading = false;
    }
  }

  function revert(n: Notice, file: string) {
    if (!n.commit && !n.applied) return;
    pendingRevert = { notice: n, file };
  }

  async function confirmRevert() {
    const p = pendingRevert;
    if (!p) return;
    pendingRevert = null;
    reverting = p.file;
    try {
      if (p.notice.applied) {
        if (await revertApplied(p.notice)) shown = null;
      } else {
        await revertDreamFile(p.notice, p.file);
      }
    } finally {
      reverting = null;
    }
  }

  /** Open or shut a day's rows; opening it marks its rows seen. */
  function toggleDay(key: string) {
    const opened = app.centre.openDays.includes(key);
    app.centre.openDays = opened ? app.centre.openDays.filter((k) => k !== key) : [...app.centre.openDays, key];
    if (!opened) markCentreSeen(bell.days.find((d) => d.key === key)?.notices.map((n) => n.id) ?? []);
  }

  function doneDay(ns: readonly Notice[]) {
    for (const n of ns) dismissNotice(n.id);
  }

  function openNeeds() {
    app.centre.open = false;
    app.showRail = false;
    app.showContext = false;
    app.showTasks = false;
    app.showNeeds = true;
  }
</script>

<span class="centre-wrap">
  {#snippet item(n: Notice)}
    <div class="centre-item" class:seen={app.centre.seen.includes(n.id)}>
      <div class="centre-line">
        <span class="centre-item-title">{n.title}</span>
        {#if n.at}<span class="centre-when" use:tip={n.at}>{relativeTime(n.at)}</span>{/if}
      </div>
      {#if n.detail}<div class="centre-detail">{plainLine(n.detail)}</div>{/if}
      {#if n.kind === "cli"}<CliUpdateActions />{/if}
      <div class="centre-actions">
        {#if n.kind === "proposal"}
          <button class="ns-btn small" onclick={() => void openNotice(n)}>Review the diff</button>
        {:else if n.kind === "dream" || n.kind === "memory"}
          <button class="ns-btn small" onclick={() => void showDiff(n)}>{shown === n.id ? "Hide the diff" : "Show the diff"}</button>
        {:else if n.kind === "morning"}
          <button class="ns-btn small" onclick={() => void openNotice(n)}>Read it</button>
        {:else if n.kind === "blocker"}
          <button class="ns-btn small" onclick={() => void openNotice(n)}>Answer</button>
        {/if}
        <button class="ns-btn ghost small" use:tip={"Take it off the list\nThe change itself stays"} onclick={() => dismissNotice(n.id)}>Done</button>
      </div>
      {#if n.kind === "dream" && shown === n.id && n.applied}
        <!-- A dream's AGENTS.md write no commit carries (backlog
             344): Revert restores the copy kept from before. -->
        <div class="centre-files">
          <div class="centre-file">
            <span class="mono centre-path" use:tip={n.applied.file}>{n.applied.file}</span>
            <button
              class="ns-btn ghost small"
              use:tip={"Open the instructions in the editor, to change them by hand"}
              onclick={() => void openInstructions(n)}>Open in editor</button
            >
            <button
              class="ns-btn ghost small"
              disabled={reverting !== null}
              use:tip={"Put this file back as it was before the dream (from the copy kept then)"}
              onclick={() => void revert(n, n.applied!.file)}>{reverting === n.applied.file ? "…" : "Revert"}</button
            >
          </div>
        </div>
        <div class="centre-diff">
          <DiffView text={diff} loading={diffLoading} error={diffError} leftLabel="before the dream" rightLabel="after" />
        </div>
      {/if}
      {#if n.kind === "memory" && shown === n.id && n.memory}
        <!-- Claude Code's own memory (item 751): Nightloom keeps a
             copy and never writes his files, so no Revert here. -->
        <div class="centre-files">
          {#each n.memory.files as f (f.path)}
            <div class="centre-file">
              <span class="mono centre-path" use:tip={f.path}>{memoryFileName(f.path)}</span>
              <span class="centre-pm"><span class="plus">+{f.added}</span> <span class="minus">−{f.removed}</span></span>
            </div>
          {/each}
        </div>
        <div class="centre-detail">A copy Nightloom keeps; it never edits Claude Code's memory files.</div>
        <div class="centre-diff">
          <DiffView text={diff} loading={diffLoading} error={diffError} leftLabel="before" rightLabel="after" />
        </div>
      {/if}
      {#if n.kind === "dream" && shown === n.id && n.commit}
        <!-- The snapshot's diff, and Revert per file: `git checkout
             <hash>^ -- <file>` committed (blocker 168's default). -->
        <div class="centre-files">
          {#each n.commit.files as f (f.path)}
            <div class="centre-file">
              <span class="mono centre-path">{f.path}</span>
              <span class="centre-pm"><span class="plus">+{f.added}</span> <span class="minus">−{f.removed}</span></span>
              {#if isInstructionsFile(n.commit, f.path)}
                <button
                  class="ns-btn ghost small"
                  use:tip={"Open the instructions in the editor, to change them by hand"}
                  onclick={() => void openInstructions(n)}>Open in editor</button
                >
              {/if}
              <button
                class="ns-btn ghost small"
                disabled={reverting !== null}
                use:tip={"Put this file back as it was before the dream (a commit)"}
                onclick={() => void revert(n, f.path)}>{reverting === f.path ? "…" : "Revert"}</button
              >
            </div>
          {/each}
        </div>
        <div class="centre-diff">
          <DiffView text={diff} loading={diffLoading} error={diffError} leftLabel="before the dream" rightLabel="after" />
        </div>
      {/if}
    </div>
  {/snippet}

  <!-- Item 1026: one face. The number wins; else the bell, its dot while a digest row is new. -->
  {#if face.kind === "needs" && badge}
    <button
      class="need-badge waiting"
      class:open={app.centre.open}
      bind:this={bellEl}
      aria-label={`${badge.n} ${badge.word} — open the needs-you list`}
      aria-expanded={app.centre.open}
      use:tip={faceTip}
      onclick={toggle}
    >
      {#if badge.n > 0}<span class="n">{badge.n}</span>{/if}<span class="word">{badge.word}</span>
    </button>
  {:else}
    <button
      class="ns-btn ghost small centre-bell"
      class:on={bell.fresh}
      class:open={app.centre.open}
      bind:this={bellEl}
      use:tip={faceTip}
      aria-label={bell.fresh ? "What happened — something new" : face.kind === "bell" && face.review ? "Needs you and what happened — to review" : "Needs you and what happened"}
      aria-expanded={app.centre.open}
      onclick={toggle}
    >
      🔔{#if bell.fresh}<span class="centre-dot" aria-hidden="true"></span>{/if}{#if face.kind === "bell" && face.review}<span class="review">to review</span>{/if}
    </button>
  {/if}

  {#if app.centre.open}
    <div
      class="centre-panel hud-m"
      bind:this={panelEl}
      use:portal
      in:hudIn|global
      out:hudOut|global
      style="top: {panelPos.top}px; left: {panelPos.left}px; width: {panelPos.width}px"
    >
      <div class="centre-modes" role="tablist" aria-label="Needs you and what happened">
        <button class="mode" class:on={app.centre.mode === "needs"} role="tab" aria-selected={app.centre.mode === "needs"} onclick={() => setMode("needs")}
          >Needs you now<span class="mode-n">{badge?.waiting ? badge.n : 0}</span></button
        >
        <button class="mode" class:on={app.centre.mode === "digest"} role="tab" aria-selected={app.centre.mode === "digest"} onclick={() => setMode("digest")}
          >What happened{#if bell.fresh}<span class="centre-dot small" aria-hidden="true"></span><span class="mode-n">new</span>{/if}</button
        >
        <span class="spacer"></span>
        <button class="ns-btn ghost small" use:tip={"Close"} aria-label="Close" onclick={() => (app.centre.open = false)}>×</button>
      </div>

      {#if app.centre.mode === "needs"}
        <div class="centre-body needs-body" role="tabpanel" use:keyPicks={{ scope: ".ny-row", pick: ".answer" }}>
          {#if needGroups.length === 0}
            <p class="centre-empty">Nothing waits on you.</p>
          {/if}
          {#each needGroups as g (g.state)}
            <div class="ny-group" data-state={g.state}><span class="ny-name">{g.label}</span><span class="ny-count">{g.rows.length}</span></div>
            {#each g.rows as row (row.id)}
              <div class="ny-row" class:asks={!!row.ask} data-state={g.state} tabindex="-1">
                <span class="ny-tag">{row.tag}</span>
                <div class="ny-main">
                  <div class="ny-title">{row.title}</div>
                  {#if row.detail}<div class="ny-detail">{plainLine(row.detail)}</div>{/if}
                  {#if row.ask && row.ask.options.length}
                    <div class="ny-answers">
                      {#each row.ask.options as o, k (o)}
                        <button class="answer" class:first={k === 0} disabled={!!needs.sending[row.id]} use:tip={"Send this answer"} onclick={() => answer(row, o)}>{o}</button>
                      {/each}
                    </div>
                  {/if}
                </div>
                <span class="ny-when">{when(row.at)}</span>
                {#if row.chat || row.kind === "proposal"}
                  <button class="ns-btn ghost small" onclick={() => void openRow(row)}>{row.chat ? "Open" : "Review"}</button>
                {:else}
                  <span></span>
                {/if}
              </div>
            {/each}
          {/each}
          {#if home.cards.length > 0}
            <button class="centre-else" onclick={openNeeds}
              ><span>{home.cards.length === 1 ? "1 Start card from Home" : `${home.cards.length} Start cards from Home`}</span><span class="centre-else-go">in the full board →</span></button
            >
          {/if}
        </div>
        <div class="centre-foot">
          <span class="centre-last">A reply in words, a file or a follow-up: the full board</span>
          <span class="spacer"></span>
          <button class="ns-btn small" use:tip={"Every project's waiting, review and working rows\nAnswer in place, with a reply box"} onclick={openNeeds}>Open the full board</button>
        </div>
      {:else}
      <div class="centre-head">
        <span class="centre-title">What happened</span>
        <span class="spacer"></span>
        {#if bell.fresh}<button class="ns-btn ghost small" use:tip={"Clears the dot\nEvery row stays until 7 days old"} onclick={() => markCentreSeen(bell.ids)}>Mark all seen</button>{/if}
        <button class="ns-btn ghost small" use:tip={"Re-read every source"} onclick={() => void refreshCentre()}>Refresh</button>
      </div>

      <div class="centre-body">
        {#if bell.alone.length === 0 && bell.days.length === 0}
          <p class="centre-empty">Nothing happened in the last 7 days.</p>
        {/if}
        {#each bell.alone as n (n.id)}
          <section class="centre-kind alone">{@render item(n)}</section>
        {/each}
        {#each bell.days as d (d.key)}
          {@const opened = app.centre.openDays.includes(d.key)}
          <section class="centre-day" class:seen={d.fresh === 0}>
            <div class="centre-day-head">
              <button class="centre-day-btn" aria-expanded={opened} onclick={() => toggleDay(d.key)}>
                <span class="chev" class:folded={!opened} aria-hidden="true">▾</span>
                <span class="centre-day-label">{d.label}</span>
                {#if d.fresh > 0}<span class="centre-dot small" aria-label="new"></span>{/if}
                <span class="centre-day-sum">{d.summary}</span>
              </button>
              <button class="ns-btn ghost small" use:tip={"Take this day off the list\nThe changes themselves stay"} onclick={() => doneDay(d.notices)}>Done</button>
            </div>
            {#if opened}
              <div class="centre-day-rows">
                {#each d.notices as n (n.id)}{@render item(n)}{/each}
              </div>
            {/if}
          </section>
        {/each}
        {#if asks > 0}
          <button class="centre-else" use:tip={"Everything that waits on you\nAnswered in Needs you now"} onclick={() => setMode("needs")}
            ><span>{asks === 1 ? "1 thing needs you" : `${asks} things need you`}</span><span class="centre-else-go">in Needs you now →</span></button
          >
        {/if}
      </div>

      {#if pendingRevert}
        <!-- Inside the panel on purpose: the outside-click closer above
             tests DOM containment, and the dialog's fixed scrim is a child. -->
        <ConfirmDialog
          title="Put this file back as it was before the dream?"
          lead={pendingRevert.notice.applied
            ? "The file goes back to the copy kept before the dream wrote it; the dream's version stays in its record, so nothing is lost either way."
            : "The restore is a commit of its own, so the dream's version stays in git and nothing is lost either way."}
          facts={pendingRevert.notice.applied
            ? [["file", pendingRevert.file]]
            : [
                ["file", pendingRevert.file],
                ["dream", pendingRevert.notice.commit?.hash.slice(0, 7) ?? ""],
              ]}
          confirmLabel="Revert"
          onconfirm={() => void confirmRevert()}
          onclose={() => (pendingRevert = null)}
        />
      {/if}

      <div class="centre-foot">
        <button
          class="ns-btn small"
          disabled={app.centre.dailyRunning || app.dreaming || app.capturing}
          use:tip={"Capture → dream → tidy, now, on the engine set under Settings → Knowledge"}
          onclick={() => void runDailyPass()}
        >
          {app.centre.dailyRunning ? "Running the daily pass…" : "Run the daily pass now"}
        </button>
        <span class="centre-last">
          {#if app.centre.daily.on}
            daily at {hourLabel(app.centre.daily.hour)}
          {:else}
            the daily pass is off (Settings → Knowledge)
          {/if}
          {#if app.centre.lastDaily}· last ran {relativeTime(new Date(app.centre.lastDaily).toISOString())}{/if}
        </span>
      </div>
      {/if}
    </div>
  {/if}
</span>

<style>
  .centre-wrap {
    position: relative;
    display: inline-flex;
    flex: none;
  }
  .centre-bell {
    position: relative;
    font-size: 13px;
    padding: 3px 8px;
  }
  .centre-bell.on {
    color: var(--ink);
  }
  /* Item 969: a dot, not a number, while something is new. */
  .centre-dot {
    position: absolute;
    top: 3px;
    right: 4px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--paper);
  }
  .centre-dot.small {
    position: static;
    flex: none;
    width: 6px;
    height: 6px;
    box-shadow: none;
  }
  .centre-panel {
    /* Portalled and fixed (backlog 298): top, left and width are set
       inline from the bell's rectangle. */
    position: fixed;
    max-height: min(720px, calc(100vh - var(--titlebar-h) - 100px));
    display: flex;
    flex-direction: column;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    /* The top bar's cards' level (80): over the composer's menus (70) and
       the overlays, under the toasts (100) and the tooltip. */
    z-index: 80;
    font-family: var(--sans);
    font-size: 13px;
    text-align: left;
    white-space: normal;
  }
  .centre-head,
  .centre-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    flex: none;
  }
  .centre-head {
    border-bottom: 1px solid var(--line);
  }
  .centre-foot {
    border-top: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .centre-title {
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .centre-body {
    overflow-y: auto;
    min-height: 0;
    padding: 4px 12px 8px;
  }
  .centre-empty {
    color: var(--dim);
    margin: 12px 0;
  }
  .centre-kind {
    margin-top: 8px;
  }
  /* Item 969: one row per day; its rows open under it. */
  .centre-day {
    border-bottom: 1px solid var(--line);
  }
  .centre-day-head {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 0;
  }
  .centre-day-btn {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .centre-day-btn .centre-dot.small {
    align-self: center;
  }
  .chev {
    flex: none;
    color: var(--dim);
    font-size: 10px;
    transition: transform 120ms ease;
  }
  .chev.folded {
    transform: rotate(-90deg);
  }
  .centre-day-label {
    flex: none;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  .centre-day-sum {
    flex: 1;
    min-width: 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .centre-day.seen .centre-day-sum,
  .centre-item.seen .centre-item-title {
    color: var(--ink2);
  }
  .centre-day-rows {
    padding: 0 0 4px 18px;
  }
  .centre-else {
    display: flex;
    width: 100%;
    gap: 8px;
    margin-top: 8px;
    padding: 6px 0;
    border: 0;
    background: none;
    color: var(--ink2);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .centre-else-go {
    margin-left: auto;
    color: var(--accent-ink);
  }
  .centre-else:hover .centre-else-go {
    text-decoration: underline;
  }
  .centre-item {
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  .centre-item:last-child {
    border-bottom: none;
  }
  .centre-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .centre-item-title {
    color: var(--ink);
    flex: 1;
    min-width: 0;
  }
  .centre-when {
    color: var(--dim);
    font-size: 11.5px;
    white-space: nowrap;
  }
  .centre-detail {
    color: var(--ink2);
    font-size: 12px;
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  .centre-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .centre-files {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .centre-file {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .centre-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .centre-pm {
    font-family: var(--mono);
    font-size: 11px;
    white-space: nowrap;
  }
  .plus {
    color: var(--ok, #6c9);
  }
  .minus {
    color: var(--failed, #c66);
  }
  .centre-diff {
    margin-top: 6px;
    height: 320px;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .centre-last {
    color: var(--dim);
    font-size: 11.5px;
  }

  /* Filament IV stage 6 (item 570, f4-menus2.png's Notices): a card in
     front; "To review" a ruled mono title; each kind a ruled mono heading
     with its count after the rule (no pill); the item's title in the ink,
     its detail grey, its time in mono at the right. Behind
     `:where(:root:not([data-layout="classic"]))`; Classic's rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .centre-panel {
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.6);
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-head {
    border-bottom: none;
    padding: 8px 12px 4px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-title {
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-head .spacer {
    height: 1px;
    background: var(--line2);
  }
  /* Item 969, Jarvis: the day's label a mono heading, the dot lit. */
  :global(:where(:root:not([data-layout="classic"]))) .centre-day-label {
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    min-width: 7.5em;
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-dot {
    box-shadow: 0 0 6px var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-else {
    font-family: var(--mono);
    font-size: 11px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-item {
    border-bottom-color: var(--line);
    padding: 8px 0 9px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-item-title {
    font-size: 13.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-when {
    font-family: var(--mono);
    font-size: 11px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-foot {
    border-top-color: var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .centre-last {
    font-family: var(--mono);
    font-size: 10.5px;
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .centre-panel {
      animation: menu-rise 90ms ease-out;
    }
  }
  @keyframes menu-rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }

  /* ---- Item 1026: the one button's face and its two modes ---- */
  .need-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 9px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-family: var(--mono);
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 120ms, box-shadow 120ms, transform 80ms ease-out;
  }
  .need-badge:hover,
  .need-badge.open {
    border-color: var(--accent-ink);
  }
  .need-badge:active {
    transform: scale(0.97);
  }
  .need-badge:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .n {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .centre-bell.open {
    background: var(--well);
  }
  .review {
    margin-left: 6px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink2);
  }
  .centre-modes {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    padding: 8px 12px 0;
    border-bottom: 1px solid var(--line2);
    flex: none;
  }
  .centre-modes .spacer {
    flex: 1;
  }
  .centre-modes > .ns-btn {
    align-self: center;
    margin-bottom: 4px;
  }
  .mode {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 29px;
    margin-bottom: -1px;
    padding: 0 12px;
    border: 1px solid var(--line2);
    border-bottom-color: var(--line2);
    border-radius: 6px 6px 0 0;
    background: var(--sheet);
    color: var(--dim);
    font: 500 12.5px var(--sans);
    cursor: pointer;
    transition: color 120ms, background 120ms;
  }
  .mode:hover {
    color: var(--ink);
  }
  .mode.on {
    z-index: 1;
    color: var(--ink);
    background: var(--raised);
    border-bottom-color: var(--raised);
  }
  .mode:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .mode-n {
    color: var(--ink2);
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .ny-group {
    display: flex;
    gap: 8px;
    padding: 10px 2px 5px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  .ny-group[data-state="waiting"] {
    color: var(--accent-ink);
  }
  .ny-count {
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .ny-row {
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr) auto auto;
    gap: 10px;
    align-items: start;
    padding: 8px 6px;
    border-top: 1px solid var(--line2);
  }
  .ny-row:focus {
    outline: none;
  }
  .ny-tag {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
    padding-top: 2px;
    overflow-wrap: anywhere;
  }
  .ny-row[data-state="waiting"] .ny-tag {
    color: var(--accent-ink);
  }
  .ny-main {
    min-width: 0;
  }
  .ny-title {
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .ny-detail {
    margin-top: 2px;
    font-size: 12px;
    color: var(--ink2);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ny-when {
    color: var(--dim);
    font-size: 11.5px;
    white-space: nowrap;
    padding-top: 2px;
  }
  .ny-answers {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .answer {
    font: inherit;
    font-size: 12.5px;
    padding: 3px 11px;
    border-radius: 999px;
    border: 1px solid var(--line2);
    background: none;
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 120ms, box-shadow 120ms, transform 80ms ease-out;
  }
  .answer.first {
    border-color: var(--accent-ink);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .answer:hover:not(:disabled) {
    border-color: var(--accent-ink);
  }
  .answer:active:not(:disabled) {
    transform: scale(0.97);
  }
  .answer:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Jarvis: the switch is Home's tabs (amber top edge on the open one), the group heads wear Needs you's
     brackets, a waiting row its amber lead. Classic keeps the plain rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .mode {
    border-color: color-mix(in srgb, var(--line2) 80%, transparent);
    border-bottom-color: var(--line2);
    border-radius: 7px 7px 0 0;
    background: linear-gradient(180deg, color-mix(in srgb, var(--raised) 70%, var(--sheet)), var(--sheet));
    font: 500 10.5px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  :global(:where(:root:not([data-layout="classic"]))) .mode.on {
    color: var(--accent-ink);
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 16%, var(--raised)), var(--raised) 92%);
    border-color: color-mix(in srgb, var(--accent) 50%, var(--line2));
    border-bottom-color: var(--raised);
    box-shadow: 0 -4px 14px color-mix(in srgb, var(--accent) 12%, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .mode.on::before {
    content: "";
    position: absolute;
    left: -1px;
    right: -1px;
    top: -1px;
    height: 2px;
    border-radius: 7px 7px 0 0;
    background: var(--accent);
    box-shadow: var(--glow-accent, none);
  }
  :global(:where(:root:not([data-layout="classic"]))) .mode-n {
    letter-spacing: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .ny-group {
    letter-spacing: 0.16em;
  }
  :global(:where(:root:not([data-layout="classic"]))) .ny-name::before {
    content: "[ ";
    color: var(--bracket, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .ny-count::after {
    content: " ]";
    color: var(--bracket, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .ny-row[data-state="waiting"] {
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .ny-row.asks {
    box-shadow: inset 2px 0 0 var(--accent);
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%);
  }
  :global(:where(:root:not([data-layout="classic"]))) .answer:hover:not(:disabled) {
    box-shadow: var(--glow-accent, none);
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .ny-row {
      animation: ny-in 0.5s cubic-bezier(0.3, 0.6, 0.3, 1) both;
    }
  }
  @keyframes ny-in {
    0% {
      clip-path: inset(0 0 100% 0);
    }
    100% {
      clip-path: inset(0 0 0 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .need-badge:active,
    .answer:active:not(:disabled) {
      transform: none;
    }
  }
</style>
