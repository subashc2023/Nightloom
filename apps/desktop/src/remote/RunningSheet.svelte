<script lang="ts">
  /**
   * Running tasks from the phone (item 246, wave 1C): the chats with a
   * turn running on the Mac, the asides, the dream and a capture — the
   * desktop's Running-tasks panel, read-only but for opening a chat.
   * Rendered inside the page's sheet; `onopen` shows the chat.
   *
   * By project (item 558, 2026-11-10): ~~one "Chats" list~~ — the chats
   * under their projects (`runGroups.ts`, the desktop panel's grouping),
   * the project he is in first and open, the others folded to a count.
   */
  import { sinceText, type Running } from "./client";
  import { groupRuns, projectSummary } from "../lib/runGroups";
  import type { RunEntry } from "../lib/running";

  interface Props {
    running: Running | null;
    problem: string | null;
    onopen: (chat: string, project: string | null) => void;
    onrefresh: () => void;
    /** The host's name — "the Mac" or "Away" (300 B5). */
    where?: string;
    /** Item 558: the host's projects, to name each group. */
    projects?: readonly { id: string; name: string }[];
    /** The project he is in on the phone; null for unfiled chats. */
    here?: string | null;
  }
  let { running, problem, onopen, onrefresh, where = "the Mac", projects = [], here = null }: Props = $props();

  /** The chats as the desktop's running rows, grouped by project. */
  const groups = $derived(
    groupRuns(
      (running?.chats ?? []).map(
        (c, i): RunEntry => ({
          id: `turn:${c.chat ?? `new-${i}`}`,
          kind: "turn",
          project: c.project ?? null,
          where: c.project ? (projects.find((p) => p.id === c.project)?.name ?? "another project") : "unfiled chats",
          session: c.chat,
          chat: c.title,
          doing: "",
          startedAt: c.since,
          onScreen: !!c.on_screen,
          waiting: (c.waiting ?? 0) > 0,
          survivesQuit: false,
        }),
      ),
      here,
    ),
  );
  /** Folds he changed on this page; the rest follow "his project open". */
  let folds = $state<Record<string, boolean>>({});
  const isOpen = (key: string, here: boolean) => folds[key] ?? here;
  const byId = $derived(new Map((running?.chats ?? []).map((c, i) => [`turn:${c.chat ?? `new-${i}`}`, c])));

  /** Asides (2A: `{chat, thread, seq, question}`, labelled by the question), dream and capture: each
   *  section shows only when a host reports something. */
  const asides = $derived(Array.isArray(running?.asides) ? running.asides : []);
  const label = (v: unknown, fallback: string): string => {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const t = o.title ?? o.label ?? o.name ?? o.question;
    return typeof t === "string" && t.trim() ? t : fallback;
  };
  const started = (v: unknown): number | null => {
    const s = v && typeof v === "object" ? (v as Record<string, unknown>).since : null;
    return typeof s === "number" ? s : null;
  };
  const empty = $derived(running !== null && running.chats.length === 0 && asides.length === 0 && !running.dream && !running.capture);
</script>

<div class="rn-head">
  <span class="rn-title">Running on {where}</span>
  <button class="rn-refresh" onclick={onrefresh}>Refresh</button>
</div>
{#if problem}
  <p class="rn-note">{problem}</p>
{:else if !running}
  <p class="rn-note">Asking {where}…</p>
{:else if empty}
  <p class="rn-note">Nothing is running.</p>
{:else}
  {#each groups as g (g.key)}
    {@const open = isOpen(g.key, g.here)}
    <button class="rn-label rn-fold" aria-expanded={open} onclick={() => (folds = { ...folds, [g.key]: !open })}>
      <span class="rn-chev" class:open>›</span>
      <span class="rn-proj">{g.where}</span>
      {#if g.here}<span class="rn-here">this project</span>{/if}
      <span class="rn-count">{open ? g.count : projectSummary(g)}</span>
    </button>
    {#if open}
      <div class="rn-list">
        {#each g.chats as gc (gc.key)}
          {@const c = gc.turn ? byId.get(gc.turn.id) : undefined}
          {#if c}
            <button disabled={!c.chat} onclick={() => c.chat && onopen(c.chat, c.project ?? null)}>
              <span class="rn-dot"></span>
              <span class="rn-grow">
                <span class="rn-name">{c.title}</span>
                <small>
                  {[c.on_screen ? `on ${where}’s screen` : null, sinceText(c.since) || null, c.waiting ? `${c.waiting} waiting for you` : null]
                    .filter(Boolean)
                    .join(" · ") || "running"}
                </small>
              </span>
            </button>
          {/if}
        {/each}
      </div>
    {/if}
  {/each}
  {#if asides.length > 0}
    <div class="rn-label">Asides</div>
    <div class="rn-list">
      {#each asides as a, i (i)}
        <div class="rn-item">
          <span class="rn-dot"></span>
          <span class="rn-grow">
            <span class="rn-name">{label(a, "Aside")}</span>
            <small>{sinceText(started(a))}</small>
          </span>
        </div>
      {/each}
    </div>
  {/if}
  {#if running.dream || running.capture}
    <div class="rn-label">In the background</div>
    <div class="rn-list">
      {#if running.dream}
        <div class="rn-item">
          <span class="rn-dot"></span>
          <span class="rn-grow"><span class="rn-name">{label(running.dream, "Dream")}</span><small>{sinceText(started(running.dream))}</small></span>
        </div>
      {/if}
      {#if running.capture}
        <div class="rn-item">
          <span class="rn-dot"></span>
          <span class="rn-grow"><span class="rn-name">{label(running.capture, "Capture")}</span><small>{sinceText(started(running.capture))}</small></span>
        </div>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .rn-head {
    display: flex;
    align-items: center;
  }
  .rn-title {
    flex: 1;
    font-weight: 600;
    font-size: 17px;
  }
  .rn-refresh {
    all: unset;
    cursor: pointer;
    color: var(--accent-ink);
    font-size: 15px;
    padding: 8px 4px;
  }
  .rn-note {
    font-size: 14px;
    color: var(--dim);
    margin: 0;
  }
  .rn-label {
    font-size: 13px;
    color: var(--dim);
    margin: 4px 0 -4px;
  }
  /* Item 558: a project's head folds its chats. */
  .rn-fold {
    all: unset;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    padding: 6px 2px 2px;
    margin: 4px 0 -2px;
  }
  .rn-chev {
    display: inline-block;
    color: var(--dim);
    transition: transform 0.15s;
  }
  .rn-chev.open {
    transform: rotate(90deg);
  }
  .rn-proj {
    color: var(--ink);
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rn-here {
    font-size: 11px;
    color: var(--live);
    background: var(--live-soft);
    border-radius: 999px;
    padding: 1px 8px;
    flex: none;
  }
  .rn-count {
    margin-left: auto;
    flex: none;
    font-size: 12px;
    color: var(--dim);
  }
  .rn-list {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
  }
  .rn-list > button,
  .rn-item {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 6px 16px;
    box-sizing: border-box;
  }
  .rn-list > button {
    cursor: pointer;
  }
  .rn-list > button:disabled {
    cursor: default;
  }
  .rn-list > button:active:not(:disabled) {
    background: var(--well);
  }
  .rn-list > * + * {
    border-top: 1px solid var(--line);
  }
  .rn-grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .rn-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small {
    font-size: 12px;
    color: var(--dim);
  }
  .rn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--live);
    flex: none;
    animation: rn-pulse 1.2s infinite;
  }
  @keyframes rn-pulse {
    50% {
      opacity: 0.3;
    }
  }
</style>
