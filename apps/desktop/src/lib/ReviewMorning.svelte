<script lang="ts">
  /**
   * Review → Morning (3.2): the page, rendered as reading material, with a
   * page picker, the unread state and Mark read; beside it the review
   * verdict, Left unfinished, Open blockers and Next — pulled from the page's
   * own sections, since the runner writes them there — and the earlier pages.
   */
  import {
    app,
    latestShift,
    markMorningRead,
    morningIsRead,
    openMorning,
    openNote,
    selectBlocker,
    paneWidth,
    setPaneWidth,
  } from "./state.svelte";
  import * as api from "./api";
  import { renderMarkdown } from "./markdown";
  import { hhmm, mdSections, plain, sameMorning } from "./nightshift";
  import Grip from "./Grip.svelte";
  import Icon from "./Icon.svelte";

  const project = $derived(app.nightshift.selected);
  const page = $derived(app.nightshift.morning);
  const mornings = $derived(app.nightshift.mornings);
  const entry = $derived(
    page ? (mornings.find((m) => sameMorning(m.name, page.name)) ?? null) : null,
  );
  const unread = $derived(!!(project && page && !morningIsRead(project, page.name)));
  const sections = $derived(page ? mdSections(page.text) : new Map<string, string>());
  const leftUnfinished = $derived(sections.get("left unfinished") ?? "");
  const openBlockersMd = $derived(sections.get("open blockers") ?? "");
  const next = $derived(sections.get("next") ?? "");
  const openBlockers = $derived(
    (app.nightshift.blockers?.blockers ?? []).filter((b) => b.status === "open"),
  );

  let asideWidth = $state(paneWidth("morning.aside", 340));
  let picker = $state(false);

  /**
   * The review pass's verdict — the bold VERDICT line of the review note the
   * newest shift's status names. Read on demand; a shift with no review
   * note, or a note without that line, shows nothing rather than a guess.
   */
  const latest = $derived(latestShift());
  let verdict = $state<{ path: string; line: string | null } | null>(null);
  $effect(() => {
    const path = latest?.status?.review ?? null;
    const id = project;
    if (!path || !id) {
      verdict = null;
      return;
    }
    if (verdict?.path === path) return;
    verdict = { path, line: null };
    void api
      .nightshiftReadFile(id, path)
      .then((text) => {
        const m = /\*\*VERDICT:?\s*([^*]+)\*\*/i.exec(text);
        if (verdict?.path === path) verdict = { path, line: m ? m[1].trim() : "" };
      })
      .catch(() => {
        if (verdict?.path === path) verdict = { path, line: "" };
      });
  });
  const verdictOk = $derived(
    !!verdict?.line && /no material issues/i.test(verdict.line),
  );

  function goBlocker(id: string) {
    selectBlocker(id);
    app.nightshift.reviewTab = "blockers";
  }

  /**
   * The page lives at `mornings/<name>` under the contract root. The Notes
   * screen's tree only lists `notes/`, so this file won't be highlighted
   * there — `nightshift_read_file` reads any file under the root regardless,
   * so opening it still shows the text.
   */
  function openInNotes() {
    if (!page) return;
    app.nightshift.reviewTab = "notes";
    void openNote(`mornings/${page.name}`);
  }

  /** `#021` in a blockers section links to that blocker. */
  function blockerIdsIn(md: string): string[] {
    return Array.from(md.matchAll(/#(\d{3})\b/g), (m) => m[1]);
  }
  const mentioned = $derived(blockerIdsIn(openBlockersMd));
</script>

<div class="morning" style:grid-template-columns="minmax(0,1fr) 7px {asideWidth}px">
  <div class="pagecol">
    {#if !page}
      <p class="hint">No morning page yet for this project.</p>
    {:else}
      <div class="bar">
        <div class="picker">
          <button class="ns-chip mono pick" onclick={() => (picker = !picker)} aria-expanded={picker}>
            {page.name}<Icon name="chev" />
          </button>
          {#if picker}
            <button class="scrim" aria-label="Close" onclick={() => (picker = false)}></button>
            <div class="menu ns-card">
              {#each mornings as m (m.name)}
                <button
                  class="item"
                  class:on={sameMorning(m.name, page.name)}
                  onclick={() => { picker = false; void openMorning(m.name); }}
                >
                  <span class="ns-mono">{m.name}</span>
                  {#if project && !morningIsRead(project, m.name)}<span class="ns-pill open tiny">new</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        {#if unread}
          <span class="ns-pill open"><span class="dot"></span>unread{#if entry?.modified} · written {hhmm(entry.modified)}{/if}</span>
        {:else}
          <span class="ns-pill grey">read{#if entry?.modified} · written {hhmm(entry.modified)}{/if}</span>
        {/if}
        <span class="spacer"></span>
        <button class="ns-btn ghost small" onclick={openInNotes}>Open in Notes</button>
        {#if unread}
          <button class="ns-btn ghost small" onclick={() => markMorningRead(page.name)}>Mark read</button>
        {/if}
      </div>
      <div class="scroll">
        <div class="ns-prose body">{@html renderMarkdown(page.text)}</div>
      </div>
    {/if}
  </div>
  <Grip width={asideWidth} min={260} max={520} edge="right" onchange={(w) => { asideWidth = w; setPaneWidth("morning.aside", w); }} />
  <aside class="aside">
    {#if verdict && verdict.line !== null}
      <div class="ns-card review" class:ok={verdictOk}>
        <div class="ns-k">Review pass · fresh context</div>
        <div class="verdict">{verdict.line || "verdict line not found"}</div>
        <span class="ns-mono path">{verdict.path}</span>
      </div>
    {/if}
    {#if leftUnfinished}
      <div>
        <div class="ns-k mb">Left unfinished</div>
        <div class="ns-card block md">{@html renderMarkdown(leftUnfinished)}</div>
      </div>
    {/if}
    <div>
      <div class="ns-k mb">Open blockers · {openBlockers.length}</div>
      {#if openBlockers.length === 0}
        <div class="ns-card block dim">None open.</div>
      {:else}
        <div class="stack">
          {#each openBlockers as b (b.id)}
            <button class="ns-card block link" class:mentioned={mentioned.includes(b.id)} onclick={() => goBlocker(b.id)}>
              <span class="ns-mono id">#{b.id}</span> {plain(b.question)}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    {#if next}
      <div>
        <div class="ns-k mb">Next</div>
        <div class="md dim">{@html renderMarkdown(next)}</div>
      </div>
    {/if}
    {#if mornings.length > 1}
      <div class="earlier">
        <div class="ns-k mb">Earlier pages</div>
        <div class="stack tight">
          {#each mornings.filter((m) => !sameMorning(m.name, page?.name ?? null)) as m (m.name)}
            <button class="ns-link ns-mono earlier-item" onclick={() => void openMorning(m.name)}>{m.name}</button>
          {/each}
        </div>
      </div>
    {/if}
  </aside>
</div>

<style>
  .morning {
    flex: 1;
    min-height: 0;
    display: grid;
    overflow: hidden;
  }
  .pagecol {
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 26px 0 0 56px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 48px 18px 0;
    flex: none;
  }
  .picker {
    position: relative;
  }
  .pick {
    cursor: pointer;
    font-family: var(--mono);
  }
  .pick:hover {
    border-color: var(--dim);
  }
  .scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    z-index: 10;
    cursor: default;
  }
  .menu {
    position: absolute;
    top: 30px;
    left: 0;
    z-index: 11;
    min-width: 220px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    max-height: 320px;
    overflow-y: auto;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.4);
  }
  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 7px 10px;
    border: none;
    background: transparent;
    color: var(--ink);
    border-radius: 6px;
    cursor: pointer;
    font-size: 12.5px;
  }
  .item:hover {
    background: var(--well);
  }
  .item.on {
    background: var(--well);
  }
  .tiny {
    padding: 0 6px;
    font-size: 10px;
  }
  .spacer {
    flex: 1;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
    flex: 1;
    padding: 0 48px 48px 0;
  }
  .body {
    max-width: 680px;
  }
  .hint {
    margin: 0;
    padding: 26px 48px;
    font-size: 13px;
    color: var(--dim);
  }

  .aside {
    border-left: 1px solid var(--line);
    background: var(--sheet);
    padding: 26px 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    overflow-y: auto;
    min-height: 0;
    font-size: 13px;
  }
  .review {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .review.ok {
    background: var(--done-soft);
    border-color: #2f4a35;
  }
  .review.ok .ns-k,
  .review.ok .verdict {
    color: var(--done);
  }
  .verdict {
    font-weight: 600;
  }
  .path {
    font-size: 11.5px;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  .mb {
    margin-bottom: 8px;
  }
  .block {
    padding: 10px 12px;
    background: var(--paper);
    color: var(--ink);
    line-height: 1.45;
  }
  .block.dim {
    color: var(--dim);
  }
  .block.link {
    text-align: left;
    width: 100%;
    font: inherit;
    cursor: pointer;
    padding: 9px 12px;
  }
  .block.link:hover {
    border-color: var(--line2);
  }
  .id {
    color: var(--dim);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .stack.tight {
    gap: 3px;
    align-items: flex-start;
  }
  .md :global(p) {
    margin: 0 0 6px;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(ul),
  .md :global(ol) {
    margin: 0;
    padding-left: 1.2em;
  }
  .md :global(code) {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--well);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .md.dim {
    color: var(--ink2);
  }
  .earlier {
    margin-top: auto;
  }
  .earlier-item {
    font-size: 12px;
    color: var(--dim);
  }
  .earlier-item:hover {
    color: var(--accent);
  }
</style>
