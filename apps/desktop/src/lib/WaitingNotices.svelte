<script lang="ts">
  import Icon from "./Icon.svelte";
  import { app, openWaiting, waitingChatName } from "./state.svelte";
  import { closeWaiting, MAX_SHOWN, noticeText, pruneClosed, waitingIds, waitingNotices, waitingView } from "./waitingNotice.svelte";

  /**
   * The bottom-right notices that a chat is waiting on him (nightshift item 523): one per chat whose prompt
   * he cannot see, in the toasts' own stack and styling, staying until × or the answer; a click opens the chat
   * at the card. The rule is `waitingNotices` (waitingNotice.svelte.ts); this only draws it.
   */
  const source = $derived({
    active: app.activeSessionId,
    pending: app.pendingApprovals,
    parked: app.parked,
    background: app.background,
    visible: waitingView.visible,
    closed: waitingView.closed,
    nameOf: waitingChatName,
  });
  const all = $derived(waitingNotices(source));
  const shown = $derived(all.slice(-MAX_SHOWN));
  const more = $derived(all.length - shown.length);
  $effect(() => pruneClosed(waitingIds(source)));
</script>

{#each shown as n (n.id)}
  {@const t = noticeText(n)}
  <div class="waiting" role="status" data-waiting-chat={n.chat ?? ""} data-waiting-kind={n.kind}>
    <button class="go" onclick={() => void openWaiting(n.chat, n.id)} aria-label="{t.title} {t.what}. {t.go}">
      <span class="dot" aria-hidden="true"></span>
      <span class="words">
        <span class="title">{t.title}</span>
        <span class="what">{t.what}{#if n.count > 1}{` (${n.count} waiting)`}{/if} · <span class="link">{t.go}</span></span>
      </span>
    </button>
    <button class="x" aria-label="Close this notice (the question keeps waiting)" onclick={() => closeWaiting(n.id)}>
      <Icon name="x" size={12} />
    </button>
  </div>
{/each}
{#if more > 0}
  <div class="waiting more" role="status">and {more} more {more === 1 ? "chat is" : "chats are"} waiting on you</div>
{/if}

<style>
  /* The toast's own box (App.svelte `.toast`), with the accent on its edge: it waits, it does not pass. */
  .waiting {
    background: var(--panel);
    border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border));
    color: var(--dim);
    font-size: 0.8rem;
    border-radius: 6px;
    width: 22rem;
    max-width: calc(100vw - 1.5rem);
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
    pointer-events: auto;
    box-shadow: 0 4px 14px color-mix(in srgb, #000 22%, transparent);
    animation: waiting-in 160ms ease-out;
  }
  .waiting.more {
    padding: 0.35rem 0.7rem;
    border-color: var(--border);
    box-shadow: none;
  }
  .go {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    padding: 0.5rem 0.2rem 0.5rem 0.7rem;
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
  }
  .go:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    margin-top: 0.38rem;
    border-radius: 50%;
    background: var(--accent);
  }
  .words {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title {
    color: var(--ink);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link {
    color: var(--accent);
  }
  .go:hover .link {
    text-decoration: underline;
  }
  .x {
    flex: none;
    background: none;
    border: none;
    padding: 4px;
    margin: 0.3rem 0.3rem 0 0;
    color: var(--dim);
    cursor: pointer;
    display: flex;
    border-radius: 4px;
  }
  .x:hover,
  .x:focus-visible {
    color: var(--ink);
    background: color-mix(in srgb, var(--ink) 10%, transparent);
    outline: none;
  }
  @keyframes waiting-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .waiting {
      animation: none;
    }
  }
</style>
