<script lang="ts">
  /**
   * The typed link's card (nightshift item 993c; the look is round 2 of the mock he approved 2026-11-26,
   * `notes/runner-design/993-mock/motion.html`): what a reply's event, email or doc is, and what he can do
   * with it, on the app's menu card (`hud-m`: the brackets spring out of the link, 220 ms; back into it, 150 ms).
   *
   * Nothing fires on a first click. An action that sends — an RSVP, a reply, a forward — opens the confirm, which
   * arrives like the question card (`lk-shell` + `AskLock`: brackets, scanline, breathing corners) and says exactly
   * what goes and to whom; only its named button ("Send: Accept", "Send to Priya S.") hands the action to `act`.
   * What comes back stamps a receipt (SENT, COPIED), the way an answered question does.
   *
   * `act` is 993d's (`refAct.ts`, passed by `App.svelte`): his confirmed click runs one connector call, and what
   * the connector answered comes back as the receipt — sent, not there any more (the card says so and the link
   * dims), or the reason it failed, with nothing dropped. Without an `act` (a window with no way to run one) every
   * action is shown, disabled, marked "coming soon". A signed-out or switched-off account disables the actions
   * that need it and says why, with the way to Home's Sources; opening the item's own page and copying its link
   * need no account and stay on.
   *
   * His typing is never lost (`refDrafts.svelte.ts`): a reply, a forward's recipient and an RSVP note are kept at
   * every keystroke under the item, offered back when the card opens again, and dropped only by a send, a save as a
   * Gmail draft, or Discard — which asks first.
   *
   * A mail (993e) goes only from his click on "Send to …", with the whole draft on screen. Its Undo is a hold
   * (`mailHold`, kept by the host): the card counts down "Sending to … in 5 s" with an Undo, and Esc means Undo
   * too; the words are locked while it counts, so what goes is what he saw. Undone: nothing was called, the confirm
   * and his words stay. Sent: the receipt names who it went to.
   *
   * Who a mail goes to is read from the message itself (993e review, finding 1): opening Reply, Reply all or
   * Forward reads the email's real headers through the connector's read-only `get_message` (`readHeads`), and
   * the confirm shows those people — never the reply's tag — and sends to exactly them (pinned in the pass).
   * Until the read is back, or if it fails, Send stays off with the reason. A mail whose fate is unknown (let
   * through, no success back) keeps Send off for the item until he says he checked Gmail's Sent.
   */
  import { onMount, tick } from "svelte";
  import AskLock from "./AskLock.svelte";
  import Icon from "./Icon.svelte";
  import { tip } from "./tip";
  import { floatMenu } from "./floatMenu";
  import { hudIn, hudOut } from "./hudMenu";
  import { refKey, type Ref } from "./refTag";
  import { MAIL_WORD, KIND_WORD, RSVP_CHOICES, accountWarn, asOfWords, detailRows, mailTo, openElsewhere, rsvpConfirm, rsvpOf, rsvpPill, whenLine } from "./refCard";
  import type { AccountState, MailMode, RefAction, RefReceipt, Rsvp, RsvpAnswer } from "./refCard";
  import { draftOf, dropDraft, keepDraft } from "./refDrafts.svelte";
  import { MAIL_HOLD_MS, isMaybeSent, isUndone, secondsLeft } from "./mailHold";
  import { mailRecipients, personWords, sendToWords, type MailHeads } from "./refCard";

  let {
    ref,
    anchor,
    account,
    accountState = "unknown",
    act,
    mailSend = true,
    mailHold = null,
    readHeads,
    me = null,
    maybeSent = null,
    onchecked,
    rsvpNow = null,
    onclose,
    onaccounts,
    ondone,
    now = () => new Date(),
  }: {
    ref: Ref;
    /** The link in the reply the card opens from (and folds back into). */
    anchor: HTMLElement | null;
    /** The account's name for the head (its address, or the service). */
    account: string;
    accountState?: AccountState;
    /** Runs one action (993d). Absent: the actions are shown, disabled, "coming soon". */
    act?: (a: RefAction) => Promise<RefReceipt>;
    /** Whether "Send to …" may send (993e). Off: the draft can still be saved to Gmail. */
    mailSend?: boolean;
    /** A mail of this item in its hold (993e, the host's): when it goes, and its Undo. */
    mailHold?: { until: number; to: string; undo: () => void } | null;
    /** Reads the email's own headers (993e review). Absent: no mail can be sent from here. */
    readHeads?: () => Promise<MailHeads>;
    /** His own address on this account, left out of a reply to all. */
    me?: string | null;
    /** A mail of this item may have gone (unknown outcome): why, until he says he checked. */
    maybeSent?: string | null;
    onchecked?: () => void;
    /** His answer as the window last knew it (an RSVP sent or undone this session), over the link's own. */
    rsvpNow?: Rsvp | null;
    onclose: () => void;
    /** To Home's Sources, from the signed-out notice. */
    onaccounts?: () => void;
    /** Something was sent for this item (the link in the reply gets its ✓). */
    ondone?: () => void;
    now?: () => Date;
  } = $props();

  const SOON = "Coming soon";
  const key = $derived(refKey(ref));
  const f = $derived(ref.fields);
  const warn = $derived(accountWarn(accountState, account));
  // The connector said the item is not there any more: nothing more can be sent for it.
  let gone = $state(false);
  const ready = $derived(!!act && warn === null && !gone);
  const offWhy = $derived(ready ? undefined : !act ? SOON : gone ? "It is not there any more" : "This account cannot be reached right now");
  // Opening its page and copying its link need no account.
  const linkWhy = $derived(!act ? SOON : f.link ? undefined : "This link came without its address");
  const elsewhere = $derived(openElsewhere(ref));
  const asOf = $derived(asOfWords(ref, now()));
  const draft = $derived(draftOf(key));

  type View = "details" | "confirm";
  type Pending = { type: "rsvp"; answer: RsvpAnswer } | { type: "mail"; mode: MailMode };
  let view = $state<View>("details");
  let pending = $state<Pending | null>(null);
  let busy = $state<string | null>(null);
  let failed = $state<string | null>(null);
  let receipt = $state<RefReceipt | null>(null);
  let discarding = $state(false);
  // His answer after an RSVP went through; until then the link's own.
  let answered = $state<Rsvp | null>(null);
  const rsvp = $derived(rsvpNow ?? answered ?? rsvpOf(f.rsvp));
  const pill = $derived(rsvpPill(rsvp));

  let card = $state<HTMLElement | null>(null);
  let noteBox = $state<HTMLInputElement | null>(null);
  let bodyBox = $state<HTMLTextAreaElement | null>(null);

  const note = $derived(draft?.note ?? "");
  const body = $derived(draft?.body ?? "");
  const to = $derived(draft?.to ?? "");
  const pendingAnswer = $derived(pending?.type === "rsvp" ? pending.answer : null);
  const mailMode = $derived(pending?.type === "mail" ? pending.mode : null);
  // The email's real headers, for every mail mode (993e review, finding 1).
  let heads = $state<{ state: "idle" | "reading" | "ok" | "failed"; h?: MailHeads; why?: string }>({ state: "idle" });
  const recipients = $derived(heads.h && (mailMode === "reply" || mailMode === "replyAll") ? mailRecipients(heads.h, mailMode, me) : null);
  const sendTo = $derived(!mailMode ? "" : mailMode === "forward" ? mailTo(ref, mailMode, to) : heads.h && recipients ? sendToWords(heads.h, recipients) : "");
  const headsOk = $derived(heads.state === "ok" && (mailMode === "forward" || (recipients?.to.length ?? 0) > 0));
  const canSend = $derived(!busy && !mailHold && (pending?.type === "rsvp" || (!!body.trim() && !!sendTo && headsOk && !maybeSent)));
  const sendWhy = $derived(
    !mailSend
      ? "Sending from here is not built yet\nSave as Gmail draft works"
      : maybeSent
        ? "It may have gone already\nCheck Sent in Gmail first"
        : !readHeads
          ? "Who this goes to cannot be checked here\nSave as Gmail draft works"
          : heads.state === "reading"
            ? "Checking who this goes to…"
            : heads.state === "failed"
              ? `Could not read who this goes to\n${heads.why ?? ""}`
              : !body.trim()
                ? "Nothing written yet"
                : !sendTo
                  ? "Say who gets it first"
                  : `Sends exactly the words above (⌘↵)\nUndo for ${Math.round(MAIL_HOLD_MS / 1000)} s after`,
  );
  function loadHeads(): void {
    if (!readHeads || heads.state === "reading" || heads.state === "ok") return;
    heads = { state: "reading" };
    readHeads().then(
      (h) => (heads = { state: "ok", h }),
      (e) => (heads = { state: "failed", why: String(e instanceof Error ? e.message : e) }),
    );
  }
  // He undid a mail in its hold: said once, under the confirm.
  let undoneNote = $state<string | null>(null);
  // The countdown's clock, ticking only while a mail is held.
  let clock = $state(Date.now());
  $effect(() => {
    if (!mailHold) return;
    clock = Date.now();
    const t = setInterval(() => (clock = Date.now()), 250);
    return () => clearInterval(t);
  });
  const holdLeft = $derived(mailHold ? secondsLeft(mailHold.until, clock) : 0);

  onMount(() => {
    // Keys go to the card from its opening; the link gets the focus back when it closes (RefCardHost).
    card?.focus({ preventScroll: true });
  });

  async function pick(p: Pending): Promise<void> {
    if (!ready || busy || mailHold) return;
    failed = null;
    undoneNote = null;
    receipt = null;
    discarding = false;
    pending = p;
    view = "confirm";
    if (p.type === "mail" && draft?.mode !== p.mode) keepDraft(key, { mode: p.mode });
    if (p.type === "mail") loadHeads();
    await tick();
    (p.type === "mail" ? bodyBox : noteBox)?.focus({ preventScroll: true });
  }

  function back(): void {
    if (busy) return;
    // The draft stays (refDrafts); the details offer it back.
    view = "details";
    pending = null;
    discarding = false;
    card?.focus({ preventScroll: true });
  }

  async function run(action: RefAction, which: string, after?: () => void): Promise<void> {
    if (!act || busy) return;
    // This card's own item and callbacks, taken now: a card closed while its action runs must not, when it ends,
    // mark or drop whatever item the card open by then shows (993e review, finding 5).
    const done = ondone;
    busy = which;
    failed = null;
    undoneNote = null;
    try {
      const r = await act(action);
      // The pressed button holds its lock for the pick's 300 ms, then the receipt stamps in.
      await new Promise((ok) => setTimeout(ok, hold()));
      if (r.gone) gone = true;
      else after?.();
      receipt = r;
      if (r.rsvp) answered = r.rsvp;
      view = "details";
      pending = null;
      if (r.stamp === "Sent") done?.();
    } catch (e) {
      // Undone in its hold (993e): nothing was called; the confirm and his words stay.
      if (isUndone(e)) undoneNote = e.message;
      // It may have gone: the host holds Send for the item and the card says so (maybeSent).
      else if (isMaybeSent(e)) failed = null;
      // Nothing is dropped on a failure: the confirm and his words stay, with the reason.
      else failed = String(e instanceof Error ? e.message : e);
    } finally {
      busy = null;
    }
  }

  const hold = () => (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300);

  function send(): void {
    if (!pending || !canSend) return;
    if (pending.type === "mail" && !mailSend) return;
    const k = key;
    if (pending.type === "rsvp") void run({ type: "rsvp", answer: pending.answer, note: note.trim() }, "send", () => dropDraft(k, "note"));
    else
      void run(
        { type: "send", mode: pending.mode, to: sendTo, body, ...(recipients ? { recipients: { to: [...recipients.to], cc: [...recipients.cc] } } : {}), about: heads.h?.subject ?? ref.name },
        "send",
        () => dropDraft(k, "mail"),
      );
  }
  function saveDraft(): void {
    if (pending?.type !== "mail" || !body.trim() || busy) return;
    const k = key;
    // A reply's draft is threaded by Gmail (no address); a forward's carries his typed one.
    void run({ type: "saveDraft", mode: pending.mode, to: pending.mode === "forward" ? sendTo : "", body }, "save", () => dropDraft(k, "mail"));
  }
  function discard(): void {
    dropDraft(key, "mail");
    discarding = false;
    back();
  }

  function onkey(e: KeyboardEvent): void {
    const typing = e.target instanceof HTMLElement && e.target.matches("input, textarea");
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // A mail in its hold: Esc is its Undo, never a close that leaves it going.
      if (mailHold) mailHold.undo();
      else if (discarding) discarding = false;
      else if (view === "confirm") back();
      else onclose();
      return;
    }
    if (!card?.contains(e.target as Node)) return;
    if (view === "confirm" && e.key === "Enter" && !e.shiftKey && (!(e.target instanceof HTMLTextAreaElement) || e.metaKey || e.ctrlKey) && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      e.stopPropagation();
      send();
      return;
    }
    if (view === "details" && !typing && ref.kind === "event" && rsvp !== "organizer" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const c = RSVP_CHOICES.find((x) => x.key === e.key);
      if (c && ready) {
        e.preventDefault();
        e.stopPropagation();
        void pick({ type: "rsvp", answer: c.answer });
      }
    }
  }
