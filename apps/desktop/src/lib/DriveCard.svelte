<script lang="ts">
  // The drive card (nightshift item 872 step 5): Home asks him to take the
  // page in Claude's browser. Take control holds the browser for him and
  // opens its tab; Hand back gives it back and answers with the page he
  // left it on and his note. Nothing here is one stray key away from an
  // answer: the note field takes no Enter. His note is kept as he types
  // (`driveAsk.svelte.ts`), so leaving for the browser tab and coming back
  // — which draws this card afresh — loses nothing. Shaped like the
  // Playwright and secret cards beside it.
  // Item 974: a digit focuses button n; Enter presses it.
  import { keyPicks } from "./cardKeys";
  import { tip } from "./tip";
  import { resolveApproval } from "./state.svelte";
  import { browsers, readStatus } from "./claudeBrowser.svelte";
  import { trackCard } from "./waitingNotice.svelte";
  import {
    DRIVE_DECLINED,
    DRIVE_DECLINE_TIP,
    DRIVE_HEAD,
    DRIVE_LATER_TIP,
    DRIVE_NO_BROWSER,
    DRIVE_NO_WHY,
    DRIVE_TOOK,
    DRIVE_WHERE,
    HAND_BACK_TIP,
    TAKE_TIP,
    driveWhy,
  } from "./drive";
  import { driveChat, driveNote, driveTook, forgetDrive, handBack, releasePage, setDriveNote, settleTook, takePage } from "./driveAsk.svelte";
  import type { ApprovalRequest } from "./types";

  let { req }: { req: ApprovalRequest } = $props();

  const chat = $derived(driveChat(req));
  const why = $derived(driveWhy(req.input));
  const status = $derived(browsers.byChat[chat] ?? null);
  const live = $derived(!!status?.live);
  // What he left on this ask (a card is drawn afresh each time he comes
  // back from the browser tab), read as the card is made.
  const kept = () => ({ note: driveNote(req), took: driveTook(req) });
  const start = kept();
  let known = $state(false);
  let note = $state(start.note);
  let took = $state(start.took);
  let done = $state(false);
  let error = $state<string | null>(null);

  // The browser's status too: the card may be the first thing drawn for
  // this chat.
  $effect(() => {
    void readStatus(chat).then(() => (known = true));
  });
  // A kept "took" holds only while the browser is his: given back any way
  // but Hand back (the browser tab's Give back, a stopped turn, a relaunch),
  // the card opens untaken — Take control, not Hand back.
  $effect(() => {
    if (known && took && !done) took = settleTook(req, status?.held_by === "user");
  });
  // Kept as he types.
  $effect(() => {
    setDriveNote(req, note);
  });

  async function take() {
    if (done) return;
    done = true;
    error = await takePage(req);
    took = driveTook(req);
    done = false;
  }

  async function back() {
    if (done) return;
    done = true;
    error = await handBack(req, note);
    if (error !== null) done = false;
  }

  async function later() {
    if (done) return;
    done = true;
    await releasePage(req);
    took = false;
    // His note stays for the same ask when it comes back.
    if (!(await resolveApproval(req.id, req.name, "later"))) done = false;
  }

  async function decline() {
    if (done) return;
    done = true;
    await releasePage(req);
    took = false;
    const ok = await resolveApproval(req.id, req.name, "deny", note.trim() || DRIVE_DECLINED);
    if (ok) forgetDrive(req);
    else done = false;
  }
</script>

<div class="ask" use:trackCard={req.id} use:keyPicks role="group" aria-label={DRIVE_HEAD} data-card-kind="drive" data-took={took}>
  <div class="head">
    <span class="mark" aria-hidden="true">◎</span>
    <span>{DRIVE_HEAD}</span>
    <span class="sp"></span>
    <span class="effect">paused · waiting for you</span>
  </div>

  <div class="arg">
    <div class="key">what to do there</div>
    <div class="why" class:none={!why}>{why ?? DRIVE_NO_WHY}</div>
  </div>

  {#if live && status?.url}
    <div class="arg">
      <div class="key">the page</div>
      <pre class="val">{#if status.title}<b>{status.title}</b>&nbsp; {/if}{status.url}</pre>
    </div>
  {:else if known && !live}
    <div class="line" data-no-browser>{DRIVE_NO_BROWSER}</div>
  {/if}

  {#if req.back}
    <div class="line" data-aside-back>Back again — this was set aside earlier. It waits for you now.</div>
  {/if}
  <div class="line small">{took ? DRIVE_TOOK : DRIVE_WHERE}</div>
  {#if error}<div class="line err" role="alert">{error}</div>{/if}

  <div class="note-row">
    <input
      class="note"
      type="text"
      bind:value={note}
      disabled={done}
      placeholder="Note for Home — optional: what you did, where you left it"
      aria-label="note for Home, optional"
    />
  </div>

  <div class="actions">
    {#if took}
      <button class="ns-btn accent" data-act="hand-back" data-pick disabled={done} use:tip={HAND_BACK_TIP} onclick={() => void back()}>Hand back</button>
      <button class="ns-btn" data-act="take" data-pick disabled={done || !live} use:tip={TAKE_TIP} onclick={() => void take()}>Open the page again</button>
    {:else}
      <button class="ns-btn accent" data-act="take" data-pick disabled={done || !live} use:tip={TAKE_TIP} onclick={() => void take()}>Take control</button>
    {/if}
    <button class="ns-btn" data-act="later" data-pick disabled={done} use:tip={DRIVE_LATER_TIP} onclick={() => void later()}>Not now — carry on</button>
    <button class="ns-btn danger" data-act="decline" data-pick disabled={done} use:tip={DRIVE_DECLINE_TIP} onclick={() => void decline()}>Decline</button>
  </div>
</div>

<style>
  .ask {
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    background: var(--sheet);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 10px 14px 14px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    min-height: 22px;
    flex-wrap: wrap;
  }
  .mark {
    color: var(--accent);
  }
  .sp {
    flex: 1;
  }
  .effect {
    font-size: 11px;
    line-height: 1.5;
    color: var(--dim);
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 0 8px;
    white-space: nowrap;
  }
  .key {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    margin-bottom: 3px;
  }
  .why {
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 16px);
    line-height: 1.55;
    color: var(--ink);
    max-height: 9.4em;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .why.none {
    color: var(--dim);
    font-style: italic;
  }
  .val {
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 7px 10px;
    margin: 0;
    max-height: 5rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .line {
    font-size: 13px;
    line-height: 1.5;
    color: var(--dim);
  }
  .line.small {
    font-size: 12px;
  }
  .line.err {
    color: var(--danger, var(--accent));
  }
  .note-row {
    display: flex;
  }
  .note {
    flex: 1;
    min-width: 0;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 5px 10px;
    min-height: 32px;
    box-sizing: border-box;
  }
  .note::placeholder {
    color: var(--dim);
  }
  .note:focus {
    outline: none;
    border-color: var(--accent);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
</style>
