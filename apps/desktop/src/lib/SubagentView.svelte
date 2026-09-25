<script lang="ts">
  import { tip } from "./tip";
  /**
   * A subagent's transcript as a tab (nightshift backlog 152, 2026-09-17):
   * the Running-tasks panel's *View transcript*. Drawn from the chat's row
   * for the `Agent` call (`app.subagents`), which keeps its own copy of the
   * child's segments — each call with its input and its whole result,
   * each thought, the child's words — so the tab reads the same while the
   * turn runs and after the post-turn re-sync replaced the live message.
   * The row lives as long as the chat is open; a tab kept past a chat
   * switch says so rather than drawing nothing.
   */
  import { app, subagentRunning, type SubagentRow, type Segment } from "./state.svelte";
  import { shortToolName } from "./activity";
  import { toolInputSummary } from "./transcriptPrefs.svelte";
  import { compactJson } from "./toolinput";
  import { fmtTokens } from "./tokens";
  import type { TabContent } from "./tabs";
  import { openSession } from "./state.svelte";
  import * as api from "./api";
  import { followUpsOf, type FollowUp } from "./subagentAsk";
  import { adoptedChat, agentAsk, agentLive, askSubagent, keyOf, setAgentDraft, takeBackNote } from "./subagentAsk.svelte";

  let { content }: { content: Extract<TabContent, { kind: "subagent" }> } = $props();

  // ~~The open chat's row only~~ — since backlog 160 the rows are kept per
  // chat, so a tab of another chat's agent draws too once its chat has
  // been open (or its turn ran) in this window.
  const row = $derived<SubagentRow | null>(
    app.subagents.find(
      (r) => r.tool_use_id === content.toolUseId && (r.session === content.session || r.session === null),
    ) ?? null,
  );

  // Talking to it (backlog 157): the box under the run, the notes held
  // while it runs, and the chat it was adopted into, whose exchanges are
  // drawn here too — read from that chat's log whenever a turn ends.
  const key = $derived(keyOf({ tool_use_id: content.toolUseId }));
  const live = $derived(row ? agentLive(row) : false);
  const held = $derived(agentAsk.notes[key] ?? []);
  const adopted = $derived(row ? adoptedChat(row) : null);
  let followUps = $state<FollowUp[]>([]);
  $effect(() => {
    const id = adopted;
    // Re-read once each turn ends, wherever it ran.
    if (app.busy) return;
    if (!id) {
      followUps = [];
      return;
    }
    let gone = false;
    api
      .peekSession(id)
      .then((events) => {
        if (!gone) followUps = followUpsOf(events);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  });
  let asking = $state(false);
  async function ask(): Promise<void> {
    if (!row || asking) return;
    const text = (agentAsk.drafts[key] ?? "").trim();
    if (!text) return;
    asking = true;
    // Out of the box once it is held or sent; `askSubagent` keeps it.
    setAgentDraft(key, "");
    try {
      await askSubagent(row, text);
    } finally {
      asking = false;
    }
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void ask();
    }
  }

  function callsOf(segs: Segment[]): number {
    return segs.reduce((n, s) => n + (s.kind === "tool" ? 1 + callsOf(s.call.children ?? []) : 0), 0);
  }
</script>

<div class="sub-view">
  {#if !row}
    <p class="note">
      This agent's chat has not been opened in this window since it
      started: open that chat once and its agents come back from its log.
      Its collapsed row is under the spawning call in that chat's
      transcript.
    </p>
  {:else}
    <header class="head">
      <h2 class="title">{row.description || row.subagent_type || "subagent"}</h2>
      <div class="meta mono">
        <span>{row.subagent_type}</span>
        {#if row.model}<span>· {row.model}</span>{/if}
        <span>· {subagentRunning(row) ? "running" : row.status === "completed" ? "done" : row.status}</span>
        <!-- A row rebuilt from the log (backlog 160) knows only what the
             result carried; a figure it does not know is left out. -->
        {#if !row.restored || row.tokens > 0}<span>· {fmtTokens(row.tokens)} tokens</span>{/if}
        {#if !row.restored || row.tool_uses > 0}<span>· {row.tool_uses} tool use{row.tool_uses === 1 ? "" : "s"}</span>{/if}
        {#if !row.restored}<span>· {row.rounds} round{row.rounds === 1 ? "" : "s"}</span>{/if}
        {#if row.background}<span>· background</span>{/if}
        {#if row.restored}<span>· from the log</span>{/if}
      </div>
    </header>
    {#if row.prompt}
      <details class="task">
        <summary>The task it was given{row.prompt.startsWith("<nightloom-subagent-brief>") ? " — the brief in front" : ""}</summary>
        <pre class="text">{row.prompt}</pre>
      </details>
    {/if}
    {#if row.segments.length === 0}
      <p class="note">{subagentRunning(row) ? "Nothing from it yet." : "It sent nothing back."}</p>
    {:else}
      {@render list(row.segments, 0)}
      <p class="note small">{callsOf(row.segments)} call{callsOf(row.segments) === 1 ? "" : "s"} in all.</p>
    {/if}
    <section class="talk" aria-label="Talk to this agent">
      {#if followUps.length > 0}
        <div class="follow">
          {#each followUps as f, k (k)}
            <div class="asked">{f.asked}</div>
            {#if f.answer}<pre class="words">{f.answer}</pre>{:else}<p class="note small">No answer yet.</p>{/if}
          {/each}
        </div>
      {/if}
      {#each held as n, k (k)}
        <div class="held">
          <span class="held-text">{n.text}</span>
          <button class="link" use:tip={"Put this note back in the box below"} onclick={() => takeBackNote(key, k)}>Take back</button>
        </div>
      {/each}
      <p class="note small hint">
        {#if live}
          It is still running, and nothing can reach it mid-run: what you write is held and goes as your first
          question once it has finished (Stop ends it too).
        {:else if adopted}
          Your questions go to its own chat, which carries its run; the main chat is not told.
          <button class="link" onclick={() => adopted && openSession(adopted)}>Open that chat</button>
        {:else}
          Ask it something: it answers in a new chat that carries its whole run, and the main chat is not told.
        {/if}
      </p>
      <div class="ask-row">
        <textarea
          class="ask"
          rows="2"
          placeholder={live ? "A note for when it finishes" : "Ask this agent"}
          aria-label={live ? "A note for when it finishes" : "Ask this agent"}
          value={agentAsk.drafts[key] ?? ""}
          oninput={(e) => setAgentDraft(key, e.currentTarget.value)}
          onkeydown={onKey}
        ></textarea>
        <button class="send" disabled={asking || !(agentAsk.drafts[key] ?? "").trim()} onclick={() => void ask()}>
          {live ? "Hold" : "Ask"}
        </button>
      </div>
    </section>
  {/if}
</div>

{#snippet list(segs: Segment[], depth: number)}
  <div class="segs" style:margin-left="{depth * 14}px">
    {#each segs as s, k (k)}
      {#if s.kind === "tool"}
        <details class="call" class:error={!!s.call.result?.is_error} open={depth === 0 && !!s.call.result?.is_error}>
          <summary>
            <span class="name" use:tip={s.call.name}>{shortToolName(s.call.name)}</span>
            <span class="arg">{toolInputSummary(s.call.input)}</span>
            <span class="size">
              {#if s.call.denied}refused{:else if s.call.result}{s.call.result.is_error ? "error · " : ""}{s.call.result.content.length.toLocaleString()} chars{:else}running{/if}
            </span>
          </summary>
          <div class="body">
            <div class="label">input</div>
            <pre class="text">{compactJson(s.call.input)}</pre>
            {#if s.call.result}
              <div class="label">{s.call.result.is_error ? "error" : "result"}</div>
              <pre class="text">{s.call.result.content}</pre>
            {/if}
          </div>
        </details>
        {#if s.call.children?.length}
          {@render list(s.call.children, depth + 1)}
        {/if}
      {:else if s.kind === "thinking"}
        <details class="thought">
          <summary>thought{s.ms != null ? ` · ${Math.round(s.ms / 1000)} s` : ""}</summary>
          <pre class="text">{s.text}</pre>
        </details>
      {:else if s.kind === "redacted"}
        <p class="note small">redacted thinking</p>
      {:else if s.kind === "text"}
        <pre class="words">{s.text}</pre>
      {:else if s.kind === "notice"}
        <p class="note small">{s.text}</p>
      {/if}
    {/each}
  </div>
{/snippet}

<style>
  .sub-view {
    padding: 20px 28px 40px;
    overflow: auto;
    height: 100%;
    box-sizing: border-box;
  }
  .head {
    margin-bottom: 12px;
  }
  .title {
    margin: 0 0 4px;
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 500;
  }
  .meta {
    color: var(--dim);
    font-size: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .mono {
    font-family: var(--mono);
  }
  .note {
    color: var(--dim);
    font-size: 13px;
  }
  .note.small {
    font-size: 12px;
  }
  .task {
    margin: 8px 0 14px;
  }
  .task summary,
  .call summary,
  .thought summary {
    cursor: pointer;
    font-size: 12.5px;
    color: var(--dim);
  }
  .segs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .call summary {
    display: flex;
    gap: 8px;
    align-items: baseline;
    color: var(--ink);
  }
  .call .name {
    font-family: var(--mono);
    font-size: 12px;
    flex: none;
  }
  .call .arg {
    color: var(--dim);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .call .size {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    flex: none;
  }
  .call.error .size {
    color: var(--error);
  }
  .body {
    margin: 6px 0 4px 12px;
  }
  .label {
    font-size: 11px;
    color: var(--dim);
    margin: 6px 0 2px;
  }
  .text {
    margin: 0;
    padding: 8px 10px;
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 32rem;
    overflow: auto;
  }
  .talk {
    margin-top: 22px;
    padding-top: 14px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .follow {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .asked,
  .held {
    align-self: flex-end;
    max-width: 80%;
    padding: 6px 12px;
    border-radius: 14px;
    background: var(--well);
    border: 1px solid var(--line);
    font-size: 13.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .held {
    display: flex;
    gap: 10px;
    align-items: baseline;
    border-style: dashed;
  }
  .held-text {
    flex: 1;
    min-width: 0;
  }
  .hint {
    margin: 4px 0 0;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent, var(--ink));
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .ask-row {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .ask {
    flex: 1;
    min-width: 0;
    resize: vertical;
    min-height: 2.6em;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--well);
    color: var(--ink);
    font: inherit;
    font-size: 13.5px;
  }
  .send {
    flex: none;
    padding: 7px 14px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--well);
    color: var(--ink);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  .send:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .words {
    margin: 4px 0;
    font-family: inherit;
    font-size: 13.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
