<script lang="ts">
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
    centreCount,
    dismissNotice,
    openNotice,
    refreshCentre,
    revertDreamFile,
    runDailyPass,
  } from "./state.svelte";
  import { KIND_LABEL, KIND_ORDER, countsOf, type Notice, type NoticeKind } from "./centre";
  import { relativeTime } from "./time";
  import DiffView from "./DiffView.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import CliUpdateActions from "./CliUpdateActions.svelte";

  const count = $derived(centreCount());
  const counts = $derived(countsOf(app.centre.notices));
  const kinds = $derived(KIND_ORDER.filter((k) => counts[k] > 0));

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
    if (!n.commit) return;
    if (shown === n.id) {
      shown = null;
      return;
    }
    shown = n.id;
    diff = "";
    diffError = null;
    diffLoading = true;
    try {
      diff = await api.centreDreamDiff(n.commit.repo, n.commit.hash);
    } catch (e) {
      diffError = String(e);
    } finally {
      diffLoading = false;
    }
  }

  function revert(n: Notice, file: string) {
    if (!n.commit) return;
    pendingRevert = { notice: n, file };
  }

  async function confirmRevert() {
    const p = pendingRevert;
    if (!p) return;
    pendingRevert = null;
    reverting = p.file;
    try {
      await revertDreamFile(p.notice, p.file);
    } finally {
      reverting = null;
    }
  }

  function byKind(k: NoticeKind): Notice[] {
    return app.centre.notices.filter((n) => n.kind === k);
  }

  function dismissKind(k: NoticeKind) {
    for (const n of byKind(k)) dismissNotice(n.id);
  }
</script>

<span class="centre-wrap">
  <button
    class="ns-btn ghost small centre-bell"
    class:on={count > 0}
    bind:this={bellEl}
    title={count === 0 ? "Nothing to review" : `${count} to review`}
    aria-label="Notifications"
    aria-expanded={app.centre.open}
    onclick={toggle}
  >
    🔔{#if count > 0}<span class="centre-count">{count}</span>{/if}
  </button>

  {#if app.centre.open}
    <div class="centre-panel" bind:this={panelEl}>
      <div class="centre-head">
        <span class="centre-title">To review</span>
        <span class="spacer"></span>
        <button class="ns-btn ghost small" title="Re-read every source" onclick={() => void refreshCentre()}>Refresh</button>
        <button class="ns-btn ghost small" title="Close" aria-label="Close" onclick={() => (app.centre.open = false)}>×</button>
      </div>

      <div class="centre-body">
        {#if kinds.length === 0}
          <p class="centre-empty">Nothing waits on you.</p>
        {/if}
        {#each kinds as k (k)}
          <section class="centre-kind">
            <div class="centre-kind-head">
              <span class="centre-kind-title">{KIND_LABEL[k]}</span>
              <span class="centre-n">{counts[k]}</span>
              <span class="spacer"></span>
              <button class="ns-btn ghost small" title="Dismiss all of this kind" onclick={() => dismissKind(k)}>Dismiss all</button>
            </div>
            {#each byKind(k) as n (n.id)}
              <div class="centre-item">
                <div class="centre-line">
                  <span class="centre-item-title">{n.title}</span>
                  {#if n.at}<span class="centre-when" title={n.at}>{relativeTime(n.at)}</span>{/if}
                </div>
                {#if n.detail}<div class="centre-detail">{n.detail}</div>{/if}
                {#if n.kind === "cli"}<CliUpdateActions />{/if}
                <div class="centre-actions">
                  {#if n.kind === "proposal"}
                    <button class="ns-btn small" onclick={() => void openNotice(n)}>Review the diff</button>
                  {:else if n.kind === "dream"}
                    <button class="ns-btn small" onclick={() => void showDiff(n)}>{shown === n.id ? "Hide the diff" : "Show the diff"}</button>
                  {:else if n.kind === "morning"}
                    <button class="ns-btn small" onclick={() => void openNotice(n)}>Read it</button>
                  {:else if n.kind === "blocker"}
                    <button class="ns-btn small" onclick={() => void openNotice(n)}>Answer</button>
                  {/if}
                  <button class="ns-btn ghost small" onclick={() => dismissNotice(n.id)}>Dismiss</button>
                </div>
                {#if n.kind === "dream" && shown === n.id && n.commit}
                  <!-- The snapshot's diff, and Revert per file: `git checkout
                       <hash>^ -- <file>` committed (blocker 168's default). -->
                  <div class="centre-files">
                    {#each n.commit.files as f (f.path)}
                      <div class="centre-file">
                        <span class="mono centre-path">{f.path}</span>
                        <span class="centre-pm"><span class="plus">+{f.added}</span> <span class="minus">−{f.removed}</span></span>
                        <button
                          class="ns-btn ghost small"
                          disabled={reverting !== null}
                          title="Put this file back as it was before the dream (a commit)"
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
            {/each}
          </section>
        {/each}
      </div>

      {#if pendingRevert}
        <!-- Inside the panel on purpose: the outside-click closer above
             tests DOM containment, and the dialog's fixed scrim is a child. -->
        <ConfirmDialog
          title="Put this file back as it was before the dream?"
          lead="The restore is a commit of its own, so the dream's version stays in git and nothing is lost either way."
          facts={[
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
          title="Capture → dream → tidy, now, on the engine set under Settings → Knowledge"
          onclick={() => void runDailyPass()}
        >
          {app.centre.dailyRunning ? "Running the daily pass…" : "Run the daily pass now"}
        </button>
        <span class="centre-last">
          {#if app.centre.daily.on}
            daily at {String(app.centre.daily.hour).padStart(2, "0")}:00
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
  .centre-count {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--paper);
    background: var(--accent);
    border-radius: 999px;
    padding: 0 6px;
    margin-left: 4px;
  }
  .centre-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: min(560px, calc(100vw - 80px));
    max-height: min(720px, calc(100vh - var(--titlebar-h) - 100px));
    display: flex;
    flex-direction: column;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    z-index: 40;
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
  .centre-kind-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    border-bottom: 1px solid var(--line);
  }
  .centre-kind-title {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .centre-n {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    background: var(--well);
    border-radius: 999px;
    padding: 0 6px;
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
</style>
