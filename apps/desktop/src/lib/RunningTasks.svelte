<script lang="ts">
  import { tip } from "./tip";
  /**
   * Running tasks (nightshift backlog 152, 2026-09-17): the subagents of
   * the open chat, one row each, like the Claude app's panel — type,
   * model, running or done, elapsed, tokens, tool uses — and *View
   * transcript*, which opens the child's calls, results and words as a
   * tab (`tabs.ts`, kind `subagent`). Live while a child runs: the rows
   * are `app.subagents`, replaced by the translator's `subagent_status`
   * event on every change. Opened from the top bar's agents chip; the
   * overlay in `App.svelte` closes it like the Context page.
   *
   * Redesign (backlog 267, 2026-09-30): ~~one table of every send's agents
   * under `18 agents · 3 running · 18 of 6`~~ — grouped lists whose counts
   * add up to the header's (`taskGroups.ts`): the chats running, then
   * the agents running, then the latest send's finished ones (with Running,
   * the top bar chip's `N agents`), then the earlier sends, folded. One
   * line per row, the same columns in every group, a wider sheet.
   *
   * The figures, and what each is (the translator's doc has the
   * measurement): *tokens* is the CLI's own number for the agent — the
   * latest round's whole request and response, the same figure the
   * `Agent` tool's result and the Claude app show; the hover breaks it
   * down as the sum over the child's rounds (prompt, output, cache read,
   * cache write). *tool uses* is the CLI's count. *elapsed* is the CLI's
   * `duration_ms` once it has reported one, the window's clock until then.
   */
  import {
    app,
    liveChats,
    openChatSubagents,
    openContent,
    openRunningChat,
    subagentRunning,
    type LiveChat,
    type SubagentRow,
  } from "./state.svelte";
  import { fmtTokens } from "./tokens";
  import { budgetChip, budgetTitle } from "./budget";
  import { wrapAsk, wrapTarget, wrapUp } from "./budgetWrap.svelte";
  import { shortModel } from "./subagentRows";
  import { capsLine, fmtElapsed, groupAgents, rowElapsedMs, rowState, stateLabel, summaryLine } from "./taskGroups";
  import Icon from "./Icon.svelte";

  /** A ticking clock for the elapsed column while any child or chat runs. */
  let now = $state(Date.now());
  $effect(() => {
    if (!mine.some(subagentRunning) && chats.length === 0) return;
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  /** The chats whose turns run now (nightshift backlog 159, A4): the
   *  chat on screen's and each one off screen, so a turn left running in
   *  another chat is a row here and a click away. */
  const chats = $derived(liveChats());
  function chatElapsed(c: LiveChat): string {
    if (c.startedAt === null) return "";
    return fmtElapsed(now - c.startedAt);
  }
  async function openChat(c: LiveChat) {
    if (!c.session || c.onScreen) return;
    app.showTasks = false;
    // In its own project first, when that is not the open one (A4).
    await openRunningChat(c.session);
  }

  /** The open chat's rows (backlog 160: the store holds every chat's). */
  const mine = $derived(openChatSubagents());
  /** Running · finished in the latest send · earlier sends (267). */
  const groups = $derived(groupAgents(mine));
  /** Earlier sends fold by default: history, a click away. */
  let earlierOpen = $state(false);

  /** The caps in force (backlog 165): this send's spawns of the per-send
   *  cap — lowered past `slow_at` of the window — the window itself, and
   *  (pass 2) the message's budget meter: `spent 4% of 35%`. */
  const caps = $derived(
    capsLine(
      app.draft.agentLimits,
      app.planUsage?.five_hour ?? null,
      mine.filter((r) => r.turn === app.turnSeq).length,
      app.turnBudget ? budgetChip(app.turnBudget) : null,
    ),
  );

  function elapsed(r: SubagentRow): string {
    return fmtElapsed(rowElapsedMs(r, now));
  }
  function sum(rs: SubagentRow[]): string {
    const n = rs.reduce((t, r) => t + r.tokens, 0);
    return n > 0 ? `${fmtTokens(n)} tokens` : "";
  }

  function usageTitle(r: SubagentRow): string {
    const u = r.usage;
    const parts = [
      `${r.tokens.toLocaleString()} tokens — the CLI's figure: the latest round's whole request and response`,
      `summed over ${r.rounds} round${r.rounds === 1 ? "" : "s"}: ${u.input_tokens.toLocaleString()} prompt · ${u.output_tokens.toLocaleString()} output`,
    ];
    if (u.cache_read_tokens != null || u.cache_write_tokens != null) {
      parts.push(`cache read ${(u.cache_read_tokens ?? 0).toLocaleString()} · cache write ${(u.cache_write_tokens ?? 0).toLocaleString()}`);
    }
    return parts.join("\n");
  }

  /** What the row's name hovers: the type, the task given, the prompt. */
  function nameTitle(r: SubagentRow): string {
    return [r.subagent_type || "agent", r.description, r.prompt].filter(Boolean).join("\n\n");
  }

  function sendLabel(i: number): string {
    return i === 0 ? "The send before" : `${i + 1} sends before`;
  }

  async function view(r: SubagentRow) {
    if (!app.activeSessionId) return;
    app.showTasks = false;
    await openContent({
      kind: "subagent",
      session: app.activeSessionId,
      toolUseId: r.tool_use_id,
      name: r.description || r.subagent_type || "subagent",
    });
  }

  function close() {
    app.showTasks = false;
  }

  /** *Wrap up* on the meter (nightshift backlog 192): the running chat
   *  finishes and writes its hand-off now; with nothing running, the open
   *  chat gets it as a message. */
  const wrapFor = $derived(app.turnBudget ? wrapTarget() : null);
  const wrapAsked = $derived(
    wrapFor !== null && app.busy && (wrapAsk.session === wrapFor || !!app.turnBudget?.wrap_at_ms),
  );
  let wrapping = $state(false);
  async function wrap(): Promise<void> {
    if (!wrapFor) return;
    wrapping = true;
    try {
      await wrapUp(wrapFor);
    } finally {
      wrapping = false;
    }
  }
</script>

{#snippet agentRow(r: SubagentRow)}
  {@const st = rowState(r)}
  <div class="row {st}">
    <span class="state">
      <span class="dot"></span>{stateLabel(r)}
    </span>
    <span class="name" use:tip={nameTitle(r)}>
      <span class="desc">{r.description || r.subagent_type || "agent"}</span>
      {#if r.description && r.subagent_type}<span class="type">{r.subagent_type}</span>{/if}
      {#if r.restored}<span class="tag" use:tip={"Rebuilt from the chat's log: the figures are what the CLI wrote into the result, the transcript is the recorded narrative"}>from the log</span>{/if}
    </span>
    <span class="model">{shortModel(r.model)}</span>
    <span class="num">{elapsed(r)}</span>
    <span class="num" use:tip={usageTitle(r)}>{r.tokens > 0 ? fmtTokens(r.tokens) : "–"}</span>
    <span class="num dim" use:tip={"Tool uses: the CLI's count"}>{r.tool_uses}</span>
    <span class="act">
      <button class="ns-btn ghost small" onclick={() => void view(r)} use:tip={"Open this agent's calls, results and words as a tab"}>
        Transcript <Icon name="chevr" size={11} />
      </button>
    </span>
  </div>
{/snippet}

<div class="modal" role="dialog" aria-label="Running tasks">
  <div class="pane-head">
    <div class="titles">
      <h2 class="pane-title">Running tasks</h2>
      <span class="slug" use:tip={budgetTitle(app.turnBudget)}>{summaryLine(groups.counts, chats.length)}</span>
    </div>
    <span class="spacer"></span>
    {#if wrapFor}
      <button
        class="ns-btn outline small wrap"
        disabled={wrapping || wrapAsked}
        use:tip={app.busy
          ? "Tell the running chat to finish what is half-done, write its hand-off and stop — its next tool call carries it; no new subagents"
          : "Send this chat its wrap-up as a message: finish, write the hand-off, stop"}
        onclick={() => void wrap()}>{wrapAsked ? "Wrapping up…" : "Wrap up"}</button
      >
    {/if}
    <button class="close" use:tip={"Close"} aria-label="Close running tasks" onclick={close}><Icon name="x" size={14} /></button>
  </div>
  {#if mine.length > 0 || app.turnBudget}
    <div class="caps" use:tip={budgetTitle(app.turnBudget)}>{caps}</div>
  {/if}
  <div class="pane">
    {#if chats.length > 0 || mine.length > 0}
      <!-- One column head for every group below: they share the columns. -->
      <div class="cols" aria-hidden="true">
        <span>state</span><span>{mine.length > 0 ? "agent" : "chat"}</span><span>{mine.length > 0 ? "model" : ""}</span><span class="num">elapsed</span><span class="num">tokens</span><span class="num">{mine.length > 0 ? "tools" : ""}</span><span></span>
      </div>
    {/if}
    {#if chats.length > 0}
      <section class="group chats" data-group="chats">
        <header class="group-head">
          <span class="ns-k">Chats running</span><span class="count">{chats.length}</span>
        </header>
        <div class="rows">
          {#each chats as c (c.session ?? "new")}
            <div class="row running">
              <span class="state"><span class="dot"></span>{c.onScreen ? "on screen" : "background"}</span>
              <span class="name" use:tip={c.session ?? "New chat, first turn"}>
                <span class="desc">{c.name}</span>
                {#if c.waiting > 0}<span class="ask">waiting on you</span>{/if}
              </span>
              <span class="model"></span>
              <span class="num">{chatElapsed(c)}</span>
              <span class="num" use:tip={"Tokens so far this turn: the latest request and reply"}>{c.usage ? fmtTokens(c.usage.input_tokens + c.usage.output_tokens) : ""}</span>
              <span class="num"></span>
              <span class="act">
                {#if !c.onScreen && c.session}
                  <button class="ns-btn ghost small" onclick={() => void openChat(c)} use:tip={"Bring this chat on screen, still streaming"}>Open <Icon name="chevr" size={11} /></button>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    {#if mine.length === 0}
      <p class="note">
        No subagents in this chat yet. When the model spawns one (its Agent tool), it is listed here with
        its tokens and tool uses as it runs, and its transcript opens as a tab.
      </p>
    {:else}

      {#if groups.running.length > 0}
        <section class="group" data-group="running">
          <header class="group-head">
            <span class="ns-k">Running</span><span class="count live">{groups.running.length}</span>
            <span class="spacer"></span><span class="aside">{sum(groups.running)}</span>
          </header>
          <div class="rows">
            {#each groups.running as r (r.tool_use_id)}{@render agentRow(r)}{/each}
          </div>
        </section>
      {/if}

      {#if groups.latest.rows.length > 0}
        <section class="group" data-group="latest">
          <header class="group-head">
            <span class="ns-k">Finished · latest send</span><span class="count">{groups.latest.rows.length}</span>
            <span class="spacer"></span>
            <span class="aside" use:tip={"The latest send that spawned agents — the top bar chip's count is this send's, running and finished"}>
              {groups.latest.total} spawned in this send{sum(groups.latest.rows) ? ` · ${sum(groups.latest.rows)}` : ""}
            </span>
          </header>
          <div class="rows">
            {#each groups.latest.rows as r (r.tool_use_id)}{@render agentRow(r)}{/each}
          </div>
        </section>
      {/if}

      {#if groups.earlier.length > 0}
        <section class="group earlier" data-group="earlier" class:open={earlierOpen}>
          <button class="group-head fold" aria-expanded={earlierOpen} onclick={() => (earlierOpen = !earlierOpen)}>
            <span class="chev"><Icon name={earlierOpen ? "chev" : "chevr"} size={12} /></span>
            <span class="ns-k">Earlier sends</span><span class="count">{groups.counts.earlier}</span>
            <span class="spacer"></span>
            <span class="aside">
              {groups.earlier.length} send{groups.earlier.length === 1 ? "" : "s"}{sum(groups.earlier.flatMap((b) => b.rows)) ? ` · ${sum(groups.earlier.flatMap((b) => b.rows))}` : ""}
            </span>
          </button>
          {#if earlierOpen}
            {#each groups.earlier as b, i (b.turn)}
              <div class="send-label">{sendLabel(i)} · {b.rows.length}</div>
              <div class="rows">
                {#each b.rows as r (r.tool_use_id)}{@render agentRow(r)}{/each}
              </div>
            {/each}
          {/if}
        </section>
      {/if}

      <p class="note small">
        Tokens are the CLI's figure per agent — its latest request and reply
        together, what the Claude app shows; hover one for the sum over its
        rounds. A subagent's tokens are not in the context gauge, which is the
        main conversation's window alone.
      </p>
    {/if}
  </div>
</div>

<style>
  /* The Context page's frame: same tokens, same radius. ~~clamp(30rem,
     54vw, 48rem)~~ — too narrow for one line per agent (267). */
  .modal {
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 12px;
    width: min(68rem, calc(100vw - 4rem));
    max-height: calc(100vh - 3rem);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    /* One column set for every group, so the figures line up down the page. */
    --cols: 7.25rem minmax(0, 1fr) 6.5rem 4.75rem 4.25rem 3.25rem 7.25rem;
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
    padding: 20px 24px 4px;
  }
  .titles {
    display: flex;
    align-items: baseline;
    gap: 14px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .pane-title {
    margin: 0;
    font-family: var(--serif);
    font-size: 26px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .slug {
    font-size: 13px;
    color: var(--ink2);
  }
  .caps {
    padding: 0 24px 12px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--dim);
  }
  .spacer {
    flex: 1;
  }
  .wrap {
    flex: none;
  }
  .close {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--dim);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    flex: none;
  }
  .close:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .pane {
    padding: 4px 24px 20px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  /* The pane scrolls; its groups never shrink to fit it. */
  .pane > :global(*) {
    flex: none;
  }
  .note {
    color: var(--dim);
    font-size: 13px;
    margin: 4px 0;
  }
  .note.small {
    font-size: 12px;
    margin-top: 0;
  }

  /* ---- groups ---- */
  .group {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    overflow: hidden;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--well);
    border-bottom: 1px solid var(--line);
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    color: inherit;
    text-align: left;
  }
  .fold {
    border: 0;
    cursor: pointer;
  }
  .fold:hover {
    background: var(--line);
  }
  .earlier:not(.open) .group-head {
    border-bottom: 0;
  }
  .chev {
    display: inline-flex;
    color: var(--dim);
    margin-right: -2px;
  }
  .count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink2);
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 0 7px;
    line-height: 17px;
  }
  .count.live {
    color: var(--live);
    background: var(--live-soft);
    border-color: transparent;
  }
  .aside {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--dim);
  }
  .send-label {
    padding: 6px 12px 4px 36px;
    font-size: 11.5px;
    color: var(--dim);
    border-top: 1px solid var(--line);
    background: var(--sheet);
  }
  .group-head + .send-label {
    border-top: 0;
  }

  /* ---- rows: one line each, the same columns everywhere ---- */
  .cols,
  .row {
    display: grid;
    grid-template-columns: var(--cols);
    column-gap: 12px;
    align-items: center;
  }
  .cols {
    padding: 0 13px;
    margin-bottom: -8px;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .row {
    padding: 0 12px;
    min-height: 36px;
    font-size: 13px;
    color: var(--ink2);
    border-top: 1px solid var(--line);
    box-shadow: inset 2px 0 0 transparent;
  }
  .rows .row:first-child {
    border-top: 0;
  }
  .row:hover {
    background: var(--sheet);
  }
  .row.running {
    color: var(--ink);
    box-shadow: inset 2px 0 0 var(--live);
  }
  .num {
    text-align: right;
    font-family: var(--mono);
    font-size: 12px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .dim {
    color: var(--dim);
  }
  .state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
    font-size: 12.5px;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--done);
  }
  .row.running .state {
    color: var(--live);
  }
  .row.running .dot {
    background: var(--live);
    box-shadow: 0 0 0 3px var(--live-soft);
  }
  .row.done .state {
    color: var(--dim);
  }
  .row.failed .state {
    color: var(--failed);
  }
  .row.failed .dot {
    background: var(--failed);
  }
  .name {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .desc {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.running .desc,
  .chats .desc {
    color: var(--ink);
  }
  .type,
  .tag {
    flex: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  .tag {
    font-family: var(--sans);
    font-style: italic;
  }
  .ask {
    flex: none;
    font-size: 11.5px;
    color: var(--accent-ink);
    background: var(--accent-soft);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .model {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .act {
    text-align: right;
    white-space: nowrap;
  }
  .act .ns-btn {
    gap: 2px;
  }
</style>
