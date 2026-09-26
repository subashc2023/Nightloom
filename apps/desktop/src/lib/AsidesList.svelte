<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { app, asideInTab } from "./state.svelte";
  import type { Aside } from "./state.svelte";
  import Icon from "./Icon.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { tip } from "./tip";
  import { relativeTime, exactTime } from "./time";
  import { quoteSnippet, type PastAside } from "./asideHistory";
  import { deletePastAside, pastAsides, pastOf, reopenPast } from "./asideHistory.svelte";

  /**
   * A chat's asides at a glance (nightshift item 229, night batch B,
   * 2026-09-26 — his "a little spot somewhere on each page, if there are
   * asides on that page, you can click on it to just look at all of the
   * asides that are currently open… or maybe even a view of past asides").
   *
   * A small pill at the transcript's top-right (blocker 470), drawn only
   * when the open chat has asides, open or past: the asides glyph and the
   * open count, and the past count beside it. A click opens a popover
   * under it (blocker 473): *Open (n)* — each card's quote, first question
   * and number of exchanges; a click brings its card to its passage — then
   * *Past (n)* — each closed thread's quote, first question and when it was
   * closed; a click reopens it as a card, whole. Delete on a past row asks
   * first (practices §7). Escape or a click outside closes the popover.
   *
   * Fixed over the viewport (the transcript scrolls under it), clear of
   * the Navigator strip on the viewport's right edge.
   */
  let {
    viewport,
    onbring,
  }: {
    viewport: HTMLElement | null;
    /** Bring the open chat's card `id` to its passage (the layer's). */
    onbring: (id: number) => void;
  } = $props();

  const session = $derived(app.activeSessionId);
  const open = $derived(app.asides);
  const past = $derived([...pastOf(session)].reverse());
  const shown = $derived(session !== null && (open.length > 0 || past.length > 0));

  let listOpen = $state(false);
  let now = $state(Date.now());
  let confirming = $state<PastAside | null>(null);
  let pos = $state<{ top: number; right: number } | null>(null);
  let pill = $state<HTMLElement | null>(null);
  let pop = $state<HTMLElement | null>(null);

  function measure(): void {
    const vp = viewport;
    if (!vp) {
      pos = null;
      return;
    }
    const r = vp.getBoundingClientRect();
    // 26 px in from the viewport's right: the Navigator strip (16 px at
    // right 3) and the scroll bar stay clear.
    pos = { top: r.top + 8, right: Math.max(8, window.innerWidth - r.right + 26) };
  }

  $effect(() => {
    const vp = viewport;
    void shown;
    measure();
    if (!vp || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    return () => ro.disconnect();
  });
  // The list closes itself when the chat changes or has no asides left.
  $effect(() => {
    void session;
    listOpen = false;
    confirming = null;
  });
  $effect(() => {
    if (!shown) listOpen = false;
  });

  function toggle(): void {
    now = Date.now();
    listOpen = !listOpen;
  }

  function firstQuestion(a: { turns: { question: string }[] }): string {
    return a.turns[0]?.question.trim() || "Not asked yet";
  }

  function openState(a: Aside): string {
    if (asideInTab(session, a.id)) return "in a tab";
    if (a.draft) return "not asked yet";
    const n = a.turns.length;
    const s = `${n} ${n === 1 ? "exchange" : "exchanges"}`;
    return a.folded ? `${s} · folded` : s;
  }

  function bring(a: Aside): void {
    if (asideInTab(session, a.id)) return;
    listOpen = false;
    onbring(a.id);
  }

  function reopen(p: PastAside): void {
    const a = reopenPast(p.key);
    listOpen = false;
    if (a) onbring(a.id);
  }

  function reallyDelete(): void {
    const p = confirming;
    confirming = null;
    if (p && session !== null) deletePastAside(session, p.key, () => true);
  }

  /** Escape: the confirm first, then the list — caught before the card's
   *  own window handler (capture), so one Escape closes one thing and a
   *  card is not dismissed behind the list. */
  function keys(e: KeyboardEvent): void {
    if (e.key !== "Escape" || (!listOpen && !confirming)) return;
    e.preventDefault();
    e.stopPropagation();
    if (confirming) confirming = null;
    else listOpen = false;
  }
  function outside(e: PointerEvent): void {
    if (!listOpen || confirming) return;
    const t = e.target as Node | null;
    if (t && (pill?.contains(t) || pop?.contains(t))) return;
    listOpen = false;
  }
  onMount(() => {
    window.addEventListener("keydown", keys, true);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", measure);
  });
  onDestroy(() => {
    if (typeof window === "undefined") return;
    window.removeEventListener("keydown", keys, true);
    window.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("resize", measure);
  });

  const pruned = $derived(session === null ? 0 : (pastAsides.pruned[session] ?? 0));
</script>

{#if shown && pos}
  <button
    class="asides-pill"
    class:on={listOpen}
    bind:this={pill}
    style:top="{pos.top}px"
    style:right="{pos.right}px"
    aria-haspopup="dialog"
    aria-expanded={listOpen}
    use:tip={`This chat's asides: ${open.length} open, ${past.length} past — click to list them`}
    onclick={toggle}
  >
    <Icon name="moon" size={13} />
    <span class="n">{open.length}</span>
    {#if past.length > 0}<span class="past-n">· {past.length} past</span>{/if}
  </button>
  {#if listOpen}
    <div
      class="asides-list ns-card"
      bind:this={pop}
      role="dialog"
      aria-label="This chat's asides"
      style:top="{pos.top + 34}px"
      style:right="{pos.right}px"
    >
      <div class="sec">Open ({open.length})</div>
      {#each open as a (a.id)}
        <button class="row" disabled={asideInTab(session, a.id)} onclick={() => bring(a)}>
          <span class="q">{quoteSnippet(a.quote?.text)}</span>
          <span class="ask">{firstQuestion(a)}</span>
          <span class="meta">{openState(a)}</span>
        </button>
      {:else}
        <div class="none">No aside open on this chat.</div>
      {/each}
      <div class="sec">Past ({past.length})</div>
      {#each past as p (p.key)}
        <div class="past-row">
          <button class="row" onclick={() => reopen(p)} use:tip={`Reopen this aside under its passage, thread intact (closed ${exactTime(new Date(p.closedAt).toISOString())})`}>
            <span class="q">{quoteSnippet(p.thread.quote?.text)}</span>
            <span class="ask">{firstQuestion(p.thread)}</span>
            <span class="meta"
              >closed {relativeTime(new Date(p.closedAt).toISOString(), now)}</span
            >
          </button>
          <button class="del" aria-label="Delete this past aside" use:tip={"Delete this past aside for good (asks first)"} onclick={() => (confirming = p)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
      {:else}
        <div class="none">Closed asides land here, reopenable.</div>
      {/each}
      {#if pruned > 0}<div class="none">{pruned} older removed — the list keeps 50.</div>{/if}
    </div>
  {/if}
{/if}

{#if confirming}
  <ConfirmDialog
    title="Delete this past aside?"
    lead="The thread — its questions and answers — is removed for good; it cannot be reopened after this."
    facts={[
      ["passage", quoteSnippet(confirming.thread.quote?.text, 50)],
      ["asked", firstQuestion(confirming.thread)],
    ]}
    confirmLabel="Delete"
    onconfirm={reallyDelete}
    onclose={() => (confirming = null)}
  />
{/if}

<style>
  .asides-pill {
    position: fixed;
    z-index: 9;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--sheet);
    color: var(--ink2);
    font: 12px var(--sans);
    cursor: pointer;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.08);
  }
  .asides-pill:hover,
  .asides-pill.on {
    border-color: var(--accent);
    color: var(--ink);
  }
  .n {
    font-weight: 600;
  }
  .past-n {
    color: var(--dim);
  }
  .asides-list {
    position: fixed;
    z-index: 11;
    width: 340px;
    max-width: calc(100vw - 32px);
    max-height: 60vh;
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--line2);
    border-radius: 10px;
    background: var(--sheet);
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.16);
    font: 13px var(--sans);
  }
  .sec {
    padding: 8px 8px 4px;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .row {
    display: grid;
    gap: 2px;
    width: 100%;
    min-width: 0;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .row:hover:not(:disabled) {
    background: var(--accent-soft);
  }
  .row:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .q,
  .ask {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .q {
    font-family: var(--serif);
    font-style: italic;
    color: var(--ink2);
  }
  .meta {
    font-size: 11px;
    color: var(--dim);
  }
  .past-row {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .past-row .row {
    flex: 1;
  }
  .del {
    flex: none;
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--dim);
    cursor: pointer;
  }
  .del:hover {
    background: var(--del-bg);
    color: var(--del-fg);
  }
  .none {
    padding: 4px 8px 8px;
    color: var(--dim);
    font-size: 12px;
  }
</style>
