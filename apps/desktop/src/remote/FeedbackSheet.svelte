<script lang="ts">
  /**
   * His feedback from the phone (nightshift item 805): the same note the
   * Mac's box sends — his words verbatim as one backlog item in the
   * Nightshift repo, with the open chat attached. The draft is kept in
   * localStorage on every keystroke (practices §7): closing the sheet,
   * opening another chat and a reload bring it back; only a send that
   * landed or a confirmed Discard clears it. A try after a lost reply
   * carries the same nonce, so it files once.
   */
  import { nonceFor, type Client, type Try } from "./client";
  import { FEEDBACK_PHONE_KEY, loadPhoneFeedback, savePhoneFeedback, sentSentence } from "./feedbackDraft";

  interface Props {
    client: Pick<Client, "feedback">;
    /** The host lists `feedback`. */
    available: boolean;
    /** `/api/state`'s `host`: `serve` is the away server. */
    host?: string | null;
    /** The open chat, attached to the note. */
    chat: string | null;
    chatTitle: string | null;
    project: string | null;
    onnote: (text: string) => void;
  }
  let { client, available, host = null, chat, chatTitle, project, onnote }: Props = $props();

  let text = $state(loadPhoneFeedback());
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let done = $state<string | null>(null);
  let confirmDiscard = $state(false);
  let last: Try | null = null;

  function typed() {
    done = null;
    savePhoneFeedback(text);
  }

  async function send() {
    if (busy || !text.trim()) return;
    busy = true;
    problem = null;
    const t = nonceFor(last, `${FEEDBACK_PHONE_KEY}:${text}`);
    last = t;
    try {
      const sent = await client.feedback({ text, chat, chat_title: chatTitle, project, nonce: t.nonce });
      done = sentSentence(sent);
      onnote(done);
      text = "";
      savePhoneFeedback("");
      last = null;
    } catch (e) {
      problem = `Not sent — ${e instanceof Error ? e.message : String(e)}. Your words are kept.`;
    } finally {
      busy = false;
    }
  }

  function discard(sure = false) {
    if (!text.trim()) return;
    if (!sure) {
      confirmDiscard = true;
      return;
    }
    text = "";
    savePhoneFeedback("");
    confirmDiscard = false;
  }
</script>

<div class="fb-title">Send feedback</div>
{#if !available}
  <p class="fb-note">
    {host === "serve"
      ? "The away server has no Nightshift copy to file feedback in. Switch to the Mac in Hosts; your words are kept here."
      : "This Mac's Nightloom is older and cannot take feedback yet. Your words are kept here."}
  </p>
{:else}
  <p class="fb-note">To the agent that builds Nightloom: a new backlog item, word for word{chatTitle ? `, with “${chatTitle}” attached` : ""}.</p>
{/if}
<textarea
  class="fb-box"
  data-kept=""
  bind:value={text}
  oninput={typed}
  placeholder="What should change, what broke, what you want…"
  autocapitalize="sentences"
></textarea>
{#if problem}<p class="fb-problem" role="alert">{problem}</p>{/if}
{#if done}<p class="fb-done" role="status">{done}</p>{/if}
{#if confirmDiscard}
  <p class="fb-note">Discard this feedback? The words are gone after this.</p>
  <div class="fb-actions">
    <span class="fb-grow"></span>
    <button class="fb-btn" onclick={() => (confirmDiscard = false)}>Keep it</button>
    <button class="fb-btn danger" onclick={() => discard(true)}>Discard</button>
  </div>
{:else}
  <div class="fb-actions">
    <button class="fb-btn" disabled={!text.trim()} onclick={() => discard()}>Discard</button>
    <span class="fb-grow"></span>
    <button class="fb-btn accent" disabled={busy || !available || !text.trim()} onclick={send}>{busy ? "Sending…" : "Send"}</button>
  </div>
{/if}

<style>
  .fb-title {
    font-weight: 600;
    font-size: 17px;
  }
  .fb-note {
    font-size: 13px;
    color: var(--dim);
    margin: 0;
    overflow-wrap: anywhere;
  }
  .fb-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 0;
  }
  .fb-done {
    font-size: 14px;
    color: var(--accent-ink);
    margin: 0;
  }
  .fb-box {
    width: 100%;
    box-sizing: border-box;
    background: var(--well);
    color: inherit;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    font-size: 16px; /* under 16px iOS Safari zooms the page on focus */
    outline: none;
    min-height: 30dvh;
    resize: none;
    line-height: 1.45;
  }
  .fb-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .fb-grow {
    flex: 1;
  }
  .fb-btn {
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
  .fb-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .fb-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .fb-btn.danger {
    color: var(--failed);
    border-color: color-mix(in srgb, var(--failed) 45%, transparent);
  }
</style>
