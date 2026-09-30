<script lang="ts">
  /**
   * An aside from the phone (item 246, wave 2C): a question asked beside
   * the chat — the Mac's aside card — whose answer streams in here and
   * never enters the chat's log. The answer arrives as `aside-event`s on
   * the page's stream (patch note 2C→2A); the page folds them into `aside`.
   *
   * The question box keeps his text per chat (`aside:<chat>` in the
   * composer's drafts) until the Mac takes it, so closing the sheet or a
   * refused ask loses nothing.
   */
  import { onMount } from "svelte";
  import { renderMarkdown } from "../lib/markdown";
  import { loadDraft, saveDraft, type Aside, type PastAside } from "./client";

  interface Props {
    chat: string;
    title: string;
    /** The host serves asides (`features`). */
    available: boolean;
    /** The aside asked from this page on this chat, if any. */
    aside: Aside | null;
    past: PastAside[] | null;
    problem: string | null;
    /** Resolves true when the Mac took the question. */
    onask: (text: string) => Promise<boolean>;
    onstop: () => void;
    oncopy: (text: string) => void;
  }
  let { chat, title, available, aside, past, problem, onask, onstop, oncopy }: Props = $props();

  const key = $derived(`aside:${chat}`);
  let text = $state("");
  let sending = $state(false);

  onMount(() => {
    text = loadDraft(key);
  });

  async function ask() {
    const q = text.trim();
    if (!q || sending) return;
    sending = true;
    try {
      if (await onask(q)) {
        text = "";
        saveDraft(key, "");
      }
    } finally {
      sending = false;
    }
  }

  const asking = $derived(aside?.state === "asking");
</script>

<div class="as-title">Ask aside</div>
<div class="as-sub">Beside “{title}” — the answer stays out of the chat.</div>
{#if !available}
  <p class="as-note">This Mac's Nightloom is older than the phone page: update it to ask asides from here.</p>
{:else}
  {#if aside}
    <div class="as-card">
      <div class="as-q">{aside.question}</div>
      {#if aside.answer}
        <div class="as-md">{@html renderMarkdown(aside.answer)}</div>
      {:else if asking}
        <span class="as-thinking"><i></i><i></i><i></i></span>
      {/if}
      {#if aside.state === "failed"}<p class="as-problem">{aside.error ?? "The aside failed."}</p>{/if}
      <div class="as-actions">
        {#if asking}
          <span class="as-live">answering…</span>
          <span class="as-grow"></span>
          <button class="as-btn" onclick={onstop}>Stop</button>
        {:else if aside.answer}
          <span class="as-grow"></span>
          <button class="as-btn" onclick={() => oncopy(aside!.answer)}>Copy</button>
        {/if}
      </div>
    </div>
  {/if}
  <textarea
    class="as-box"
    rows="3"
    placeholder={asking ? "Wait for this answer…" : "A quick question, beside the chat…"}
    bind:value={text}
    oninput={() => saveDraft(key, text)}
  ></textarea>
  {#if problem}<p class="as-problem">{problem}</p>{/if}
  <div class="as-actions">
    <span class="as-grow"></span>
    <button class="as-btn accent" disabled={!text.trim() || sending || asking} onclick={ask}>Ask</button>
  </div>
  {#if past && past.length > 0}
    <div class="as-label">Earlier asides</div>
    <div class="as-past">
      {#each past as p, i (i)}
        <details>
          <summary>{p.question}</summary>
          <small class="as-thread">{p.thread}</small>
          <div class="as-md">{@html renderMarkdown(p.answer)}</div>
        </details>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .as-title {
    font-weight: 600;
    font-size: 17px;
  }
  .as-sub,
  .as-note {
    font-size: 13px;
    color: var(--dim);
    margin: -6px 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .as-note {
    margin: 0;
    white-space: normal;
  }
  .as-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 0;
  }
  .as-card {
    background: var(--paper);
    border-radius: 16px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-left: 3px solid var(--accent);
  }
  .as-q {
    font-size: 14px;
    color: var(--ink2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .as-md {
    font-size: 15px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .as-md :global(p) {
    margin: 0.4em 0;
  }
  .as-md :global(pre) {
    overflow-x: auto;
    background: var(--well);
    border-radius: 10px;
    padding: 8px 10px;
    font-size: 13px;
  }
  .as-md :global(code) {
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .as-live {
    font-size: 13px;
    color: var(--live);
  }
  .as-thinking {
    display: inline-flex;
    gap: 4px;
  }
  .as-thinking i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--dim);
    animation: as-blink 1.2s infinite;
  }
  .as-thinking i:nth-child(2) {
    animation-delay: 0.2s;
  }
  .as-thinking i:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes as-blink {
    50% {
      opacity: 0.25;
    }
  }
  .as-box {
    width: 100%;
    box-sizing: border-box;
    background: var(--well);
    color: inherit;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    font-size: 16px;
    outline: none;
    resize: none;
  }
  .as-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .as-grow {
    flex: 1;
  }
  .as-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
  }
  .as-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .as-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .as-label {
    font-size: 13px;
    color: var(--dim);
    margin: 4px 0 -4px;
  }
  .as-past {
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
  }
  .as-past details {
    padding: 10px 16px;
  }
  .as-past details + details {
    border-top: 1px solid var(--line);
  }
  .as-thread {
    font-size: 12px;
    color: var(--dim);
  }
  .as-past summary {
    cursor: pointer;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
