<script lang="ts">
  /**
   * The chat's contents (item 799): a small "Contents" button at the
   * transcript's top right that opens the list of its chapters, each a jump
   * to its divider. A chat that continues another by hand-off (`forked_from`
   * with `reason: "handoff"`, backlog 086) lists the earlier chats'
   * chapters first, under each chat's name, up the chain: a click opens that
   * chat at the chapter. Each of this chat's chapters can be renamed (Reset
   * name undoes it) and removed; removed ones wait under Removed with Restore.
   *
   * Shown once a chat has a chapter past its start, or continues another.
   * Whether it is open is kept per chat for the session (item 495).
   */
  import { onDestroy } from "svelte";
  import { tip } from "./tip";
  import { clock } from "./home";
  import { app, liveFlags, openSession } from "./state.svelte";
  import { peekSession } from "./api";
  import { chaptersOf, currentChapter } from "./chapters";
  import { editsFor, renameChapter, setChapterRemoved, withEdits, type ShownChapter } from "./chapterEdits.svelte";
  import { requestChapterJump } from "./chapterJump.svelte";
  import { keptGet, keptSet } from "./keptFolds.svelte";
  import type { SessionEvent } from "./types";

  let {
    chapters,
    chat,
    viewport = null,
    classic = false,
    onjump,
  }: {
    chapters: readonly ShownChapter[];
    chat: string | null;
    /** The transcript's scroller: where the view is, for the chapter it is in. */
    viewport?: HTMLElement | null;
    classic?: boolean;
    onjump: (c: ShownChapter) => void;
  } = $props();

  /** Chats up the hand-off chain, nearest first, at most this many. */
  const CHAIN_MAX = 6;

  const openKey = $derived(chat ? `chapters.open:${chat}` : null);
  const open = $derived(openKey ? keptGet(openKey, false) : false);
  function setOpen(v: boolean) {
    if (v) current = locate();
    if (openKey) keptSet(openKey, v, false);
  }

  /** The chain's chats, nearest first: id and name. */
  const chain = $derived.by(() => {
    const out: { id: string; name: string }[] = [];
    let id = chat;
    const seen = new Set<string>();
    while (id && out.length < CHAIN_MAX) {
      seen.add(id);
      const s = app.sessions.find((x) => x.id === id);
      const from = s?.forked_from;
      if (!from || from.reason !== "handoff" || seen.has(from.session)) break;
      const prev = app.sessions.find((x) => x.id === from.session);
      out.push({ id: from.session, name: prev?.title ?? prev?.first_user ?? "An earlier chat" });
      id = from.session;
    }
    return out;
  });

  /** Earlier chats' logs, read when the list first opens (never on draw). */
  let earlierLogs = $state<Record<string, SessionEvent[] | "failed" | "loading">>({});
  $effect(() => {
    if (!open) return;
    for (const c of chain) {
      if (earlierLogs[c.id] !== undefined) continue;
      earlierLogs = { ...earlierLogs, [c.id]: "loading" };
      peekSession(c.id)
        .then((evs) => (earlierLogs = { ...earlierLogs, [c.id]: evs }))
        .catch(() => (earlierLogs = { ...earlierLogs, [c.id]: "failed" }));
    }
  });
  const earlier = $derived(
    chain
      .map((c) => {
        const log = earlierLogs[c.id];
        const list = Array.isArray(log) ? withEdits(chaptersOf(log, liveFlags(log)), editsFor(c.id, log)).filter((x) => !x.removed) : [];
        return { ...c, chapters: list, failed: log === "failed", loading: log === "loading" || log === undefined };
      })
      .reverse(),
  );

  const shown = $derived(chapters.filter((c) => !c.removed));

  /** The chapter the view is in when the list opens: the last whose place is at or above the view's top.
   *  One above the render window is not drawn, and counts as above. */
  let current = $state<string | null>(null);
  function locate(): string | null {
    const vp = viewport;
    if (!vp) return null;
    const base = vp.getBoundingClientRect().top - vp.scrollTop;
    const tops = shown.map((c) => {
      const sel = c.kind === "hand_off" ? `[data-hand-off="${c.index}"]` : c.kind === "start" ? null : `[data-chapter="${c.key}"]`;
      if (sel === null) return -Infinity;
      const el = vp.querySelector<HTMLElement>(sel);
      return el ? el.getBoundingClientRect().top - base : -Infinity;
    });
    const at = currentChapter(tops, vp.scrollTop + 48);
    return at === null ? null : shown[at].key;
  }
  const removed = $derived(chapters.filter((c) => c.removed));
  const visible = $derived(shown.length > 1 || chain.length > 0);

  let editing = $state<string | null>(null);
  let draft = $state("");
  function finish(c: ShownChapter) {
    if (editing !== c.key) return;
    if (chat) renameChapter(chat, c, draft);
    editing = null;
  }
  function focusSelect(el: HTMLInputElement) {
    el.focus();
    el.select();
  }

  let box = $state<HTMLElement | null>(null);
  const onDown = (e: PointerEvent) => {
    if (open && box && !box.contains(e.target as Node)) {
      if (editing) {
        const c = chapters.find((x) => x.key === editing);
        if (c) finish(c);
      }
      setOpen(false);
    }
  };
  window.addEventListener("pointerdown", onDown, true);
  onDestroy(() => window.removeEventListener("pointerdown", onDown, true));

  function goEarlier(id: string, key: string) {
    requestChapterJump(id, key);
    setOpen(false);
    void openSession(id);
  }
