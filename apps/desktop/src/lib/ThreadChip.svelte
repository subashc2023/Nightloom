<script lang="ts">
  /*
   * The chat's thread, in its top bar (nightshift backlog 281, 2026-10-02 —
   * his "put the threads feature somewhere … more visible": he could not
   * find the Thread card on the Context page). "◇ <slug> ▾" when the chat
   * is bound, a dim "Thread ▾" when not; a click opens the thread picker's
   * rows (No thread, the project's threads, New thread…) in a card under
   * it, and picking one binds — one click from the chat. No chip without a
   * project (threads live in one) or in an ephemeral chat (no log to bind
   * in). The Context page's Thread card and the hand-off picker stay.
   */
  import { app, chatMode, chatThread } from "./state.svelte";
  import { threadChip } from "./thread";
  import { portal } from "./portal";
  import { tip } from "./tip";
  import ThreadPicker from "./ThreadPicker.svelte";

  const chip = $derived(threadChip(chatThread(app.events), app.project !== null, chatMode(app.events)));

  let open = $state(false);
  let chipEl = $state<HTMLElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);
  let pos = $state({ top: 0, left: 0 });
  const WIDTH = 340;

  function place(): void {
    if (!chipEl) return;
    const r = chipEl.getBoundingClientRect();
    // Left-aligned under the chip (it sits at the bar's left end), kept
    // inside the window.
    const left = Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8));
    pos = { top: r.bottom + 6, left };
  }
  function onDoc(e: MouseEvent): void {
    const t = e.target as Node;
    // The picker's own confirm dialog is portalled elsewhere; a click in
    // any dialog keeps the card.
    if (popEl?.contains(t) || chipEl?.contains(t) || (t as HTMLElement).closest?.("[role=dialog]")) return;
    open = false;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      open = false;
    }
  }
  $effect(() => {
    if (!open) return;
    place();
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  });
  // The chip goes (a project closed, a chat switch to an ephemeral one):
  // the card goes with it. A half-typed New thread name is the picker's,
  // kept per project outside it.
  $effect(() => {
    if (!chip) open = false;
  });
</script>

{#if chip}
  <button
    class="thread-chip"
    class:bound={chip.bound}
    class:open
    bind:this={chipEl}
    aria-haspopup="listbox"
    aria-expanded={open}
    use:tip={chip.bound
      ? "This chat works from a research thread: its Start here is loaded, the wrap-up updates its files. Click to change it"
      : "Bind this chat to a research thread (its Start here loaded, the wrap-up writing the thread's files instead of HANDOFF.md)"}
    onclick={() => (open = !open)}
  >
    <span class="tc-label">{chip.label}</span><span class="tc-caret" aria-hidden="true">▾</span>
  </button>
{/if}

{#if open && chip}
  <div
    class="thread-card"
    role="dialog"
    aria-label="Research thread"
    bind:this={popEl}
    use:portal
    style="top: {pos.top}px; left: {pos.left}px; width: {WIDTH}px"
  >
    <div class="tc-head">Research thread</div>
    <ThreadPicker list onpicked={() => (open = false)} />
  </div>
{/if}

<style>
  .thread-chip {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    max-width: 22em;
    min-width: 0;
    flex-shrink: 1;
    padding: 2px 8px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: transparent;
    color: var(--dim);
    font-family: var(--sans);
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
  }
  .thread-chip.bound {
    color: var(--ink);
    border-color: var(--line2);
    background: var(--well);
  }
  .thread-chip:hover,
  .thread-chip.open {
    color: var(--ink);
    border-color: var(--accent);
  }
  .tc-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tc-caret {
    flex-shrink: 0;
    font-size: 9px;
    opacity: 0.7;
  }
  .thread-card {
    position: fixed;
    z-index: 80;
    box-sizing: border-box;
    padding: 10px 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  }
  .tc-head {
    padding: 0 8px;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
</style>
