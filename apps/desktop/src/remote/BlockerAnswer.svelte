<script lang="ts">
  /**
   * One Nightshift blocker on the phone (item 246 wave 5, blocker 669):
   * the question, the default the agent took and what it blocks, and his
   * answer — written as the Mac's Answer box writes it (`## Answer`, status
   * `answered`).
   *
   * Never loses his text (practices §7): every keystroke is kept in
   * localStorage under the blocker (`answerDraftKey`), so closing the
   * sheet, a reload or a refused Send leaves it; only Send landing, or
   * Discard (which asks when there is text), drops it.
   */
  import { tick } from "svelte";
  import { renderMarkdown } from "../lib/markdown";
  import {
    answerDraftKey,
    discardNeedsConfirm,
    loadNsDraft,
    nsProblem,
    saveNsDraft,
    type NightshiftClient,
    type NsBlocker,
  } from "./nightshiftClient";

  interface Props {
    ns: NightshiftClient;
    project: string;
    blocker: NsBlocker;
    /** A shift is running: Send would be refused, so it waits. */
    live: boolean;
    host?: string | null;
    onanswered: (b: NsBlocker) => void;
  }
  let { ns, project, blocker, live, host = null, onanswered }: Props = $props();

  const key = $derived(answerDraftKey(project, blocker.id));
  let text = $state("");
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let confirmDiscard = $state(false);
  let box = $state<HTMLTextAreaElement | null>(null);

  // The kept draft, else empty — once per blocker.
  let loadedFor = "";
  $effect(() => {
    if (loadedFor === key) return;
    loadedFor = key;
    text = loadNsDraft(key)?.text ?? "";
    confirmDiscard = false;
    problem = null;
  });

  function typed() {
    saveNsDraft(key, { text });
  }

  async function useDefault() {
    text = text.trim() ? `${text.trim()} Go with your default.` : "Go with your default.";
    typed();
    await tick();
    box?.focus();
  }

  async function send() {
    if (!text.trim() || busy) return;
    busy = true;
    problem = null;
    try {
      const after = await ns.answer(project, blocker.id, text);
      // Written on the host: only now does the draft go.
      saveNsDraft(key, null);
      text = "";
      onanswered(after);
    } catch (e) {
      // The draft stays; the sheet says why.
      problem = nsProblem(e, host);
    } finally {
      busy = false;
    }
  }

  function discard(force = false) {
    if (discardNeedsConfirm({ text }) && !force) {
      confirmDiscard = true;
      return;
    }
    saveNsDraft(key, null);
    text = "";
    confirmDiscard = false;
  }
</script>

<div class="ba-label">Question</div>
<div class="ba-md">{@html renderMarkdown(blocker.question || "(no question written)")}</div>
{#if blocker.guess.trim()}
  <div class="ba-label">What the agent would have done</div>
  <div class="ba-md">{@html renderMarkdown(blocker.guess)}</div>
{/if}
{#if blocker.blocks.trim()}
  <div class="ba-label">What it blocks</div>
  <div class="ba-md">{@html renderMarkdown(blocker.blocks)}</div>
{/if}
{#if blocker.status === "answered" && blocker.answer.trim()}
  <div class="ba-label">Your answer</div>
  <div class="ba-md">{@html renderMarkdown(blocker.answer)}</div>
{:else}
  <div class="ba-label">Your answer</div>
  {#if live}<p class="ba-note">A shift is running; the answer can be sent when it ends. Your draft is kept.</p>{/if}
  <textarea class="ba-box" data-kept bind:this={box} bind:value={text} oninput={typed} placeholder="Most answers are one word…" autocapitalize="sentences"></textarea>
  {#if problem}<p class="ba-problem">{problem}</p>{/if}
  {#if confirmDiscard}
    <p class="ba-note">Discard this answer? The draft is gone after this.</p>
    <div class="ba-actions">
      <span class="ba-grow"></span>
      <button class="ba-btn" onclick={() => (confirmDiscard = false)}>Keep it</button>
      <button class="ba-btn danger" onclick={() => discard(true)}>Discard</button>
    </div>
  {:else}
    <div class="ba-actions">
      <button class="ba-btn" disabled={!text.trim()} onclick={() => discard()}>Discard</button>
      {#if blocker.guess.trim()}<button class="ba-btn" onclick={useDefault}>Your default</button>{/if}
      <span class="ba-grow"></span>
      <button class="ba-btn accent" disabled={busy || live || !text.trim()} onclick={send}>{busy ? "Sending…" : "Send"}</button>
    </div>
  {/if}
{/if}

<style>
  .ba-label {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dim);
    margin-top: 4px;
  }
  .ba-md {
    font-size: 15px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .ba-md :global(p),
  .ba-md :global(ul),
  .ba-md :global(ol) {
    margin: 0.4em 0;
  }
  .ba-md :global(code) {
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .ba-md :global(pre) {
    overflow-x: auto;
    background: var(--well);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
  }
  .ba-note {
    font-size: 13px;
    color: var(--dim);
    margin: 0;
  }
  .ba-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 0;
  }
  .ba-box {
    width: 100%;
    box-sizing: border-box;
    min-height: 120px;
    resize: none;
    background: var(--well);
    color: inherit;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    font-size: 16px; /* under 16px iOS Safari zooms the page on focus */
    line-height: 1.45;
    outline: none;
  }
  .ba-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .ba-grow {
    flex: 1;
  }
  .ba-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
  }
  .ba-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ba-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .ba-btn.danger {
    color: var(--failed);
    border-color: color-mix(in srgb, var(--failed) 45%, transparent);
  }
</style>