</script>

{#if visible}
  <div class="contents" class:classic class:open bind:this={box}>
    <button
      class="ct-btn"
      aria-expanded={open}
      aria-label="Contents: this chat's chapters"
      use:tip={open ? "" : `${shown.length} chapter${shown.length === 1 ? "" : "s"}${chain.length ? ` · ${chain.length} earlier chat${chain.length === 1 ? "" : "s"}` : ""}\nJump to a phase of the chat`}
      onclick={() => setOpen(!open)}
    >
      <svg class="ct-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h7M3 12h9" /></svg>
      <span>Contents</span>
    </button>
    {#if open}
      <div class="ct-list" role="menu">
        {#each earlier as e (e.id)}
          <div class="ct-head">Earlier chat · {e.name}</div>
          {#if e.failed}
            <div class="ct-note">Its log could not be read.</div>
          {:else if e.loading}
            <div class="ct-note">Reading…</div>
          {:else if e.chapters.length === 0}
            <button class="ct-row earlier" role="menuitem" onclick={() => goEarlier(e.id, "start")}>Open it</button>
          {:else}
            {#each e.chapters as c (c.key)}
              <button class="ct-row earlier" role="menuitem" onclick={() => goEarlier(e.id, c.key)}>
                <span class="ct-title">{c.shown}</span>{#if c.at}<span class="ct-at">{clock(c.at)}</span>{/if}
              </button>
            {/each}
          {/if}
        {/each}
        {#if earlier.length}<div class="ct-head">This chat</div>{/if}
        {#each shown as c (c.key)}
          {#if editing === c.key}
            <input
              class="ct-input"
              aria-label="Chapter name"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              bind:value={draft}
              use:focusSelect
              onkeydown={(ev) => {
                if (ev.key === "Enter" || ev.key === "Escape") {
                  ev.preventDefault();
                  ev.stopPropagation();
                  finish(c);
                }
              }}
              onblur={() => finish(c)}
            />
          {:else}
            <div class="ct-item" class:current={current === c.key}>
              <button
                class="ct-row"
                role="menuitem"
                onclick={() => {
                  setOpen(false);
                  onjump(c);
                }}
              >
                <span class="ct-title">{c.shown}</span>{#if c.at}<span class="ct-at">{clock(c.at)}</span>{/if}
              </button>
              {#if chat}
                <span class="ct-acts">
                  <button
                    class="ct-act"
                    aria-label={`Rename ${c.shown}`}
                    use:tip={"Rename"}
                    onclick={() => {
                      draft = c.shown;
                      editing = c.key;
                    }}>✎</button
                  >
                  {#if c.renamed}
                    <button class="ct-act" aria-label={`Reset name of ${c.shown}`} use:tip={`Reset name\n${c.title}`} onclick={() => chat && renameChapter(chat, c, "")}>↺</button>
                  {/if}
                  {#if c.kind !== "start"}
                    <button class="ct-act" aria-label={`Remove ${c.shown}`} use:tip={"Remove\nRestore it under Removed"} onclick={() => chat && setChapterRemoved(chat, c, true)}>×</button>
                  {/if}
                </span>
              {/if}
            </div>
          {/if}
        {/each}
        {#if removed.length}
          <div class="ct-head">Removed</div>
          {#each removed as c (c.key)}
            <div class="ct-item gone">
              <span class="ct-title">{c.shown}</span>
              <button class="ct-restore" onclick={() => chat && setChapterRemoved(chat, c, false)}>Restore</button>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .contents {
    position: absolute;
    top: 10px;
    right: 18px;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    pointer-events: none;
  }
  .contents > * {
    pointer-events: auto;
  }
  .ct-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--sheet);
    color: var(--ink2);
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    cursor: pointer;
    opacity: 0.85;
  }
  .classic .ct-btn {
    font-family: var(--sans);
    font-size: 12px;
    letter-spacing: 0;
  }
  .ct-btn:hover,
  .open .ct-btn {
    opacity: 1;
    color: var(--ink);
    border-color: var(--line);
  }
  .ct-ico {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  .ct-list {
    margin-top: 6px;
    width: min(360px, 70vw);
    max-height: min(440px, 60vh);
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: var(--sheet);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
  }
  .ct-head {
    padding: 8px 8px 4px;
    font-family: var(--mono);
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .classic .ct-head {
    font-family: var(--sans);
    font-size: 11.5px;
    letter-spacing: 0;
    text-transform: none;
  }
  .ct-note {
    padding: 4px 8px 8px;
    font-size: 12.5px;
    color: var(--dim);
  }
  .ct-item {
    display: flex;
    align-items: center;
    border-radius: 6px;
  }
  .ct-item:hover {
    background: color-mix(in srgb, var(--ink) 6%, transparent);
  }
  .ct-item.current {
    box-shadow: inset 2px 0 0 var(--accent-ink);
  }
  .ct-row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .ct-row.earlier {
    width: 100%;
    color: var(--accent-ink);
  }
  .ct-row.earlier:hover {
    background: color-mix(in srgb, var(--ink) 6%, transparent);
  }
  .ct-title {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gone .ct-title {
    padding: 6px 8px;
    color: var(--dim);
    font-size: 13px;
  }
  .ct-at {
    flex: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  .ct-acts {
    display: flex;
    gap: 2px;
    padding-right: 4px;
    opacity: 0;
  }
  .ct-item:hover .ct-acts,
  .ct-item:focus-within .ct-acts {
    opacity: 1;
  }
  .ct-act,
  .ct-restore {
    border: none;
    background: none;
    color: var(--dim);
    font: inherit;
    font-size: 12.5px;
    padding: 2px 6px;
    border-radius: 5px;
    cursor: pointer;
  }
  .ct-act:hover,
  .ct-restore:hover {
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 8%, transparent);
  }
  .ct-restore {
    color: var(--accent-ink);
    margin-right: 4px;
  }
  .ct-input {
    width: 100%;
    box-sizing: border-box;
    margin: 2px 0;
    font: inherit;
    font-size: 13px;
    padding: 5px 8px;
    border: 1px solid var(--accent-ink);
    border-radius: 6px;
    background: var(--bg);
    color: var(--ink);
  }
</style>
