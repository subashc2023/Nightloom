<script lang="ts">
  /**
   * Review → Blockers (3.4): open first, then the rest; the selected
   * blocker's question, the unit's guess, what it blocks, and an answer box
   * with "Use the unit's guess". The right column: where the guess lives
   * (with Open, which reads the file through the backend and shows it), the
   * follow-up item, the file. Answering writes `## Answer` and flips the
   * status — the two edits the contract gives the GUI.
   */
  import {
    answerBlocker,
    app,
    paneWidth,
    selectBlocker,
    setPaneWidth,
  } from "./state.svelte";
  import * as api from "./api";
  import { renderMarkdown } from "./markdown";
  import { pillClass, plain } from "./nightshift";
  import Grip from "./Grip.svelte";
  import Icon from "./Icon.svelte";

  const list = $derived(app.nightshift.blockers?.blockers ?? []);
  const errors = $derived(app.nightshift.blockers?.errors ?? []);
  const open = $derived(list.filter((b) => b.status === "open"));
  const rest = $derived(list.filter((b) => b.status !== "open"));
  const blocker = $derived(
    list.find((b) => b.id === app.nightshift.selectedBlocker) ?? null,
  );

  let listWidth = $state(paneWidth("blockers.list", 320));
  let asideWidth = $state(paneWidth("blockers.aside", 300));

  let answer = $state("");
  let busy = $state(false);
  let answered = $state<string | null>(null);
  // A fresh box per blocker.
  $effect(() => {
    void blocker?.id;
    answer = "";
  });

  async function submit() {
    if (!blocker || !answer.trim()) return;
    busy = true;
    const ok = await answerBlocker(blocker.id, answer.trim());
    busy = false;
    if (ok) answered = blocker.id;
  }

  /** The paths named under "Where the guess lives", one per line. */
  const places = $derived.by(() => {
    if (!blocker?.where_guess_lives) return [];
    return blocker.where_guess_lives
      .split("\n")
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter((l) => l.length > 0);
  });

  /** The path at the head of a line like `bin/nightshift.sh · ALLOWED_TOOLS`. */
  function pathOf(line: string): string | null {
    const m = /^`?([\w./~-]+\/[\w./~-]+|[\w-]+\.[\w.]+)`?/.exec(line);
    return m ? m[1] : null;
  }

  let file = $state<{ path: string; text: string | null; error: string | null } | null>(null);
  async function openFile(path: string) {
    const id = app.nightshift.selected;
    if (!id) return;
    file = { path, text: null, error: null };
    try {
      const text = await api.nightshiftReadFile(id, path);
      if (file?.path === path) file = { path, text, error: null };
    } catch (e) {
      if (file?.path === path) file = { path, text: null, error: String(e) };
    }
  }

  const followUpLine = $derived.by(() => {
    if (!blocker) return "";
    if (blocker.follow_up) return `follow-up item ${blocker.follow_up}`;
    return "";
  });
</script>