</script>

<svelte:window onkeydowncapture={onkey} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="ref-card hud-m" role="dialog" aria-label="{KIND_WORD[ref.kind]}: {ref.name}" tabindex="-1" bind:this={card} data-ref-card={ref.kind} data-view={view} use:floatMenu={{ anchor, align: "left", maxVh: 0.86 }} in:hudIn|global={{ anchor }} out:hudOut|global>
  <div class="rc-head hud-head">
    <span>{KIND_WORD[ref.kind]}</span>
    <span class="rc-acct" use:tip={accountState === "unknown" ? "The connector this was read through" : "The account this was read from"}>{account}</span>
    <button type="button" class="rc-x" aria-label="Close" use:tip={"Close (esc)"} onclick={onclose}><Icon name="x" size={11} /></button>
  </div>
  <div class="rc-title">{ref.name}</div>
  {#if whenLine(ref, now())}<div class="rc-when">{whenLine(ref, now())}</div>{/if}

  {#if view === "details"}
    {#if ref.kind === "email" && f.gist}<div class="rc-snip">{f.gist}</div>{/if}
    {#if detailRows(ref).length > 0 || pill}
      <dl class="rc-kv">
        {#each detailRows(ref) as [k, v] (k)}<dt>{k}</dt><dd>{v}</dd>{/each}
        {#if pill}<dt>You</dt><dd><span class="rc-pill {pill.look}" class:pulse={answered !== null}>{pill.words}</span></dd>{/if}
      </dl>
    {/if}
    {#if asOf}<div class="rc-note">Read {asOf}. Nothing here is fetched again until you act.</div>{/if}
    {#if warn}
      <div class="rc-warn" role="status">
        <span>{warn}</span>
        {#if accountState !== "failed" && onaccounts}<button type="button" class="ns-btn small rc-b" onclick={onaccounts}>{accountState === "signin" ? "Sign in again…" : "Open Sources…"}</button>{/if}
      </div>
    {/if}
    {#if draft?.mode && draft.body.trim()}
      <div class="rc-kept" role="status">
        <span>Your {MAIL_WORD[draft.mode].toLowerCase()} is kept here, unsent.</span>
        <button type="button" class="ns-btn small rc-b" disabled={!ready} use:tip={offWhy} onclick={() => draft?.mode && pick({ type: "mail", mode: draft.mode })}>Open draft</button>
      </div>
    {/if}

    {#if ref.kind !== "event" || rsvp !== "organizer"}
      <div class="rc-acts" role="group" aria-label="Actions">
        {#if ref.kind === "event"}
          {#each RSVP_CHOICES as c (c.answer)}
            <button type="button" class="ns-btn rc-b" class:on={rsvp === c.answer} disabled={!ready} use:tip={offWhy} onclick={() => pick({ type: "rsvp", answer: c.answer })}><kbd>{c.key}</kbd>{c.label}</button>
          {/each}
        {:else if ref.kind === "email"}
          {#each ["reply", "replyAll", "forward"] as const as m (m)}
            <button type="button" class="ns-btn rc-b" disabled={!ready} use:tip={offWhy} onclick={() => pick({ type: "mail", mode: m })}>{MAIL_WORD[m]}</button>
          {/each}
        {:else}
          <button type="button" class="ns-btn rc-b" disabled={!act || !f.link} use:tip={linkWhy} onclick={() => run({ type: "readHere" }, "read")}>Read it here</button>
          <button type="button" class="ns-btn rc-b" class:rc-lockrow={busy === "copy"} disabled={!act || !f.link} use:tip={linkWhy} onclick={() => run({ type: "copyLink" }, "copy")}>Copy link</button>
        {/if}
        {#if !act}<span class="rc-soon">{SOON}</span>{/if}
      </div>
    {/if}
    {#if failed}<div class="rc-warn" role="alert"><span>That did not go through: {failed}</span></div>{/if}
    {#if receipt?.gone}
      <div class="rc-warn rc-gone" role="status"><span>{receipt.text}</span></div>
    {:else if receipt}
      <div class="rc-rc" role="status"><span class="rc-stamp">{receipt.stamp}</span><span class="rc-rt">{receipt.text}</span></div>
    {/if}
  {:else if pending}
    <div class="rc-cf lk-shell" class:sending={busy !== null}>
      <AskLock header=".rc-q" />
      {#if pending.type === "rsvp"}
        {@const c = rsvpConfirm(ref, pending.answer)}
        {@const choice = RSVP_CHOICES.find((x) => x.answer === pendingAnswer)}
        <div class="rc-q">Confirm</div>
        <div class="rc-qt"><b>{c.ask}</b> {c.who}</div>
        <input class="rc-field" type="text" placeholder="Note to the organizer (optional)…" aria-label="Note to the organizer (optional)" value={note} oninput={(e) => keepDraft(key, { note: e.currentTarget.value })} bind:this={noteBox} disabled={busy !== null} />
        <div class="rc-row">
          <button type="button" class="ns-btn accent rc-b" class:rc-lockrow={busy === "send"} disabled={!canSend && busy !== "send"} onclick={send}>Send: {choice?.label} <span class="rc-ret">↵</span></button>
          <button type="button" class="ns-btn ghost rc-b" disabled={busy !== null} onclick={back}>Back <span class="rc-esc">esc</span></button>
        </div>
      {:else}
        <div class="rc-q">{MAIL_WORD[pending.mode]} · nothing sent yet</div>
        <div class="rc-draft">
          {#if pending.mode === "forward"}
            <label class="rc-to">To: <input type="text" placeholder="Who gets it — an address" aria-label="Forward to" value={to} oninput={(e) => keepDraft(key, { to: e.currentTarget.value })} disabled={busy !== null} /></label>
          {:else if heads.state === "ok" && recipients && heads.h}
            {@const hh = heads.h}
            <div class="rc-to" data-real-to>To: {recipients.to.map((a) => personWords(hh, a)).join(", ")}</div>
            {#if recipients.cc.length > 0}<div class="rc-to" data-real-cc>Cc: {recipients.cc.map((a) => personWords(hh, a)).join(", ")}</div>{/if}
          {:else if heads.state === "failed"}
            <div class="rc-to rc-bad" role="alert">To: could not be read from the message — {heads.why}. Nothing can be sent until it is.</div>
          {:else}
            <div class="rc-to rc-dim">To: reading who this goes to…</div>
          {/if}
          {#if pending.mode === "forward"}
            {#if heads.state === "ok" && heads.h}
              <div class="rc-to rc-dim" data-real-fwd>Forwarding: {heads.h.subject ?? ref.name} · from {personWords(heads.h, heads.h.from)}</div>
            {:else if heads.state === "failed"}
              <div class="rc-to rc-bad" role="alert">The message could not be read — {heads.why}. Nothing can be forwarded until it is.</div>
            {:else}
              <div class="rc-to rc-dim">Reading the message…</div>
            {/if}
          {/if}
          <textarea class="rc-body" rows="5" placeholder="Write your {MAIL_WORD[pending.mode].toLowerCase()}…" aria-label="Your {MAIL_WORD[pending.mode].toLowerCase()}" value={body} oninput={(e) => keepDraft(key, { mode: pending?.type === "mail" ? pending.mode : null, body: e.currentTarget.value })} bind:this={bodyBox} disabled={busy !== null}></textarea>
        </div>
        {#if discarding}
          <div class="rc-row" role="alertdialog" aria-label="Discard this draft?">
            <span class="rc-ask">Discard this draft? It cannot be brought back.</span>
            <span class="rc-gap"></span>
            <button type="button" class="ns-btn danger rc-b" onclick={discard}>Discard</button>
            <button type="button" class="ns-btn ghost rc-b" onclick={() => (discarding = false)}>Keep it</button>
          </div>
        {:else}
          <div class="rc-row">
            <button type="button" class="ns-btn accent rc-b" class:rc-lockrow={busy === "send"} disabled={!mailSend || (!canSend && busy !== "send")} use:tip={sendWhy} onclick={send}>Send to {sendTo || "…"} <span class="rc-ret">⌘↵</span></button>
            <button type="button" class="ns-btn rc-b" class:rc-lockrow={busy === "save"} disabled={(!body.trim() || busy !== null) && busy !== "save"} onclick={saveDraft}>Save as Gmail draft</button>
            <span class="rc-gap"></span>
            <button type="button" class="ns-btn ghost rc-b rc-danger" disabled={busy !== null} onclick={() => (body.trim() || to.trim() ? (discarding = true) : discard())}>Discard</button>
            <button type="button" class="ns-btn ghost rc-b" disabled={busy !== null} use:tip={"Back to the details; your words stay here"} onclick={back}>Back <span class="rc-esc">esc</span></button>
          </div>
        {/if}
      {/if}
      {#if failed}<div class="rc-warn in" role="alert"><span>That did not go through: {failed}. Nothing was dropped.</span></div>{/if}
      {#if undoneNote && !mailHold}<div class="rc-note rc-undone" role="status">{undoneNote}</div>{/if}
    </div>
  {/if}

  {#if maybeSent}
    <div class="rc-warn rc-maybe" role="alert">
      <span>{maybeSent}</span>
      <button type="button" class="ns-btn small rc-b" use:tip={"Only after you looked in Gmail's Sent\nand it is not there"} onclick={() => onchecked?.()}>I checked: not sent</button>
    </div>
  {/if}

  {#if mailHold}
    <div class="rc-hold" role="status" aria-live="polite" style:--rc-hold-ms="{Math.max(0, mailHold.until - Date.now())}ms">
      <span class="rc-hold-t">Sending to {mailHold.to} in <b>{holdLeft}</b> s</span>
      <span class="rc-gap"></span>
      <button type="button" class="ns-btn accent rc-b" use:tip={"Nothing is sent (esc)"} onclick={() => mailHold?.undo()}>Undo <span class="rc-esc">esc</span></button>
    </div>
  {/if}

  <div class="rc-sep hud-rule"></div>
  <button type="button" class="rc-go hud-row" disabled={!act || !f.link} use:tip={linkWhy} onclick={() => run({ type: "open" }, "open")}>
    <Icon name={ref.kind === "event" ? "calendar" : ref.kind === "email" ? "mail" : "drive"} size={14} />
    <span>{elsewhere.label}</span>
    {#if elsewhere.host && act}<span class="rc-host">{elsewhere.host}</span>{/if}
    {#if !act}<span class="rc-soon">{SOON}</span>{/if}
    <span class="rc-arr" aria-hidden="true">↗</span>
  </button>
</div>

<style>
  /* The card's own box; in Jarvis the glass, edge and shadow are `hud-m`'s (hudMenu.css). Classic: its plain sheet. */
  .ref-card {
    display: flex;
    flex-direction: column;
    width: 400px;
    max-width: calc(100vw - 16px);
    box-sizing: border-box;
    overflow-y: auto;
    outline: none;
    font-size: 13px;
    color: var(--ink);
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  }
  .ref-card > :global(*) {
    flex: none;
  }
  .rc-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 10px 8px 13px;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  /* The head's rule sits between the kind and the account (hud-head draws it last; order moves it). */
  .rc-head::after {
    order: 1;
  }
  .rc-head > .rc-acct {
    order: 2;
    font: 10px var(--mono);
    letter-spacing: 0.04em;
    text-transform: none;
    color: var(--dim);
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  :global([data-layout="classic"]) .rc-head::after {
    content: "";
    flex: 1;
  }
  .rc-x {
    order: 3;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--dim);
    cursor: pointer;
    transition:
      background-color 120ms,
      color 120ms,
      transform 80ms ease-out;
  }
  .rc-x:hover,
  .rc-x:focus-visible {
    background: var(--well);
    color: var(--ink);
    outline: none;
  }
  .rc-x:active {
    transform: scale(0.9);
    color: var(--accent-ink, var(--accent));
  }
  .rc-title {
    padding: 0 13px 1px;
    font: 600 16px/1.3 var(--sans);
    overflow-wrap: anywhere;
  }
  .rc-when {
    padding: 0 13px 8px;
    color: var(--ink2);
  }
  .rc-kv {
    display: grid;
    grid-template-columns: 86px 1fr;
    gap: 3px 10px;
    padding: 4px 13px 10px;
    margin: 0;
    font-size: 12.5px;
  }
  .rc-kv dt {
    color: var(--dim);
    font: 11px var(--mono);
    letter-spacing: 0.04em;
    padding-top: 2px;
  }
  .rc-kv dd {
    margin: 0;
    color: var(--ink2);
    overflow-wrap: anywhere;
  }
  .rc-pill {
    display: inline-block;
    font: 10.5px var(--mono);
    letter-spacing: 0.06em;
    padding: 1px 7px;
    border-radius: 99px;
    border: 1px solid var(--line2);
    color: var(--ink2);
  }
  .rc-pill.need {
    border-color: color-mix(in srgb, var(--partial) 55%, transparent);
    color: var(--partial);
    background: var(--partial-soft);
  }
  .rc-pill.ok {
    border-color: color-mix(in srgb, var(--done) 50%, transparent);
    color: var(--done);
    background: var(--done-soft);
  }
  .rc-snip {
    margin: 0 13px 10px;
    padding: 8px 10px;
    background: var(--term);
    border: 1px solid var(--line);
    border-radius: var(--r1, 5px);
    font-size: 12.5px;
    color: var(--ink2);
    overflow-wrap: anywhere;
  }
  .rc-note {
    padding: 0 13px 10px;
    font-size: 11.5px;
    color: var(--dim);
  }
  .rc-warn,
  .rc-kept {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 13px 10px;
    padding: 8px 10px;
    border-radius: var(--r1, 5px);
    font-size: 12px;
  }
  .rc-warn {
    background: var(--failed-soft);
    border: 1px solid color-mix(in srgb, var(--failed) 40%, transparent);
    color: var(--failed);
  }
  .rc-warn.in {
    margin: 10px 0 0;
  }
  .rc-kept {
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line2));
    color: var(--ink2);
  }
  .rc-warn > span,
  .rc-kept > span {
    flex: 1;
    min-width: 0;
  }
  /* A mail in its hold (993e): the countdown and its Undo, in the accent (the card's sending colour), with a bar
     that drains over the hold in both themes; reduced motion keeps the bar still. */
  .rc-hold {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 13px 10px;
    padding: 8px 10px;
    border-radius: var(--r1, 5px);
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line2));
    color: var(--ink);
    font-size: 12.5px;
    overflow: hidden;
  }
  .rc-hold::after {
    content: "";
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 100%;
    background: var(--accent);
    transform-origin: left;
    animation: rc-drain var(--rc-hold-ms, 5000ms) linear forwards;
  }
  .rc-to.rc-dim {
    color: var(--dim);
  }
  .rc-to.rc-bad {
    color: var(--failed);
  }
  .rc-hold-t b {
    font-variant-numeric: tabular-nums;
  }
  @keyframes rc-drain {
    to {
      transform: scaleX(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rc-hold::after {
      animation: none;
    }
  }
  .rc-acts {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
    padding: 10px 13px 11px;
    border-top: 1px solid var(--line);
  }
  .rc-go > span {
    white-space: nowrap;
  }
  .rc-soon {
    flex: none;
    white-space: nowrap;
    margin-left: auto;
    font: 10px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    border: 1px dashed var(--line2);
    border-radius: 99px;
    padding: 1px 7px;
  }

  /* ---- Buttons: the app's `.ns-btn` (its hover fill and item 927's press give), plus the question card's
     Lock-on ticks on hover — two amber corners that spring in (AskQuestions `.aq-opt`) — and an amber press. ---- */
  .rc-b {
    position: relative;
  }
  .rc-b kbd {
    font: 10.5px/16px var(--mono);
    padding: 0 5px;
    border: 1px solid var(--line2);
    border-radius: 4px;
    color: var(--dim);
    transition:
      border-color 120ms,
      color 120ms;
  }
  .rc-b:hover:not(:disabled) kbd,
  .rc-b:global(.rc-hov) kbd {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--line2));
    color: var(--accent-ink, var(--accent));
  }
  .rc-b.on {
    color: var(--done);
    border-color: color-mix(in srgb, var(--done) 55%, var(--line2));
    background: var(--done-soft);
  }
  .rc-ret,
  .rc-esc {
    font: 10px var(--mono);
    letter-spacing: 0.08em;
    opacity: 0.8;
  }
  .rc-esc {
    color: var(--dim);
  }
  .rc-danger {
    color: var(--failed);
  }
  :global(:where(:root:not([data-layout="classic"]))) .rc-b::before,
  :global(:where(:root:not([data-layout="classic"]))) .rc-b::after {
    content: "";
    position: absolute;
    width: 6px;
    height: 6px;
    box-sizing: border-box;
    border: 1.5px solid var(--bracket, transparent);
    opacity: 0;
    pointer-events: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .rc-b::before {
    left: -3px;
    top: -3px;
    border-right: 0;
    border-bottom: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .rc-b::after {
    right: -3px;
    bottom: -3px;
    border-left: 0;
    border-top: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .rc-b:hover:not(:disabled)::before,
  :global(:where(:root:not([data-layout="classic"]))) .rc-b:hover:not(:disabled)::after,
  :global(:where(:root:not([data-layout="classic"]))) .rc-b:focus-visible::before,
  :global(:where(:root:not([data-layout="classic"]))) .rc-b:focus-visible::after,
  :global(:where(:root:not([data-layout="classic"]))) .rc-b:global(.rc-hov)::before,
  :global(:where(:root:not([data-layout="classic"]))) .rc-b:global(.rc-hov)::after {
    opacity: 1;
    transform: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .rc-b:global(.rc-hov):not(.accent):not(.ghost) {
    background: var(--well2);
    border-color: var(--dim);
  }
  :global(:where(:root:not([data-layout="classic"]))) .rc-b:active:not(:disabled):not(.accent) {
    background: color-mix(in srgb, var(--accent) 14%, var(--well2));
  }
  /* The bulb (hudMenu.css `.hud-m .ns-btn.accent`) lit a little more under the pointer, never a solid block. */
  :global(:root:not([data-layout="classic"]) .hud-m) .rc-b.accent:hover:not(:disabled),
  :global(:root:not([data-layout="classic"]) .hud-m) .rc-b.accent:global(.rc-hov) {
    background: color-mix(in srgb, var(--accent) 10%, var(--term));
    border-color: var(--accent);
    box-shadow:
      inset 0 0 14px color-mix(in srgb, var(--accent) 24%, transparent),
      0 0 18px color-mix(in srgb, var(--accent) 40%, transparent);
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .rc-b::before {
      transform: translate(-4px, -4px);
      transition:
        opacity 0.15s,
        transform 0.25s cubic-bezier(0.2, 0.9, 0.25, 1.3);
    }
    :global(:where(:root:not([data-layout="classic"]))) .rc-b::after {
      transform: translate(4px, 4px);
      transition:
        opacity 0.15s,
        transform 0.25s cubic-bezier(0.2, 0.9, 0.25, 1.3);
    }
    /* Sent: the pressed button locks amber (the menu's row-lock, 300 ms) while the rest of the confirm clears. */
    :global(:where(:root:not([data-layout="classic"]))) .rc-lockrow {
      animation: rc-rowlock 300ms linear both;
      opacity: 1;
    }
    :global(:where(:root:not([data-layout="classic"]))) .rc-cf.sending > :global(:not(.rc-row):not(.lk)),
    :global(:where(:root:not([data-layout="classic"]))) .rc-cf.sending .rc-row > :global(:not(.rc-lockrow)) {
      animation: rc-restclear 300ms linear both;
    }
    .rc-rc {
      animation: rc-rise 160ms ease-out both;
    }
    .rc-stamp,
    .rc-pill.pulse {
      animation: rc-stamp 400ms cubic-bezier(0.2, 0.9, 0.3, 1) 60ms both;
    }
    :global(:where(:root:not([data-layout="classic"]))) .rc-rc::after {
      animation: rc-sweep 700ms ease-out 80ms both;
    }
    .rc-go .rc-arr {
      transition:
        transform 160ms ease-out,
        color 120ms;
    }
  }
  @keyframes rc-rowlock {
    35%,
    100% {
      background: color-mix(in srgb, var(--accent) 22%, var(--raised));
      box-shadow: 0 0 16px color-mix(in srgb, var(--accent) 35%, transparent);
    }
  }
  @keyframes rc-restclear {
    0% {
      opacity: 1;
    }
    45%,
    100% {
      opacity: 0.15;
    }
  }
  @keyframes rc-rise {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
  }
  /* The question card's lock pulse (AskQuestions `aq-lock`). */
  @keyframes rc-stamp {
    0% {
      transform: scale(1.7);
      box-shadow: 0 0 0 0 var(--accent);
    }
    60% {
      transform: scale(0.92);
    }
    100% {
      transform: none;
      box-shadow: 0 0 0 8px transparent;
    }
  }
  @keyframes rc-sweep {
    to {
      transform: translateX(100%);
    }
  }

  /* ---- The confirm: the question card's lock-on shell ---- */
  .rc-cf {
    margin: 4px 10px 10px;
    padding: 11px 12px 10px;
    border-radius: var(--r2, 8px);
    background: color-mix(in srgb, var(--accent-soft) 70%, var(--raised));
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line2));
    --aq-bg: color-mix(in srgb, var(--accent-soft) 70%, var(--raised));
  }
  .rc-q {
    font: 500 10.5px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--dim);
    margin-bottom: 5px;
  }
  .rc-qt {
    margin-bottom: 8px;
  }
  .rc-field,
  .rc-body,
  .rc-to input {
    font: 12.5px/1.45 var(--sans);
    color: var(--ink);
    background: var(--term);
    border: 1px solid var(--line2);
    border-radius: var(--r1, 5px);
    outline: none;
    transition:
      border-color 120ms,
      box-shadow 120ms;
  }
  .rc-field {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 9px;
    margin-bottom: 10px;
  }
  .rc-field:focus,
  .rc-to input:focus,
  .rc-draft:focus-within {
    border-color: color-mix(in srgb, var(--accent) 70%, var(--line2));
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 14%, transparent);
  }
  .rc-draft {
    margin-bottom: 8px;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line2));
    border-radius: var(--r1, 5px);
    background: var(--term);
    transition:
      border-color 120ms,
      box-shadow 120ms;
  }
  .rc-to {
    display: flex;
    align-items: center;
    gap: 6px;
    font: 11px var(--mono);
    color: var(--dim);
    padding: 6px 9px;
    border-bottom: 1px solid var(--line);
  }
  .rc-to input {
    flex: 1;
    min-width: 0;
    border-color: transparent;
    background: transparent;
    padding: 1px 4px;
  }
  .rc-body {
    display: block;
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    min-height: 84px;
    max-height: 40vh;
    padding: 8px 9px;
    border: 0;
    background: transparent;
  }
  .rc-row {
    display: flex;
    align-items: center;
    gap: 7px;
    flex-wrap: wrap;
  }
  .rc-gap {
    flex: 1;
  }
  .rc-ask {
    font-size: 12.5px;
    color: var(--ink);
  }

  /* ---- The receipt: an answered question's stamp ---- */
  .rc-rc {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 10px 10px;
    padding: 8px 12px;
    border-radius: var(--r2, 8px);
    background: var(--term);
    border: 1px solid var(--line);
    font: 12px var(--mono);
    color: var(--ink2);
    overflow: hidden;
  }
  .rc-stamp {
    flex: none;
    color: var(--done);
    border: 1px solid color-mix(in srgb, var(--done) 50%, transparent);
    border-radius: 4px;
    padding: 2px 6px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-size: 11px;
  }
  .rc-rt {
    color: var(--accent-ink, var(--ink));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rc-rc::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--done) 18%, transparent), transparent);
    transform: translateX(-100%);
  }

  /* ---- The open-elsewhere row: a menu row at the card's foot (hudMenu's hover: the well and the amber lead) ---- */
  .rc-sep {
    height: 1px;
    margin: 0 13px 6px;
    background: var(--line2);
  }
  .rc-go {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 6px 6px;
    padding: 7px 8px;
    border: 0;
    background: transparent;
    color: var(--ink2);
    font: 12.5px var(--sans);
    text-align: left;
    cursor: pointer;
    transition:
      background-color 120ms,
      box-shadow 120ms,
      color 120ms,
      transform 80ms ease-out;
  }
  .rc-go:hover:not(:disabled),
  .rc-go:global(.rc-hov) {
    color: var(--ink);
  }
  .rc-go:active:not(:disabled) {
    transform: translateY(0.5px) scale(0.99);
    background: color-mix(in srgb, var(--accent) 12%, var(--well));
  }
  :global([data-layout="classic"]) .rc-go:hover:not(:disabled) {
    background: var(--well);
    border-radius: 6px;
  }
  .rc-go:disabled {
    cursor: default;
    opacity: 0.55;
  }
  .rc-host {
    font: 10.5px var(--mono);
    color: var(--dim);
    letter-spacing: 0.03em;
  }
  .rc-arr {
    margin-left: auto;
    font: 11px var(--mono);
    color: var(--dim);
  }
  .rc-go .rc-soon + .rc-arr {
    margin-left: 0;
  }
  .rc-go:hover:not(:disabled) .rc-arr,
  .rc-go:global(.rc-hov) .rc-arr {
    color: var(--accent-ink, var(--accent));
    transform: translate(2px, -2px);
  }
  @media (prefers-reduced-motion: reduce) {
    .rc-b kbd,
    .rc-x,
    .rc-go,
    .rc-field,
    .rc-draft {
      transition: none;
    }
    .rc-x:active,
    .rc-go:active:not(:disabled) {
      transform: none;
    }
  }
</style>
