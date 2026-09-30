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
    const s = Math.max(0, Math.round((now - c.startedAt) / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return `${m} min ${s - m * 60} s`;
  }
  async function openChat(c: LiveChat) {
    if (!c.session || c.onScreen) return;
    app.showTasks = false;
    // In its own project first, when that is not the open one (A4).
    await openRunningChat(c.session);
  }

  /** The open chat's rows (backlog 160: the store holds every chat's). */
  const mine = $derived(openChatSubagents());
  /** Newest first: the latest turn's agents at the top. */
  const rows = $derived([...mine].reverse());
  const running = $derived(mine.filter(subagentRunning).length);
  /** The caps in force (backlog 165): this turn's spawns of the per-turn
   *  cap — lowered past `slow_at` of the window — the window itself, and
   *  (pass 2) the message's budget meter: `spent 4% of 35%`. */
  function capsLine(): string {
    const l = app.draft.agentLimits;
    const pct = app.planUsage?.five_hour ?? null;
    // A switched-off limit (backlog 253) is not quoted.
    const slowOn = !l.off.slow && pct !== null && pct >= l.slow_at;
    const stopOn = !l.off.stop_at && pct !== null && pct >= l.stop_at;
    const cap = l.off.per_turn ? (slowOn ? l.slow_to : null) : slowOn ? Math.min(l.per_turn, l.slow_to) : l.per_turn;
    const window = pct === null ? "" : ` · window ${pct}%${stopOn ? " · spawns refused" : slowOn ? " · slowed" : ""}`;
    const budget = app.turnBudget ? ` · ${budgetChip(app.turnBudget)}` : "";
    return ` · ${cap === null ? `${rows.length}` : `${rows.length} of ${cap}`}${window}${budget}`;
  }

  function elapsed(r: SubagentRow): string {
    const ms = r.duration_ms > 0 ? r.duration_ms : Math.max(0, (subagentRunning(r) ? now : r.updatedAt) - r.startedAt);
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return `${m} min ${s - m * 60} s`;
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

  function shortModel(m: string | undefined): string {
    if (!m) return "";
    // `claude-haiku-4-5-20251001` → `haiku 4.5`; anything else as given.
    const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
    return x ? `${x[1]} ${x[2]}.${x[3]}` : m;
  }

  function statusWord(r: SubagentRow): string {
    if (subagentRunning(r)) return "running";
    if (r.status === "completed") return "done";
    return r.status;
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

<div class="modal" role="dialog" aria-label="Running tasks">
  <div class="pane-head">
    <h2 class="pane-title">Running tasks</h2>
    <span class="slug" use:tip={budgetTitle(app.turnBudget)}>
      {#if rows.length === 0}
        no subagents in this chat yet{app.turnBudget ? ` · ${budgetChip(app.turnBudget)}` : ""}
      {:else}
        {rows.length} agent{rows.length === 1 ? "" : "s"}{running > 0 ? ` · ${running} running` : " · all done"}{capsLine()}
      {/if}
    </span>
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
  <div class="pane">
    {#if chats.length > 0}
      <h3 class="sub">Chats running · {chats.length}</h3>
      <table class="tasks chats">
        <tbody>
          {#each chats as c (c.session ?? "new")}
            <tr class="running">
              <td class="agent">
                <span class="desc chat-name" use:tip={c.session ?? "New chat, first turn"}>{c.name}</span>
              </td>
              <td class="state">
                <span class="dot live"></span>{c.onScreen ? "on screen" : "in the background"}{#if c.waiting > 0}<span class="ask"> · waiting on you</span>{/if}
              </td>
              <td class="num mono">{chatElapsed(c)}</td>
              <td class="num mono" use:tip={"Tokens so far this turn: the latest request and reply"}>{c.usage ? fmtTokens(c.usage.input_tokens + c.usage.output_tokens) : ""}</td>
              <td class="act">
                {#if !c.onScreen && c.session}
                  <button class="ns-btn ghost small" onclick={() => void openChat(c)} use:tip={"Bring this chat on screen, still streaming"}>Open</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <h3 class="sub">Subagents in this chat</h3>
    {/if}
    {#if rows.length === 0}
      <p class="note">
        When the model spawns a subagent (its Agent tool), it is listed here with
        its tokens and tool uses as it runs, and its transcript opens as a tab.
      </p>
    {:else}
      <table class="tasks">
        <thead>
          <tr>
            <th>agent</th>
            <th>model</th>
            <th>state</th>
            <th class="num">elapsed</th>
            <th class="num">tokens</th>
            <th class="num">tool uses</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.tool_use_id)}
            <tr class:running={subagentRunning(r)}>
              <td class="agent">
                <span class="type mono">{r.subagent_type || "agent"}</span>
                <span class="desc" use:tip={r.prompt}>{r.description}</span>
              </td>
              <td class="mono dim">{shortModel(r.model)}</td>
              <td class="state">
                <span class="dot" class:live={subagentRunning(r)} class:bad={r.status !== "running" && r.status !== "completed"}></span>
                {statusWord(r)}{r.background ? "" : ""}{#if r.restored}<span class="dim" use:tip={"Rebuilt from the chat's log: the figures are what the CLI wrote into the result, the transcript is the recorded narrative"}> · from the log</span>{/if}
              </td>
              <td class="num mono">{elapsed(r)}</td>
              <td class="num mono" use:tip={usageTitle(r)}>{fmtTokens(r.tokens)}</td>
              <td class="num mono">{r.tool_uses}</td>
              <td class="act">
                <button class="ns-btn ghost small" onclick={() => void view(r)} use:tip={"Open this agent's calls, results and words as a tab"}>
                  View transcript
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
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
  /* The Context page's frame, narrower: same tokens, same radius. */
  .modal {
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 12px;
    width: clamp(30rem, 54vw, 48rem);
    max-width: calc(100vw - 3rem);
    max-height: calc(100vh - 3rem);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
    padding: 20px 24px 12px;
  }
  .pane-title {
    margin: 0;
    font-family: var(--serif);
    font-size: 26px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .slug {
    font-family: var(--mono);
    font-size: 12px;
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
    padding: 0 24px 20px;
    overflow: auto;
  }
  .note {
    color: var(--dim);
    font-size: 13px;
    margin: 8px 0;
  }
  .note.small {
    font-size: 12px;
  }
  .tasks {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .tasks th {
    text-align: left;
    font-weight: 500;
    color: var(--dim);
    font-size: 11.5px;
    padding: 4px 8px 6px 0;
    border-bottom: 1px solid var(--line);
  }
  .tasks td {
    padding: 6px 8px 6px 0;
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }
  .tasks th.num,
  .tasks td.num {
    text-align: right;
  }
  .agent {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .type {
    font-size: 12px;
  }
  .desc {
    color: var(--dim);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22rem;
  }
  .mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .dim {
    color: var(--dim);
  }
  .state {
    white-space: nowrap;
  }
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
    margin-right: 6px;
    vertical-align: middle;
  }
  .dot.live {
    background: var(--live, #4c9aff);
  }
  .dot.bad {
    background: var(--error);
  }
  tr.running td {
    color: var(--ink);
  }
  .act {
    text-align: right;
    white-space: nowrap;
  }
  .sub {
    margin: 10px 0 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--dim);
    font-family: var(--mono);
  }
  .chat-name {
    color: var(--ink);
    font-size: 13px;
  }
  .ask {
    color: var(--accent, var(--ink));
  }
</style>