<div class="blockers" style:grid-template-columns="{listWidth}px 7px minmax(0,1fr) 7px {asideWidth}px">
  <div class="list-col">
    {#if list.length === 0 && errors.length === 0}
      <p class="hint">No blockers — nothing under blockers/.</p>
    {:else}
      <div class="scroll">
        <div class="ns-side-h first">Open · {open.length}</div>
        {#if open.length === 0}
          <p class="hint">None open.</p>
        {:else}
          <div class="ns-list">
            {#each open as b (b.id)}
              <button class="ns-row blk" class:on={b.id === blocker?.id} onclick={() => selectBlocker(b.id)}>
                <span class="line1">
                  <span class="ns-mono id">#{b.id}</span>
                  <span class="ns-pill {pillClass(b.status)}">{b.status}</span>
                </span>
                <span class="q">{plain(b.question)}</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if rest.length > 0}
          <div class="ns-side-h">Answered · {rest.length}</div>
          <div class="ns-list">
            {#each rest as b (b.id)}
              <button class="ns-row blk" class:on={b.id === blocker?.id} onclick={() => selectBlocker(b.id)}>
                <span class="line1">
                  <span class="ns-mono id">#{b.id}</span>
                  <span class="ns-pill {pillClass(b.status)}">{b.status}</span>
                </span>
                <span class="q">{plain(b.question)}</span>
                {#if b.follow_up}
                  <span class="extra" class:done={b.status === "applied"}>follow-up item {b.follow_up}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
        {#each errors as e (e)}
          <p class="hint err">{e}</p>
        {/each}
      </div>
    {/if}
  </div>
  <Grip width={listWidth} min={240} max={520} edge="left" onchange={(w) => { listWidth = w; setPaneWidth("blockers.list", w); }} />

  <div class="main">
    {#if !blocker}
      <p class="hint">Select a blocker.</p>
    {:else}
      <div class="head">
        <span class="ns-mono id">#{blocker.id}</span>
        <span class="ns-pill {pillClass(blocker.status)}"><span class="dot"></span>{blocker.status}</span>
        <span class="meta">
          {#if blocker.raised}raised {blocker.raised}{/if}
          {#if blocker.shift} · by shift <span class="ns-mono">{blocker.shift}</span>{/if}
          {#if blocker.item} · item <span class="ns-mono">{blocker.item}</span>{/if}
        </span>
      </div>
      <div class="ns-prose question">{@html renderMarkdown(blocker.question)}</div>

      {#if blocker.guess}
        <div class="ns-card guess">
          <div class="ns-k">What the unit would have done, and why</div>
          <div class="ns-prose small">{@html renderMarkdown(blocker.guess)}</div>
        </div>
      {/if}

      {#if blocker.blocks}
        <div>
          <div class="ns-k mb">What it blocks</div>
          <div class="ns-prose small dim">{@html renderMarkdown(blocker.blocks)}</div>
        </div>
      {/if}

      {#if blocker.status === "open"}
        <div class="answer">
          <div class="ns-k">Your answer</div>
          <textarea
            class="ns-fld"
            bind:value={answer}
            placeholder="One word usually does. This becomes the blocker's ## Answer and flips it to answered; the next shift turns it into a follow-up item at the head of the order."
          ></textarea>
          <div class="actions">
            <button class="ns-btn accent" disabled={!answer.trim() || busy} onclick={() => void submit()}>
              <Icon name="check" />{busy ? "Writing…" : "Answer"}
            </button>
            <button class="ns-btn" disabled={!blocker.guess || busy} onclick={() => (answer = blocker!.guess)}>
              Use the unit's guess
            </button>
          </div>
        </div>
      {:else}
        <div class="answer">
          <div class="ns-k">Answer{#if answered === blocker.id} · written{/if}</div>
          {#if blocker.answer}
            <div class="ns-prose small">{@html renderMarkdown(blocker.answer)}</div>
          {:else}
            <p class="hint nopad">No answer text recorded.</p>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
  <Grip width={asideWidth} min={220} max={480} edge="right" onchange={(w) => { asideWidth = w; setPaneWidth("blockers.aside", w); }} />

  <aside class="aside">
    {#if blocker}
      <div>
        <div class="ns-k mb">Where the guess lives</div>
        {#if places.length === 0}
          <div class="ns-card note-card dim-text">Not named — a research blocker; a build blocker names the flag or constant.</div>
        {:else}
          <div class="places">
            {#each places as p (p)}
              {@const path = pathOf(p)}
              <div class="ns-card place">
                <span class="ns-mono path">{p}</span>
                {#if path}
                  <button class="ns-btn small" onclick={() => void openFile(path)}>Open</button>
                {/if}
              </div>
            {/each}
          </div>
          <div class="note">A build blocker names the flag or constant; Open reads the file as it is now.</div>
        {/if}
      </div>
      <div>
        <div class="ns-k mb">Follow-up</div>
        <div class="ns-card note-card dim-text">
          {#if followUpLine}
            {followUpLine}
          {:else if blocker.status === "open"}
            None yet — created by the next shift's preflight once this is answered, at the head of <span class="ns-mono">order.json</span>.
          {:else}
            None recorded.
          {/if}
        </div>
      </div>
      <div class="file">
        file: <span class="ns-mono">{blocker.file}</span>
      </div>
    {/if}
  </aside>
</div>

{#if file}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) file = null;
    }}
  >
    <div class="ns-card viewer" role="dialog" aria-modal="true" tabindex="-1">
      <div class="viewer-h">
        <span class="ns-mono">{file.path}</span>
        <span class="spacer"></span>
        <button class="ns-btn small" onclick={() => (file = null)}>Close</button>
      </div>
      {#if file.error}
        <p class="hint err">{file.error}</p>
      {:else if file.text === null}
        <p class="hint">Reading…</p>
      {:else}
        <pre class="viewer-body">{file.text}</pre>
      {/if}
    </div>
  </div>
{/if}

<style>
  .blockers {
    flex: 1;
    min-height: 0;
    display: grid;
    overflow: hidden;
    position: relative;
  }
  .list-col {
    border-right: 1px solid var(--line);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
    padding-bottom: 12px;
  }
  .ns-side-h.first {
    padding-top: 18px;
  }
  .blk {
    padding: 10px 12px;
    gap: 3px;
  }
  .line1 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .id {
    color: var(--dim);
    font-size: 12px;
  }
  .q {
    white-space: normal;
    font-size: 13px;
    line-height: 1.35;
    margin-top: 2px;
  }
  .extra {
    font-size: 11.5px;
    color: var(--dim);
    margin-top: 4px;
  }
  .extra.done {
    color: var(--done);
  }
  .hint {
    margin: 0;
    font-size: 13px;
    color: var(--dim);
    padding: 12px 20px;
  }
  .hint.nopad {
    padding: 0;
  }
  .hint.err {
    color: var(--failed);
    font-family: var(--mono);
    font-size: 12px;
  }

  .main {
    overflow-y: auto;
    padding: 26px 36px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-height: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .meta {
    color: var(--dim);
    font-size: 13px;
  }
  .question {
    font-size: 19px;
    line-height: 1.45;
  }
  .guess {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ns-prose.small {
    font-size: 15px;
  }
  .ns-prose.dim {
    color: var(--ink2);
  }
  .mb {
    margin-bottom: 6px;
  }
  .answer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: auto;
  }
  .actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .aside {
    border-left: 1px solid var(--line);
    background: var(--sheet);
    padding: 26px 22px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    font-size: 13px;
    overflow-y: auto;
    min-height: 0;
  }
  .places {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .place {
    padding: 8px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--paper);
  }
  .place .path {
    font-size: 12px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .note-card {
    padding: 10px 12px;
    background: var(--paper);
  }
  .dim-text {
    color: var(--dim);
    line-height: 1.45;
  }
  .note {
    color: var(--dim);
    font-size: 12px;
    margin-top: 6px;
  }
  .file {
    margin-top: auto;
    color: var(--dim);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    z-index: 25;
  }
  .viewer {
    width: min(900px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-color: var(--line2);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .viewer-h {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    font-size: 12.5px;
  }
  .spacer {
    flex: 1;
  }
  .viewer-body {
    margin: 0;
    padding: 12px 14px;
    overflow: auto;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--ink2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
