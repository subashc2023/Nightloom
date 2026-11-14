<script lang="ts">
  import { isImeKey } from "./imeKey";
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
  import { app, chatRuns, subagentRunning, type SubagentRow, type Segment } from "./state.svelte";
  import { shortToolName } from "./activity";
  import { toolInputSummary } from "./transcriptPrefs.svelte";
  import { compactJson } from "./toolinput";
  import { fmtTokens } from "./tokens";
  import type { TabContent } from "./tabs";
  import { openSession } from "./state.svelte";
  import * as api from "./api";
  import { followUpsOf, type FollowUp } from "./subagentAsk";
  import {
    adoptedChat,
    agentAsk,
    agentLive,
    askSubagent,
    keyOf,
    setAgentDraft,
    setTellMain,
    takeBackNote,
    takeBackSteered,
    type Steered,
  } from "./subagentAsk.svelte";
  import { clock12 } from "./awaySettings";
  import { relayArrived, relays } from "./relay.svelte";
  import { keptOpen } from "./keptFolds.svelte";
  import { classic } from "./layout.svelte";
  import { briefDrag, briefHeight, briefKeyStep } from "./agentBrief";
  import { briefOpen, briefStored, setBriefOpen, setBriefStored } from "./agentBrief.svelte";

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
  // Item 495 part 2: the view's folds kept past a project switch (which
  // draws every tab afresh) — by the chat and the spawning call.
  const foldBase = $derived(`fold:${content.session}|agent:${content.toolUseId}`);
  const live = $derived(row ? agentLive(row) : false);
  const held = $derived(agentAsk.notes[key] ?? []);
  // Notes sent into it while it ran (backlog 295): those still on their
  // way, and those delivered — drawn after the call they rode on, or here
  // under the run when that call is not in the copy (a row from the log).
  const steered = $derived(agentAsk.steered[key] ?? []);
  const onTheWay = $derived(steered.filter((n) => !n.deliveredAt));
  const callIds = $derived(new Set(idsOf(row?.segments ?? [])));
  const arrivedLoose = $derived(steered.filter((n) => n.deliveredAt && !(n.toolUseId && callIds.has(n.toolUseId))));
  function idsOf(segs: Segment[]): string[] {
    return segs.flatMap((s) => (s.kind === "tool" ? [s.call.id] : []));
  }
  function arrivedWith(callId: string): Steered[] {
    return steered.filter((n) => n.deliveredAt && n.toolUseId === callId);
  }
  function arrivedLabel(n: Steered): string {
    return `Your note · reached it ${clock12(n.deliveredAt ?? null)}${n.tool ? ` with its ${shortToolName(n.tool)} call` : ""}${n.tellMain ? " · the main chat was told too" : ""}`;
  }
  // What the main model passed on to it with SendMessage (backlog 339).
  const relayed = $derived(row?.task_id ? (relays[row.task_id] ?? []) : []);
  const adopted = $derived(row ? adoptedChat(row) : null);
  let followUps = $state<FollowUp[]>([]);
  $effect(() => {
    const id = adopted;
    // Re-read once each turn ends, wherever it ran — A4: a turn in the
    // adopted chat that runs off screen too.
    if (app.busy || (id !== null && chatRuns(id))) return;
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
    if (e.key === "Enter" && !e.shiftKey && !isImeKey(e)) {
      e.preventDefault();
      void ask();
    }
  }

  // Item 591 (Filament IV): the box grows with the note, to ~8 lines, then
  // scrolls; re-measured when the draft changes from outside (a Take back).
  function grow(node: HTMLTextAreaElement, _value: string) {
    const fit = () => {
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
    };
    fit();
    return { update: fit };
  }
  // The hint under the box: one line, the whole explanation on the "?".
  const hintShort = $derived(
    live ? "Reaches it with its next tool call" : adopted ? "Goes to its own chat" : "It answers in a new chat that carries its run",
  );
  const hintLong = $derived(
    live
      ? "It is still running: what you send reaches it with its next tool call, and is marked here when it does. If it makes no further call, the note goes as your first question once it has finished."
      : adopted
        ? "Your questions go to its own chat, which carries its run; the main chat is not told."
        : "Ask it something: it answers in a new chat that carries its whole run, and the main chat is not told.",
  );

  // Item 591 (Filament IV): the brief, a section with its own scroll and a
  // drag handle on its bottom edge. Open and height are one setting for
  // every agent tab (`agentBrief.svelte.ts`), kept across a relaunch.
  let paneH = $state(0);
  let briefBox = $state<HTMLDivElement | null>(null);
  let dragH = $state<number | null>(null);
  const shownH = $derived(dragH ?? briefHeight(briefStored(), paneH));
  function gripDown(e: PointerEvent): void {
    if (e.button !== 0 || !briefBox) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    const y0 = e.clientY;
    const h0 = briefBox.getBoundingClientRect().height;
    const content = briefBox.scrollHeight;
    grip.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => (dragH = briefDrag(h0, m.clientY - y0, paneH, content));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (dragH !== null) setBriefStored(dragH);
      dragH = null;
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }
  function gripKey(e: KeyboardEvent): void {
    if (!briefBox) return;
    const next = briefKeyStep(e.key, e.shiftKey, briefBox.getBoundingClientRect().height, paneH, briefBox.scrollHeight);
    if (next === null) return;
    e.preventDefault();
    setBriefStored(next);
  }

  function callsOf(segs: Segment[]): number {
    return segs.reduce((n, s) => n + (s.kind === "tool" ? 1 + callsOf(s.call.children ?? []) : 0), 0);
  }
  /** Item 564: a step's number in its list — calls and thinking, 1-based. */
  function stepNo(segs: Segment[], k: number): number {
    let n = 0;
    for (let j = 0; j <= k; j++) if (segs[j].kind === "tool" || segs[j].kind === "thinking") n++;
    return n;
  }
</script>

<div class="sub-view" bind:clientHeight={paneH}>
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
    {#if row.prompt && classic()}
      <details class="task" use:keptOpen={{ key: `${foldBase}|task` }}>
        <summary>The task it was given{row.prompt.startsWith("<nightloom-subagent-brief>") ? " — the brief in front" : ""}</summary>
        <pre class="text">{row.prompt}</pre>
      </details>
    {:else if row.prompt}
      <!-- Item 591 (Filament IV): open by default; its own scroll, ~240 px
           to start (never over ~35% of the pane); the edge under it drags. -->
      <details class="brief" open={briefOpen()} ontoggle={(e) => setBriefOpen(e.currentTarget.open)}>
        <summary>
          <span class="brief-chev" aria-hidden="true">▸</span>
          <span class="brief-title">The task it was given{row.prompt.startsWith("<nightloom-subagent-brief>") ? " — the brief in front" : ""}</span>
          <span class="brief-rule" aria-hidden="true"></span>
          <span class="brief-size mono">{row.prompt.length.toLocaleString()} chars</span>
        </summary>
        <div class="brief-box" bind:this={briefBox} style:max-height="{shownH}px">
          <pre class="brief-text">{row.prompt}</pre>
        </div>
        <!-- A focusable separator is ARIA's window-splitter pattern (arrows
             resize it); svelte's check reads any separator as static. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <div
          class="brief-grip"
          class:dragging={dragH !== null}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the brief"
          aria-valuenow={shownH}
          tabindex="0"
          use:tip={"Drag to resize · double-click for the starting size"}
          onpointerdown={gripDown}
          onkeydown={gripKey}
          ondblclick={() => setBriefStored(0)}
        ></div>
      </details>
    {/if}
    {#if row.segments.length === 0}
      <p class="note">{subagentRunning(row) ? "Nothing from it yet." : "It sent nothing back."}</p>
    {:else}
      {@render list(row.segments, 0, "")}
      {#if classic()}
        <p class="note small">{callsOf(row.segments)} call{callsOf(row.segments) === 1 ? "" : "s"} in all.</p>
      {:else}
        <div class="calls-all mono"><span>{callsOf(row.segments)} call{callsOf(row.segments) === 1 ? "" : "s"} in all</span><span class="calls-rule" aria-hidden="true"></span></div>
      {/if}
    {/if}
    <section class="talk" class:f4={!classic()} aria-label="Talk to this agent">
      {#if followUps.length > 0}
        <div class="follow">
          {#each followUps as f, k (k)}
            <div class="asked">{f.asked}</div>
            {#if f.answer}<pre class="words">{f.answer}</pre>{:else}<p class="note small">No answer yet.</p>{/if}
          {/each}
        </div>
      {/if}
      {#each arrivedLoose as n (n.id)}
        <div class="arrived">
          <span class="arrived-label">{arrivedLabel(n)}</span>
          <span class="arrived-text">{n.text}</span>
        </div>
      {/each}
      {#each relayed as r, k (k)}
        <div class={r.ok && relayArrived(r, row?.segments ?? []) ? "arrived" : "held"} data-relay={!r.ok ? "failed" : relayArrived(r, row?.segments ?? []) ? "arrived" : "relayed"}>
          <span class="arrived-label"
            >{!r.ok
              ? `The main chat tried to pass this on at ${clock12(new Date(r.at).toISOString())} — the CLI refused: ${r.detail.slice(0, 120)}`
              : relayArrived(r, row?.segments ?? [])
                ? `From the main chat (your mid-turn message) · relayed ${clock12(new Date(r.at).toISOString())} · arrived — it has taken a step since`
                : `From the main chat (your mid-turn message) · relayed ${clock12(new Date(r.at).toISOString())} · reaches it at its next step`}</span
          >
          <span class="arrived-text">{r.text}</span>
        </div>
      {/each}
      {#each onTheWay as n (n.id)}
        <div class="held">
          <span class="held-text">{n.text}<span class="waiting">· sent {clock12(n.at)}, reaches it with its next call</span></span>
          <button class="link" use:tip={"Put this note back in the box below, if it has not reached the agent yet"} onclick={() => void takeBackSteered(key, n.id)}>Take back</button>
        </div>
      {/each}
      {#each held as n, k (k)}
        <div class="held">
          <span class="held-text">{n.text}</span>
          <button class="link" use:tip={"Put this note back in the box below"} onclick={() => takeBackNote(key, k)}>Take back</button>
        </div>
      {/each}
      {#if classic()}
        <p class="note small hint">
          {#if live}
            It is still running: what you send reaches it with its next tool call, and is marked here when it does.
            If it makes no further call, the note goes as your first question once it has finished.
            <label class="tell-main">
              <input type="checkbox" checked={agentAsk.tellMain} onchange={(e) => setTellMain(e.currentTarget.checked)} />
              Tell the main chat too
            </label>
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
            placeholder={live ? "A note for it while it runs" : "Ask this agent"}
            aria-label={live ? "A note for it while it runs" : "Ask this agent"}
            value={agentAsk.drafts[key] ?? ""}
            oninput={(e) => setAgentDraft(key, e.currentTarget.value)}
            onkeydown={onKey}
          ></textarea>
          <button class="send" disabled={asking || !(agentAsk.drafts[key] ?? "").trim()} onclick={() => void ask()}>
            {live ? "Send" : "Ask"}
          </button>
        </div>
      {/if}
    </section>
    {#if !classic()}
      <!-- Item 591 (Filament IV): one composer, the main chat's box —
           the note, then a row: Tell main chat, the hint (the whole of it
           on the "?"), Send. Pinned to the bottom of the tab as the main
           box is. The half-typed note is `agentAsk.drafts` (kept). -->
      <div class="ask-card" class:live>
        <textarea
          class="ask-box"
          rows="1"
          use:grow={agentAsk.drafts[key] ?? ""}
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder={live ? "A note for it while it runs" : "Ask this agent"}
          aria-label={live ? "A note for it while it runs" : "Ask this agent"}
          value={agentAsk.drafts[key] ?? ""}
          oninput={(e) => setAgentDraft(key, e.currentTarget.value)}
          onkeydown={onKey}
        ></textarea>
        <div class="ask-foot">
          {#if live}
            <button
              type="button"
              class="tell-chip"
              class:on={agentAsk.tellMain}
              aria-pressed={agentAsk.tellMain}
              use:tip={agentAsk.tellMain
                ? "The main chat is told about each note you send here — click to send to the agent alone"
                : "Notes go to the agent alone — click to tell the main chat too"}
              onclick={() => setTellMain(!agentAsk.tellMain)}
            >
              <span class="tell-mark" aria-hidden="true"></span>Tell main chat
            </button>
          {/if}
          <span class="ask-hint">{hintShort}</span>
          <button type="button" class="ask-why" aria-label={hintLong} use:tip={{ text: hintLong, click: true }}>?</button>
          {#if !live && adopted}
            <button class="link" onclick={() => adopted && openSession(adopted)}>Open that chat</button>
          {/if}
          <span class="ask-spacer"></span>
          <button class="ns-btn accent ask-send" disabled={asking || !(agentAsk.drafts[key] ?? "").trim()} onclick={() => void ask()}>
            {live ? "Send" : "Ask"}
          </button>
        </div>
      </div>
    {/if}
  {/if}
</div>

{#snippet list(segs: Segment[], depth: number, path: string)}
  <div class="segs" style:margin-left="{depth * 14}px">
    {#each segs as s, k (k)}
      {#if s.kind === "tool"}
        <details
          class="call"
          class:error={!!s.call.result?.is_error}
          use:keptOpen={{ key: `${foldBase}|call:${s.call.id}`, fallback: depth === 0 && !!s.call.result?.is_error }}
        >
          <summary>
            <!-- Item 564: the trace's number and status mark; Filament IV only (hidden under Classic). -->
            <span class="t-no" aria-hidden="true">{String(stepNo(segs, k)).padStart(2, "0")}</span>
            <span class="t-st" class:t-done={!!s.call.result && !s.call.result.is_error && !s.call.denied} class:t-bad={!!s.call.result?.is_error || !!s.call.denied}
              aria-hidden="true">{s.call.denied ? "⊘" : s.call.result ? (s.call.result.is_error ? "✕" : "✓") : "■"}</span>
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
          {@render list(s.call.children, depth + 1, s.call.id)}
        {/if}
        {#if depth === 0}
          {#each arrivedWith(s.call.id) as n (n.id)}
            <div class="arrived inline">
              <span class="arrived-label">{arrivedLabel(n)}</span>
              <span class="arrived-text">{n.text}</span>
            </div>
          {/each}
        {/if}
      {:else if s.kind === "thinking"}
        <details class="thought" use:keptOpen={{ key: `${foldBase}|thought:${path}:${k}` }}>
          <summary><span class="t-no" aria-hidden="true">{String(stepNo(segs, k)).padStart(2, "0")}</span><span class="t-st t-done" aria-hidden="true">✓</span>thought{s.ms != null ? ` · ${Math.round(s.ms / 1000)} s` : ""}</summary>
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
  /* Item 564 (Filament IV stage 5): each step numbered with its status mark,
     as the transcript's trace. Classic draws neither (its look, unchanged). */
  .t-no {
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--dim);
    flex: none;
    margin-right: 8px;
  }
  .t-st {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--signal);
    flex: none;
    width: 12px;
    margin-right: 6px;
  }
  .t-st.t-done {
    color: var(--done);
  }
  .t-st.t-bad {
    color: var(--failed);
  }
  :global([data-layout="classic"]) .t-no,
  :global([data-layout="classic"]) .t-st {
    display: none;
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
  .waiting {
    margin-left: 0.4em;
    color: var(--dim);
    font-size: 12px;
  }
  /* A note that reached the running agent (backlog 295): his words, on his
     side like a question, with when and on which call. */
  .arrived {
    align-self: flex-end;
    max-width: 80%;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 12px;
    border-radius: 14px;
    background: var(--well);
    border: 1px solid var(--line);
    font-size: 13.5px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .arrived.inline {
    margin: 2px 0 4px;
  }
  .arrived-label {
    color: var(--dim);
    font-size: 11.5px;
  }
  .tell-main {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 6px;
    width: fit-content;
    cursor: pointer;
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
  /* Item 591 (Filament IV only: the markup below is drawn only when Classic
     is off, so Classic's look is the rules above, untouched). */
  .brief {
    margin: 4px 0 16px;
  }
  .brief summary {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    list-style: none;
    font-size: 12.5px;
    color: var(--ink2);
    padding: 4px 0;
  }
  .brief summary::-webkit-details-marker {
    display: none;
  }
  .brief-chev {
    flex: none;
    width: 10px;
    text-align: center;
    font-size: 12px;
    line-height: 1;
    color: var(--ink2);
    transition: transform 120ms;
  }
  .brief[open] .brief-chev {
    transform: rotate(90deg);
  }
  .brief-title {
    flex: none;
  }
  .brief-rule,
  .calls-rule {
    flex: 1;
    min-width: 12px;
    height: 1px;
    background: var(--line);
  }
  .brief-size {
    flex: none;
    font-size: 11px;
    color: var(--dim);
  }
  .brief-box {
    margin-top: 6px;
    overflow: auto;
    background: var(--well);
    border: 1px solid var(--line);
    border-bottom: none;
    border-radius: var(--r1, 6px) var(--r1, 6px) 0 0;
    overscroll-behavior: contain;
  }
  .brief-text {
    margin: 0;
    padding: 10px 12px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--ink2);
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* The drag handle: the box's bottom edge, a short grip mark in its middle. */
  .brief-grip {
    position: relative;
    height: 10px;
    cursor: row-resize;
    background: var(--well);
    border: 1px solid var(--line);
    border-top: 1px solid var(--line);
    border-radius: 0 0 var(--r1, 6px) var(--r1, 6px);
    touch-action: none;
  }
  .brief-grip::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 3px;
    width: 32px;
    height: 2px;
    margin-left: -16px;
    border-radius: 1px;
    background: var(--line2);
    transition: background-color 120ms;
  }
  .brief-grip:hover::after,
  .brief-grip.dragging::after,
  .brief-grip:focus-visible::after {
    background: var(--accent);
  }
  .brief-grip:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
  .calls-all {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px 0 0;
    font-size: 11px;
    color: var(--dim);
    letter-spacing: 0.02em;
  }
  .talk.f4 {
    margin-top: 10px;
    padding-top: 0;
    border-top: none;
  }
  .talk.f4:empty {
    display: none;
  }
  /* The composer: the main chat's card (raised fill, control edge, one
     shadow, the accent edge on focus), pinned to the tab's bottom. */
  :global(:where(:root:not([data-layout="classic"]))) .sub-view {
    padding-bottom: 16px;
  }
  .ask-card {
    position: sticky;
    bottom: 16px;
    z-index: 2;
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px 10px;
    background: var(--raised);
    border: 1px solid var(--line2);
    border-radius: var(--r2, 10px);
    /* The second shadow is the page under it: what scrolls past below the
       pinned card is hidden, as under the main box. 36px, not 17: WebKit
       measures `bottom` from inside .sub-view's 16px padding, so the gap
       under the pinned card is 32px there, plus rounding (rows showed through at zoom
       1.5); past the scroller's edge the extra paper is never seen. */
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.35),
      0 36px 0 0 var(--paper);
    transition: border-color 0.12s;
  }
  .ask-card:focus-within {
    border-color: var(--accent);
  }
  .ask-box {
    width: 100%;
    min-height: 1.5em;
    background: transparent;
    color: var(--ink);
    caret-color: var(--accent);
    border: none;
    padding: 2px 0;
    font: inherit;
    font-size: 14.5px;
    line-height: 1.5;
    resize: none;
    overflow-y: auto;
    overflow-x: hidden;
    box-sizing: border-box;
  }
  .ask-box:focus {
    outline: none;
  }
  .ask-box::placeholder {
    color: var(--dim);
  }
  .ask-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .ask-spacer {
    flex: 1;
  }
  .ask-hint {
    font-size: 12px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .ask-why {
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--dim);
    font: 600 10.5px var(--sans);
    line-height: 1;
    cursor: help;
  }
  .ask-why:hover,
  .ask-why:focus-visible {
    color: var(--ink);
    border-color: var(--dim);
    outline: none;
  }
  .ask-send {
    min-height: 32px;
    padding: 0 16px;
    font-size: 13px;
  }
  /* Tell main chat: the main box's bottom-row toggle — a chip with a
     sliding dot, accent when on. */
  .tell-chip {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 24px;
    padding: 0 9px 0 8px;
    border: 1px solid var(--line2);
    border-radius: 12px;
    background: var(--well);
    color: var(--ink2);
    font: 500 11.5px var(--sans);
    white-space: nowrap;
    cursor: pointer;
  }
  .tell-chip.on {
    color: var(--ink);
  }
  .tell-chip:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .tell-mark {
    position: relative;
    flex: none;
    width: 20px;
    height: 12px;
    border-radius: 6px;
    background: var(--well2);
    transition: background-color 120ms;
  }
  .tell-mark::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--dim);
    transition:
      left 120ms,
      background-color 120ms;
  }
  .tell-chip.on .tell-mark {
    background: var(--accent);
  }
  .tell-chip.on .tell-mark::after {
    left: 10px;
    background: var(--on-accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .brief-chev,
    .tell-mark,
    .tell-mark::after {
      transition: none;
    }
  }
</style>
