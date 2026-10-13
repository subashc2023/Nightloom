<script lang="ts">
  /**
   * Running tasks from the phone (item 246, wave 1C): the chats with a
   * turn running on the Mac, the asides, the dream and a capture — the
   * desktop's Running-tasks panel, read-only but for opening a chat.
   * Rendered inside the page's sheet; `onopen` shows the chat.
   */
  import { sinceText, type Running } from "./client";

  interface Props {
    running: Running | null;
    problem: string | null;
    onopen: (chat: string, project: string | null) => void;
    onrefresh: () => void;
    /** The host's name — "the Mac" or "Away" (300 B5). */
    where?: string;
  }
  let { running, problem, onopen, onrefresh, where = "the Mac" }: Props = $props();

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
  {#if running.chats.length > 0}
    <div class="rn-label">Chats</div>
    <div class="rn-list">
      {#each running.chats as c, i (c.chat ?? `new-${i}`)}
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
      {/each}
    </div>
  {/if}
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
