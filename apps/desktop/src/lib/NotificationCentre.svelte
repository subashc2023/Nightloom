<script lang="ts">
  import { hudIn, hudOut } from "./hudMenu";
  import { tip } from "./tip";
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
  import { needsNow } from "./needsBoard.svelte";
  import { relativeTime } from "./time";
  import { hourLabel } from "./nightshiftFace";
  import DiffView from "./DiffView.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import CliUpdateActions from "./CliUpdateActions.svelte";
  import { portal, anchorBelow } from "./portal";

  // Item 969: the bell is a daily digest — no number, a dot while a row is new; proposals and blockers are
  // counted in Needs you (item 968), so the bell lists neither.
  const bell = $derived(bellList(app.centre.notices, app.centre.seen, new Date()));
  /** What asks him to decide, left to Needs you: one quiet line at the panel's foot. */
  const asks = $derived(needsNow().filter((r) => r.state === "waiting" && (r.kind === "proposal" || r.kind === "blocker")).length);

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
    if (app.centre.open) void refreshCentre();
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
      {#if n.detail}<div class="centre-detail">{n.detail}</div>{/if}
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

  <button
    class="ns-btn ghost small centre-bell"
    class:on={bell.fresh}
    bind:this={bellEl}
    use:tip={bell.fresh ? "Something new happened\nDreams, memory, pages, releases" : "What happened lately\nNothing new"}
    aria-label={bell.fresh ? "What happened — something new" : "What happened"}
    aria-expanded={app.centre.open}
    onclick={toggle}
  >
    🔔{#if bell.fresh}<span class="centre-dot" aria-hidden="true"></span>{/if}
  </button>

  {#if app.centre.open}
    <div
      class="centre-panel hud-m"
      bind:this={panelEl}
      use:portal
      in:hudIn|global
      out:hudOut|global
      style="top: {panelPos.top}px; left: {panelPos.left}px; width: {panelPos.width}px"
    >
      <div class="centre-head">
        <span class="centre-title">What happened</span>
        <span class="spacer"></span>
        {#if bell.fresh}<button class="ns-btn ghost small" use:tip={"Clears the dot\nEvery row stays until 7 days old"} onclick={() => markCentreSeen(bell.ids)}>Mark all seen</button>{/if}
        <button class="ns-btn ghost small" use:tip={"Re-read every source"} onclick={() => void refreshCentre()}>Refresh</button>
        <button class="ns-btn ghost small" use:tip={"Close"} aria-label="Close" onclick={() => (app.centre.open = false)}>×</button>
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
          <button class="centre-else" use:tip={"Proposals and held blockers\nListed and answered in Needs you"} onclick={openNeeds}
            ><span>{asks === 1 ? "1 thing asks you to decide" : `${asks} things ask you to decide`}</span><span class="centre-else-go">in Needs you →</span></button
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
</style>
