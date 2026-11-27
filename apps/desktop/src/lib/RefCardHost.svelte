<script lang="ts">
  /**
   * Where the typed link's card lives (item 993c): one host for the whole window, mounted by `App.svelte`. A click
   * (or Return / Space) on any `a.nl-ref` — the chat, Home's reply strip and its full view, a brief, an aside docked
   * or floating, a quote — opens `RefCard` from that link; a click on the same link, Esc, ✕ or a press anywhere
   * outside closes it; a click on another link moves to that one. While the host is mounted the root carries
   * `data-ref-cards`, which is what gives the links their look (refTag.css) — a window without a host (the phone
   * until 993f, Quick Entry) draws the names plain.
   *
   * `act` is 993d's (`refAct.ts`): his confirmed click in the card, run as one connector call. The host keeps what
   * came back for the session — his answer to an event (so a card opened again shows it), the items the connector
   * said are gone (their links dim) — and offers the Undo: an answer he changed can be put back for a few seconds,
   * from a toast that outlives the card (blocker 2305). Undo is his click too, and runs the same way.
   *
   * A mail (993e) cannot be called back, so its Undo is a hold (`mailHold.ts`): his "Send to …" starts a
   * countdown here — on the card and on a toast that outlives it — and `act` is called only when it ends. Undo
   * in that time (either button, or Esc in the card) and nothing is called at all. Closing the card does not stop
   * the hold (the toast still offers Undo); quitting the app does — the command was never called, and his words
   * are still kept under the item (`refDrafts`), since only a mail that went drops them. One mail per item at a
   * time: a second click while one is held or going is refused.
   *
   * The phone (993f) mounts this same host with `sheet`: the card rises as a bottom sheet over a shade, and its
   * actions run on the Mac through the listener. There a mail's Send first takes a tap from the Mac (`armSend`, the
   * one-time tap for exactly that mail); the hold runs on the phone, and only its end sends the mail with that tap.
   * Undo is the phone's own (the tap is dropped, `disarm`); the phone losing the Mac at any moment of the hold
   * (`offline`) stops it, so nothing is sent. The "may have gone" lock the Mac keeps for both screens is read when a
   * card opens (`lockOf`) and cleared on both by "I checked: not sent" (`checked`).
   */
  import { onMount } from "svelte";
  import { shade } from "./refSheet";
  import RefCard from "./RefCard.svelte";
  import { refFromEl, refKey, type Ref } from "./refTag";
  import { accountOf, rsvpAnswerOf, rsvpOf } from "./refCard";
  import type { RefAction, RefReceipt, Rsvp, RsvpAnswer } from "./refCard";
  import type { HomeReach } from "./home";
  import type { RefUnfinished } from "./api";
  import { MAIL_HOLD_MS, MailUndone, isMaybeSent, secondsLeft, startHold, type HoldToast } from "./mailHold";
  import type { MailHeads } from "./refCard";
  import { refRunStart } from "./refRuns.svelte";
  import { clearMaybeSent, markMaybeSent, refMaybe } from "./refDrafts.svelte";

  let {
    reach,
    loadReach,
    act,
    mailSend = true,
    toast,
    holdToast,
    holdMs = MAIL_HOLD_MS,
    readMail,
    unfinished,
    onaccounts,
    sheet = false,
    offline,
    armSend,
    disarm,
    lockOf,
    checked,
  }: {
    /** What Home reaches, when the app already holds it. */
    reach?: () => HomeReach | null;
    /** Reads the last check (nothing is run) when it does not. */
    loadReach?: () => Promise<HomeReach>;
    act?: (ref: Ref, a: RefAction) => Promise<RefReceipt>;
    /** Whether a card's "Send to …" may send (993e). */
    mailSend?: boolean;
    /** Where the Undo is offered (the app's toasts). Without one no Undo is offered. */
    toast?: (text: string, action?: { label: string; run: () => void }) => void;
    /** Where a mail's hold is shown with its Undo when the card is closed (993e). */
    holdToast?: HoldToast;
    /** How long a mail waits for an Undo before it goes. */
    holdMs?: number;
    /** The read-only read of an email's own headers (993e review): who a reply really goes to. Without it no mail
     *  can be sent from a card (Send says why). */
    readMail?: (ref: Ref) => Promise<MailHeads>;
    /** Card actions on their way when the app last quit, read once at mount (993e review, finding 7). A mail's
     *  item gets the same kept "may have gone" lock as a send with no answer: Send stays off until he checked. */
    unfinished?: () => Promise<RefUnfinished[]>;
    onaccounts?: () => void;
    /** The phone (993f): the card is a bottom sheet over a shade. */
    sheet?: boolean;
    /** Why nothing can reach the Mac now (the phone offline, or reaching only the away server), else null. */
    offline?: () => string | null;
    /** The phone (993f): his Send's one-time tap from the Mac, for exactly this mail, at the start of its hold. */
    armSend?: (ref: Ref, a: Extract<RefAction, { type: "send" }>) => Promise<{ tap: string }>;
    /** The tap dropped (his Undo, or the hold stopped). */
    disarm?: (tap: string) => void;
    /** The "may have gone" lock the Mac keeps for both screens, read when a card opens. */
    lockOf?: (ref: Ref, mark?: string | null) => Promise<string | null>;
    /** He checked Gmail's Sent: the kept lock goes on the Mac too. */
    checked?: (key: string) => void;
  } = $props();

  let open = $state<{ ref: Ref; anchor: HTMLElement; n: number } | null>(null);
  let read = $state<HomeReach | null>(null);
  let seq = 0;
  // The items something was sent for this session: their links keep a ✓.
  const done = new Set<string>();
  // His answer to an event after an RSVP went through (or was undone) this session, by item.
  const answers = $state<Record<string, Rsvp>>({});
  // The items the connector said are not there any more: their links dim.
  const gone = new Set<string>();
  // A mail in its hold, by item: when it goes, and its Undo (993e). The card shows it while open.
  const holds = $state<Record<string, { until: number; to: string; undo: () => void }>>({});
  // A mail past its hold, by item, until the connector answered: no second one meanwhile.
  const going = new Set<string>();
  // A mail let through with no success back, by item: Send stays off until he says he checked (review, 4). Kept
  // beside the draft in storage, so a reload or restart keeps it (re-review, N2).
  const maybe = $derived(refMaybe.by);
  // A "may have gone" set on this screen that the Mac has not been told of yet, by item (993f).
  const untold = new Map<string, string>();
  // Each email's headers, read once a session (a failed read is tried again on the next open).
  const headsRead = new Map<string, Promise<MailHeads>>();
  function headsOf(ref: Ref): Promise<MailHeads> {
    const k = refKey(ref);
    let p = headsRead.get(k);
    if (!p) {
      p = readMail!(ref);
      headsRead.set(k, p);
      p.catch(() => headsRead.delete(k));
    }
    return p;
  }

  const linksOf = (k: string) => [...document.querySelectorAll<HTMLElement>("a.nl-ref")].filter((a) => {
    const r = refFromEl(a);
    return !!r && refKey(r) === k;
  });

  /** One action of his, and what the window keeps of its answer. */
  async function run(ref: Ref, a: RefAction): Promise<RefReceipt> {
    if (a.type === "send") return sendHeld(ref, a);
    const k = refKey(ref);
    const before = answers[k] ?? rsvpOf(ref.fields.rsvp);
    const reaches = a.type === "rsvp" || a.type === "saveDraft";
    const end = reaches ? refRunStart(a.type === "rsvp" ? `Answering ${ref.name}` : `Saving a draft · ${ref.name}`) : () => {};
    let r: RefReceipt;
    try {
      r = await act!(ref, a);
    } finally {
      end();
    }
    if (r.gone) {
      gone.add(k);
      for (const el of linksOf(k)) mark(el, "ref-gone", true);
      return r;
    }
    if (a.type === "rsvp" && r.rsvp) {
      answers[k] = r.rsvp;
      const back = rsvpAnswerOf(before);
      // An answer he changed can be put back; a first answer cannot be un-answered (the connector has no such call).
      if (toast && back && back !== r.rsvp) toast(r.text, { label: "Undo", run: () => void undo(ref, back) });
    }
    return r;
  }

  /** A mail: the hold, then — only if he did not undo it — the one call. */
  async function sendHeld(ref: Ref, a: Extract<RefAction, { type: "send" }>): Promise<RefReceipt> {
    const k = refKey(ref);
    if (holds[k] || going.has(k)) throw new Error("this mail is already on its way");
    if (maybe[k]) throw new Error("it may have gone already: check Sent in Gmail first");
    const who = a.to.trim() || "them";
    // The phone (993f): the Mac's tap for exactly this mail first. No tap, no hold: the card says why.
    let tap: string | undefined;
    if (armSend) {
      const why = offline?.();
      if (why) throw new Error(why);
      going.add(k);
      try {
        tap = (await armSend(ref, a)).tap;
      } finally {
        going.delete(k);
      }
    }
    const h = startHold(holdMs);
    // The phone losing the Mac at any moment of the hold stops it: nothing is sent (Undo is the phone's own).
    let lost: string | null = null;
    const watch = offline
      ? setInterval(() => {
          const why = offline();
          if (why && h.undo()) lost = why;
        }, 250)
      : undefined;
    const words = () => `Sending to ${who} in ${secondsLeft(h.until)} s`;
    const tid = holdToast?.start(words(), () => void h.undo());
    const ticker = setInterval(() => tid !== undefined && holdToast?.update(tid, words()), 1000);
    holds[k] = { until: h.until, to: who, undo: () => void h.undo() };
    let go = await h.done;
    clearInterval(ticker);
    if (watch !== undefined) clearInterval(watch);
    delete holds[k];
    if (go && offline) {
      lost = offline();
      if (lost) go = false;
    }
    if (!go) {
      if (tap !== undefined) disarm?.(tap);
      const lostWords = lost ? "Not sent: your phone lost your Mac during the hold. Your words are still here." : null;
      if (tid !== undefined) holdToast?.settle(tid, lostWords ?? `Not sent to ${who}: undone. Your words are kept in the card.`);
      throw new MailUndone(lostWords ?? undefined);
    }
    going.add(k);
    if (tid !== undefined) holdToast?.settle(tid, `Sending to ${who}…`);
    const end = refRunStart(`Sending mail to ${who}`);
    try {
      const r = await act!(ref, tap !== undefined ? { ...a, tap } : a);
      if (r.gone) {
        gone.add(k);
        for (const el of linksOf(k)) mark(el, "ref-gone", true);
      } else {
        done.add(k);
        for (const el of linksOf(k)) mark(el, "ref-done", true);
      }
      if (tid !== undefined) holdToast?.settle(tid, r.text);
      return r;
    } catch (e) {
      const why = String(e instanceof Error ? e.message : e);
      if (isMaybeSent(e)) {
        markMaybeSent(k, why);
        // Told to the Mac when it next answers (the phone may have lost it as the mail went).
        if (lockOf) untold.set(k, why);
        if (tid !== undefined) holdToast?.settle(tid, `To ${who}: ${why}`);
      } else if (tid !== undefined) holdToast?.settle(tid, `Not sent to ${who}: ${why}`);
      throw e;
    } finally {
      end();
      going.delete(k);
    }
  }

  async function undo(ref: Ref, back: RsvpAnswer): Promise<void> {
    const k = refKey(ref);
    try {
      const r = await act!(ref, { type: "rsvp", answer: back, note: "" });
      if (r.gone) {
        gone.add(k);
        for (const el of linksOf(k)) mark(el, "ref-gone", true);
        toast?.(`Could not undo: ${r.text}`);
        return;
      }
      answers[k] = r.rsvp ?? back;
      toast?.(`Put back: ${r.text}`);
    } catch (e) {
      toast?.(`Could not undo the answer: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  const known = $derived(reach?.() ?? read);
  const account = $derived(open ? accountOf(known, open.ref.src) : null);

  function mark(el: HTMLElement | null, cls: string, on: boolean): void {
    if (el?.isConnected) el.classList.toggle(cls, on);
  }

  function show(a: HTMLElement, ref: Ref): void {
    if (open) mark(open.anchor, "ref-open", false);
    open = { ref, anchor: a, n: ++seq };
    mark(a, "ref-open", true);
    if (gone.has(refKey(ref))) mark(a, "ref-gone", true);
    // The lock the Mac keeps for both screens (993f), synced both ways: a lock set here the Mac was not told of
    // goes first, then this screen mirrors the Mac's — set on either, cleared by "I checked" on either. A Mac that
    // cannot be asked leaves this screen's lock as it is.
    const lk = refKey(ref);
    const toTell = untold.get(lk) ?? null;
    void lockOf?.(ref, toTell)
      .then((why) => {
        untold.delete(lk);
        if (why) markMaybeSent(lk, why);
        else clearMaybeSent(lk);
      })
      .catch(() => {});
    if (!reach?.() && !read && loadReach)
      void loadReach()
        .then((r) => (read = r))
        .catch(() => {});
  }

  function close(refocus = true): void {
    if (!open) return;
    const a = open.anchor;
    mark(a, "ref-open", false);
    open = null;
    if (refocus && a.isConnected) a.focus({ preventScroll: true });
  }

  const linkOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("a.nl-ref") : null);

  function toggle(a: HTMLElement, e: Event): boolean {
    const ref = refFromEl(a);
    // A link that does not check out is plain words: nothing opens, and the click is not taken.
    if (!ref) return false;
    e.preventDefault();
    e.stopPropagation();
    if (open?.anchor === a) close();
    else show(a, ref);
    return true;
  }

  onMount(() => {
    void unfinished?.()
      .then((left) => {
        for (const u of left) {
          const about = u.item ? ` (${u.item})` : "";
          if (u.mail) {
            toast?.(`Nightloom quit while ${u.what} was going${about}. It may have gone: check Sent in Gmail before sending again.`);
            if (u.key) markMaybeSent(u.key, `Nightloom quit while ${u.what} was going. It may have gone: check Sent in Gmail before sending again.`);
          } else toast?.(`Nightloom quit while ${u.what} was going${about}. It may have gone through: open the event to check.`);
        }
      })
      .catch(() => {});
    const root = document.documentElement;
    root.dataset.refCards = "1";
    const onClick = (e: MouseEvent) => {
      const a = linkOf(e.target);
      if (a && e.button === 0) toggle(a, e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const a = e.target instanceof HTMLElement && e.target.matches("a.nl-ref") ? e.target : null;
      if (a) toggle(a, e);
    };
    const onDown = (e: PointerEvent) => {
      if (!open) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(".ref-card, .nl-tip, .ref-hold-bar")) return;
      // A press on a link is the click's to handle (toggle, or move to another).
      if (linkOf(t)) return;
      close(false);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      delete root.dataset.refCards;
    };
  });

  // The reply was drawn again (a streaming turn, a tab switch) and the link is a new element: the card stays where
  // it is until he closes it; if the link is gone altogether, so is the mark, and nothing else changes.
  // The card's own item, never whichever card is open when an action finishes (993e review, finding 5).
  function sent(k: string): void {
    done.add(k);
    for (const el of linksOf(k)) mark(el, "ref-done", true);
  }
</script>

{#if sheet && open && account}
  <!-- The phone's sheet (993f): a shade behind it, 220 ms; a press on it closes the sheet (the host's pointerdown). -->
  <div class="ref-shade" aria-hidden="true" transition:shade></div>
{/if}
{#if open && account}
  {#key open.n}
    <RefCard
      ref={open.ref}
      anchor={open.anchor}
      account={account.label}
      accountState={account.state}
      act={act ? ((r) => (a: RefAction) => run(r, a))(open.ref) : undefined}
      {mailSend}
      mailHold={holds[refKey(open.ref)] ?? null}
      rsvpNow={answers[refKey(open.ref)] ?? null}
      onclose={() => close()}
      onaccounts={onaccounts ? () => (close(false), onaccounts()) : undefined}
      ondone={((k) => () => sent(k))(refKey(open.ref))}
      readHeads={readMail ? ((r) => () => headsOf(r))(open.ref) : undefined}
      me={known?.accounts.find((x) => x.connector === open?.ref.src)?.address ?? null}
      maybeSent={maybe[refKey(open.ref)] ?? null}
      onchecked={((k) => () => (untold.delete(k), clearMaybeSent(k), checked?.(k)))(refKey(open.ref))}
      {sheet}
      offline={offline?.() ?? null}
    />
  {/key}
{/if}

<style>
  /* The phone's shade behind the sheet (993f). */
  .ref-shade {
    position: fixed;
    inset: 0;
    z-index: 79;
    background: var(--scrim, rgba(0, 0, 0, 0.5));
  }
</style>
