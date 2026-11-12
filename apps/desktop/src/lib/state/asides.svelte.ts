// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { noteChatProject } from "../handoff.svelte";
import type { AsideFold, FoldRecord } from "../asideFold";
import { nextAttachmentId, readDraft, setDraftAttachments, setDraftText, hasDraft, discardDraft } from "../drafts.svelte";
import { asideFollowUp, asideQuestion, type AsideQuote } from "../asideQuote";
import { type AsideAnchor, MAX_OPEN_ASIDES, foldTheOldest } from "../asideCard";
import type { AsideRead } from "../cache";
import { asideDraftKey, ensureAsideUid, loadAsides, nextAsideId } from "../asides";
import { loadCouncilPrefs, type CouncilPrefs } from "../council";
import * as tabs from "../tabs";
import type { TabContent } from "../tabs";
import { pdfFileName, pdfRoute } from "../attachKinds";
import type { Attachment, AsideSendOptions, TurnEvent } from "../types";
import { type Segment, app, closeThinking, applyToSegments } from "../state.svelte";
import { limitPauseFrom, type LimitPause } from "../limit";

/** One exchange of the open chat's aside (backlog 081; streamed since
 *  backlog 128; a thread of them since backlog 130) — see `app.aside`. */
export interface AsideTurn {
  /** Tells this exchange's deltas and result from a cancelled or replaced
   *  one's: the backend echoes it on every `aside-delta`. */
  seq: number;
  /** His question as typed — not the framed string the backend gets. */
  question: string;
  /** The answer as it streams (backlog 128): what has arrived so far,
   *  drawn as it lands; equal to `answer` once that is set. */
  partial: string;
  /** The whole answer, once the backend's result is in; null while asking. */
  answer: string | null;
  error: string | null;
  /** × pressed mid-stream: the partial text stays on the card, marked. */
  cancelled: boolean;
  cacheRead: number;
  /** What the question carried from the composer (backlog 283), drawn in
   *  his bubble as the chat's are. In memory with their bytes (a follow-up
   *  sends them again, blocker 960); the store keeps names and kinds only. */
  attachments?: Attachment[];
  /** The model that answered and its tokens (backlog 283), for the reply's
   *  header and footer; absent while asking and on a stored turn. */
  model?: string | null;
  usage?: { input_tokens: number; output_tokens: number; cache_read_tokens?: number };
  /** Until item 675 (2026-11-12) the aside's spend (item 605) — but what
   *  it held was the CLI's `total_cost_usd`, which on an aside's fork is
   *  the **whole chat's** running cost plus the answer's: three easy
   *  answers on a $12 chat read "$40.47". Kept only as a stored turn read
   *  it back; nothing sums it. */
  cost?: number;
  /** What this answer itself added, at API prices (item 675): the CLI's
   *  estimate less the chat's running cost its fork restored. The aside
   *  tab's bar and column sum these; absent while asking, when none came,
   *  and on a turn answered before 675. */
  added?: number;
  /** The newest round's prompt plus output (item 675): what the next
   *  follow-up carries. `usage` sums the answer's rounds, each of which
   *  sends the chat's prefix again. Absent on a turn answered before 675. */
  context?: number;
  /** Item 674: the answer's share of the plan, estimated from `added` at
   *  the fitted rates (`ask_aside`'s `plan_est`); kept by the store. */
  planEst?: { five_hour: number | null; seven_day: number | null; replies: number };
  /** Item 674: the plan's usage limit stopped this answer — the shared
   *  transcript's limit card stands under it, with Ask again. In memory
   *  only: after a relaunch the error text stands. */
  limit?: LimitPause;
  /** Item 674: Ask again was pressed before the window reset — it goes at
   *  this time (ms epoch) while the aside is on screen. In memory only. */
  limitAskAt?: number | null;
  /** When the answer ended (ISO), for the footer's time. */
  at?: string;
  /** Item 677: when the aside's request went out (ms epoch) and what its
   *  newest round read from cache — an answer that read the chat's cache
   *  restarts the cache's hour (`cacheState`'s `asides`). Absent on a turn
   *  answered before 677, which then moves nothing. */
  readAt?: number;
  roundRead?: number;
  /** Clock when it was asked (backlog 309): the running list's elapsed.
   *  In memory only; a stored turn is never running. */
  startedAt?: number;
  /** How long the answer took (item 639), kept by the store so a stored
   *  turn's "This turn" clock survives a relaunch; `startedAt` is not kept. */
  tookMs?: number;
  /** The turn as the chat's live reply holds it (item 403): its thinking,
   *  calls and text in order, built by the chat's own `applyToSegments`
   *  from `aside-delta` and `aside-turn-event`, so `AssistantMessage`
   *  draws an aside's turn as it draws the chat's — the thinking block's
   *  arrival, the activity rows, the working moon. ~~In memory only; a
   *  stored turn is its text (`partial`)~~ — kept by the store, trimmed,
   *  since item 674 step 6 (`asides.ts` `storeSegs`); a turn stored
   *  before has none and is its text. */
  segments?: Segment[];
  /** Where it stands before it runs (item 404): `queued` while the
   *  chat's own turn holds the agent, `running` once the aside has it. */
  phase?: "queued" | "running";
  /** When anything of it last arrived (item 404): the stalled notice
   *  counts from here (`asideWait`). */
  heardAt?: number;
}

/** The open chat's aside (backlog 081, the passage form backlog 107) — see
 *  `app.aside`. */
export interface Aside {
  /** The thread's own id (backlog 176): several are open at once, and a
   *  tab or the side panel shows the one it names. Per window. */
  id: number;
  /** Folded to its head row (blocker 318): past `MAX_OPEN_ASIDES` open
   *  cards the oldest fold; a click on the strip opens it again. */
  folded?: boolean;
  /** The highlighted passage the thread is about, if any. */
  quote: AsideQuote | null;
  /** Opened from a selection and not yet asked: the card is the question box. */
  draft: boolean;
  /** The exchanges in order; the last one is the live one. Empty only
   *  while a draft. */
  turns: AsideTurn[];
  /** Where the passage is in the transcript (backlog 141): the floating
   *  card opens under it and the text stays marked. Null for a composer
   *  aside, which has no passage; the card then sits above the composer
   *  (blocker 225). */
  anchor: AsideAnchor | null;
  /** Where he moved the floating card, in window px (backlog 156): kept
   *  while the thread is open, never saved — a relaunch puts the card back
   *  under its passage. Absent or null: the card is at its home. */
  moved?: { left: number; top: number; width: number } | null;
  /** Text typed in the thread's box and not yet sent (backlog 228): the
   *  question in a draft's box, or the follow-up under an answered
   *  thread — the two never show at once. Kept here, not in the card, so
   *  a chat switch, a closed tab or a relaunch does not lose it
   *  (`asides.ts` writes it); a close with text in it asks first
   *  (`requestDismissAside`). */
  unsent?: string;
  /** The name he gave the thread (item 265), written with it by
   *  `asides.ts`; absent when unnamed (`asideLabel` then calls it by its
   *  first question). Set through `renameAside` (`asides.svelte.ts`). */
  name?: string;
  /** *Fold into thread* under way (nightshift backlog 282): the picker,
   *  the running turn, or the summary to review — written with the thread
   *  by `asides.ts`, so closing the card or a relaunch keeps the text. */
  fold?: AsideFold;
  /** Each time this aside was folded into a thread's log.md (282), for
   *  the "already folded at …" warning. */
  foldedInto?: FoldRecord[];
  /** A stable name for the thread (backlog 283), written with it: the key
   *  its composer's chips and held messages live under in the drafts store
   *  (`asideDraftKey`), which must outlive a relaunch, as `id` does not. */
  uid?: string;
  /** His model / effort for this aside (backlog 283), picked in its
   *  composer; absent or null is the chat's own. */
  model?: string | null;
  effort?: string | null;
}

/** The aside's live exchange — the last turn while it is still asking. */
export function asideAsking(a: Aside | null): AsideTurn | null {
  const t = a?.turns[a.turns.length - 1] ?? null;
  return t && t.answer === null && t.error === null && !t.cancelled ? t : null;
}

/**
 * Whether a chat's aside thread is showing in a tab of its own (backlog
 * 130 part 2) or in the side panel (backlog 141 pass 2): the transcript
 * hides its card while one is, and shows it again when the tab or the
 * panel closes — the thread itself never moves (blocker 194).
 */
export function asideInTab(session: string | null, thread?: number): boolean {
  if (session === null) return false;
  // Several threads per chat (backlog 176): with `thread`, only that
  // thread's tab or panel counts; a tab or panel naming no thread shows
  // the chat's front one.
  const front = asideOf(session)?.id;
  const shows = (named: number | null | undefined) => thread === undefined || (named ?? front) === thread;
  if (app.asidePanel === session && shows(app.asidePanelThread)) return true;
  return tabs
    .allTabs(app.tabs)
    .some((t) => t.content.kind === "aside" && t.content.session === session && shows(asideTabThread(t.content)));
}

/** The thread an aside tab names (backlog 176); absent on a tab made
 *  before threads had ids. Read loosely so `tabs.ts` may name it or not. */
export function asideTabThread(content: TabContent): number | undefined {
  const t = (content as { thread?: unknown }).thread;
  return typeof t === "number" ? t : undefined;
}

/**
 * Every answered aside's read of the chat's cache (item 677), for
 * `cacheState`: an aside is a fork of the chat on its cache, so one that
 * read it refreshed it. A cancelled or failed turn, and one answered
 * before 677, gives none.
 */
export function asideReads(session: string | null | undefined): AsideRead[] {
  if (!session) return [];
  const out: AsideRead[] = [];
  for (const a of asidesOf(session))
    for (const t of a.turns)
      if (!t.cancelled && !t.error && t.readAt != null && t.roundRead != null) out.push({ at: t.readAt, read: t.roundRead });
  return out;
}

/** A chat's aside threads, oldest first: the open chat's cards, or a
 *  stashed chat's list (backlog 176). */
export function asidesOf(session: string): Aside[] {
  if (session === app.activeSessionId) return app.asides;
  return asideStash.get(session) ?? [];
}

/**
 * The aside thread a tab shows: the open chat's card, or the stashed
 * thread of a chat that is not open (read-only there — the backend forks
 * the open chat, so a follow-up needs the chat in front).
 */
export function asideOf(session: string, thread?: number | null): Aside | null {
  const list = asidesOf(session);
  // Since backlog 176: the thread named, else the chat's front (newest).
  if (thread !== undefined && thread !== null) return list.find((a) => a.id === thread) ?? null;
  return list[list.length - 1] ?? null;
}

/**
 * Ask a side question of the open chat without adding to it (backlog 081):
 * the answer comes from the chat's context off its warm cache, and neither
 * the question nor the answer is in the log or the CLI's session. ~~One at
 * a time~~ — several threads may be open since backlog 176 (2026-09-23),
 * each its own card; the backend's lock still lets **one ask at a time**
 * (blocker 317's default), so a second question waits, its card marked
 * (`asideWaiting`), and a running turn is waited for as before.
 *
 * `draft` is the card's own draft thread when a passage's question box
 * asks: that thread becomes the asked one, in place. Without it a quote
 * opens a new card.
 */
let asideSeq = 0;
/**
 * What the aside's composer sends besides the words (backlog 283): the
 * chips — kept on the exchange, so his bubble shows them as the chat's
 * do — and the thread's own model / effort, absent for the chat's.
 */
export interface AsideAsk {
  attachments?: Attachment[];
}
export async function askAside(
  question: string,
  quote: AsideQuote | null = null,
  draft: Aside | null = null,
  ask: AsideAsk = {},
): Promise<void> {
  const q = question.trim();
  const chips = ask.attachments ?? [];
  if ((!q && !quote && chips.length === 0) || app.connection?.engine !== "claude-code") return;
  const own = draft && draft.draft && app.asides.includes(draft) ? draft : null;
  // From the composer, with an answered thread on the card (backlog 137,
  // blocker 201): the question continues that thread rather than
  // replacing it — the thread is written nowhere else. With several open
  // (backlog 176, blocker 319): the newest composer thread, the one with
  // no passage; a passage's thread is about its passage, not this. Not
  // when a thread's own composer asks (283): its draft is the thread.
  const on = [...app.asides].reverse().find((a) => a.quote === null && !a.draft) ?? null;
  if (!own && !quote && q && on && !asideAsking(on) && on.turns.some((t) => t.partial.trim())) {
    await followUpAside(q, on, ask);
    return;
  }
  // About a passage (backlog 107): the highlighted text rides inside the
  // one string the backend takes, framed as a selection and quoted
  // exactly (`asideQuestion`); the card keeps his words and the quote
  // apart. The backend is 081's, untouched.
  const words = q || ATTACHMENTS_ONLY;
  const sent = quote ? asideQuestion(quote, words) : words;
  const seq = ++asideSeq;
  const turn: AsideTurn = { seq, question: q, partial: "", answer: null, error: null, cancelled: false, cacheRead: 0, startedAt: Date.now() };
  if (chips.length > 0) turn.attachments = chips.map((c) => ({ ...c }));
  // ~~A running exchange is replaced (one at a time): cancelled on the
  // backend~~ — nothing is replaced since backlog 176: the other cards
  // keep their threads, and a running one runs on.
  let thread: Aside;
  if (own) {
    // The card's draft (backlog 141): asked under its passage, in place.
    own.quote = quote;
    own.draft = false;
    own.turns.push(turn);
    thread = own;
  } else {
    thread = openAsideThread({ id: nextAsideId(), quote, draft: false, turns: [turn], anchor: null });
  }
  await runAside(turn, sent, thread, chips);
}

/** The words sent for a question that is chips alone (backlog 283): the
 *  CLI takes no empty prompt. His bubble shows the chips, not this. */
export const ATTACHMENTS_ONLY = "(The user sent only the attachments above.)";

/** A new card for the open chat (backlog 176): appended, the newest, and
 *  the oldest folded past `MAX_OPEN_ASIDES` (blocker 318). */
function openAsideThread(a: Aside): Aside {
  // Its drafts-store name (backlog 283), before anything keys by it.
  ensureAsideUid(a);
  app.asides.push(a);
  const live = app.asides[app.asides.length - 1]!;
  foldCrowd(live);
  syncFrontAside();
  return live;
}

/** Fold the oldest open cards past the cap, never `keep` (blocker 318). */
function foldCrowd(keep: Aside | null): void {
  const list = app.asides;
  const idx = keep ? list.indexOf(keep) : -1;
  for (const i of foldTheOldest(list.map((a) => a.folded === true), idx < 0 ? null : idx, MAX_OPEN_ASIDES)) {
    list[i]!.folded = true;
  }
}

/** A folded card's strip clicked (blocker 318): open, and the oldest other
 *  open card folds if that makes one too many. */
export function unfoldAside(a: Aside): void {
  a.folded = false;
  foldCrowd(a);
}

/** `app.aside`, the front thread, kept equal to the newest of `app.asides`
 *  (backlog 176) for what still reads one card. */
function syncFrontAside(): void {
  app.aside = app.asides[app.asides.length - 1] ?? null;
}

/**
 * Whether the thread's live exchange is waiting for another aside to
 * finish (backlog 176, blocker 317): the backend answers one aside at a
 * time, in the order asked, so an exchange is waiting while an earlier
 * one — on any card, in any chat — is still asking.
 */
export function asideWaiting(a: Aside | null): boolean {
  const t = asideAsking(a);
  if (!t) return false;
  const all = [...app.asides, ...[...asideStash.values()].flat()];
  return all.some((b) => {
    const u = asideAsking(b);
    return u !== null && u.seq < t.seq;
  });
}

/**
 * Run one exchange of the aside to its end (backlog 128): the deltas land
 * through the `aside-delta` listener in `init` while this awaits the
 * result; the result's text then stands in for the partial, so the card
 * shows the whole answer even where a delta was lost. A turn cancelled
 * from the card keeps its partial text and ignores the late result.
 */
async function runAside(turn: AsideTurn, sent: string, thread: Aside | null = null, chips: Attachment[] = []): Promise<void> {
  const live = () => findAsideTurn(turn.seq);
  try {
    const res = await api.askAside(sent, turn.seq, asideWire(thread, chips));
    const t = live();
    if (!t || t.cancelled) return; // dismissed, replaced or cancelled meanwhile
    settleAsideSegments(t, res.answer);
    t.answer = res.answer;
    t.partial = res.answer;
    t.error = res.is_error ? (res.notices.join("; ") || "the aside failed") : null;
    t.cacheRead = res.cache_read;
    // Backlog 283: drawn as a reply, under its model, with its figure.
    if (res.model) t.model = res.model;
    if (res.output_tokens !== undefined)
      t.usage = { input_tokens: res.input_tokens ?? 0, output_tokens: res.output_tokens, cache_read_tokens: res.cache_read };
    // Item 605: the aside's spend, for its tab's bar and column. Item
    // 675: what this answer added (the backend takes the chat's running
    // cost off), and the context its last round left.
    if (typeof res.cost_usd === "number") t.added = res.cost_usd;
    if (typeof res.context_tokens === "number") t.context = res.context_tokens;
    // Item 674: the plan share the shared footer shows, and the limit card.
    if (res.plan_est) t.planEst = { ...res.plan_est };
    if (res.limit) t.limit = limitPauseFrom({ limit: res.limit }, null) ?? undefined;
    // Item 677: the answer's read of the chat's cache, for the cache bar.
    if (!res.is_error && typeof res.sent_ms === "number" && typeof res.round_read === "number") {
      t.readAt = res.sent_ms;
      t.roundRead = res.round_read;
    }
    t.at = new Date().toISOString();
  } catch (e) {
    const t = live();
    if (t && !t.cancelled) t.error = String(e);
  }
}

/**
 * The wire form of an aside's question (backlog 283): its chips split as
 * a turn's are, and the thread's own model / effort when he picked one.
 * A chip without bytes (one read back from the store, names only) is not
 * sent. Pure; exported for the suite.
 */
export function asideWire(thread: Pick<Aside, "model" | "effort"> | null, chips: readonly Attachment[]): AsideSendOptions {
  const out: AsideSendOptions = {};
  const live = chips.filter((c) => c.data && !c.pending);
  const images = live.filter((c) => c.kind === "image").map(({ media_type, data }) => ({ media_type, data }));
  // A long PDF goes by path (item 491): an aside always runs on Claude Code.
  const byPath = (c: Attachment) => pdfRoute(c, "claude-code") === "path";
  const documents = live
    .filter((c) => c.kind === "document" && !byPath(c))
    .map(({ media_type, name, data }) => ({ media_type, name, data }));
  const files = [
    ...live.filter((c) => c.kind === "file").map(({ name, data }) => ({ name, data })),
    ...live.filter(byPath).map(({ name, data, pages }) => ({ name: pdfFileName(name), data, pages })),
  ];
  if (images.length) out.images = images;
  if (documents.length) out.documents = documents;
  if (files.length) out.files = files;
  if (thread?.model != null && thread.model !== "") out.model = thread.model;
  if (thread?.effort != null) out.effort = thread.effort;
  return out;
}

/**
 * A follow-up in the aside's own thread (nightshift backlog 130): the
 * card's reply box. The CLI's aside is single-shot, so the thread so far
 * — each earlier question and the answer as he saw it, the passage first
 * when there is one — travels inside the new question (`asideFollowUp`),
 * and the chat's context is the fork's as before. The new exchange is
 * appended to the card; nothing enters the chat or the CLI's files.
 *
 * Chips (backlog 283; blocker 960's default): the earlier exchanges'
 * chips go again with the new question, as their words do — the fork
 * never saw them otherwise — so "the image above" means something. Only
 * chips still holding their bytes: one read back after a relaunch is a
 * name, and the words say it was there.
 */
export async function followUpAside(question: string, thread: Aside | null = null, ask: AsideAsk = {}): Promise<void> {
  const q = question.trim();
  const chips = ask.attachments ?? [];
  // The card's own thread (backlog 176); the front one when none is named.
  const a = thread ?? app.aside;
  if ((!q && chips.length === 0) || !a || a.draft || asideAsking(a) || app.connection?.engine !== "claude-code") return;
  const prior = a.turns
    .filter((t) => t.partial.trim())
    .map((t) => ({ question: t.question || ATTACHMENTS_ONLY, answer: t.partial }));
  const sent = asideFollowUp(a.quote, prior, q || ATTACHMENTS_ONLY);
  const earlier = a.turns.flatMap((t) => t.attachments ?? []).filter((c) => c.data);
  const turn: AsideTurn = { seq: ++asideSeq, question: q, partial: "", answer: null, error: null, cancelled: false, cacheRead: 0, startedAt: Date.now() };
  if (chips.length > 0) turn.attachments = chips.map((c) => ({ ...c }));
  a.turns.push(turn);
  await runAside(turn, sent, a, [...earlier, ...chips]);
}

/**
 * Rewind an aside to before exchange `index` (backlog 283, the message
 * menu's Rewind): that exchange and every later one leave the thread, and
 * his question goes back into the aside's box — in front of anything
 * typed there, as the chat's rewind puts his message back (247) — with its
 * chips. Returns what left, for Undo (`restoreAsideTurns`). With no
 * exchange left the thread is a question box again (`draft`).
 */
export function rewindAside(a: Aside, index: number, intoBox = true): AsideTurn[] {
  if (index < 0 || index >= a.turns.length || asideAsking(a)) return [];
  const gone = a.turns.splice(index);
  const first = gone[0]!;
  if (a.turns.length === 0) a.draft = true;
  if (intoBox) {
    const key = asideDraftKey(a);
    const now = readDraft(key).text;
    const q = first.question;
    setAsideUnsent(a, q ? (now ? `${q}\n${now}` : q) : now);
    const chips = (first.attachments ?? []).filter((c) => c.data).map((c) => ({ ...c, id: nextAttachmentId() }));
    if (chips.length > 0) setDraftAttachments(key, [...readDraft(key).attachments, ...chips]);
  }
  return gone;
}

/** Undo a rewind (backlog 283): the exchanges back at the thread's end,
 *  in order, when nothing was asked since; `false` when the thread moved on. */
export function restoreAsideTurns(a: Aside, at: number, turns: AsideTurn[]): boolean {
  if (turns.length === 0 || a.turns.length !== at || asideAsking(a)) return false;
  a.turns.push(...turns);
  a.draft = false;
  return true;
}

/**
 * The aside thread of each chat left open (backlog 130): a chat switch
 * used to clear the card; now the thread is kept under the chat's id, the
 * way drafts are kept (backlog 065), and comes back when the chat does —
 * ~~never written anywhere~~ written to localStorage since backlog 137
 * (2026-09-17, `asides.ts` / `asides.svelte.ts`: text only, debounced,
 * read back here at launch — a relaunch used to drop every thread). A
 * plain map, read once per switch. An exchange still streaming when the
 * chat is left keeps streaming into the stashed thread (`findAsideTurn`
 * looks here too), so the answer is whole when he returns.
 */
export const asideStash: Map<string, Aside[]> =
  typeof localStorage === "undefined" ? new Map() : loadAsides(localStorage);

/**
 * The council roster and mode each chat last used (nightshift backlog
 * 149, blocker 239): the Settings default until the popover changes it
 * for a chat, then that chat's, for the life of the window — the drafts
 * pattern, never persisted. The pending chat (no id yet) shares one slot.
 */
const councilByChat: Map<string, CouncilPrefs> = new Map();

/** Each chat opened in this launch, and the project it was opened in
 *  (backlog 309): where a stashed aside's chat lives. Plain, per window. */
export const chatHome: Map<string, { project: string | null; name: string | null }> = new Map();
const PENDING_COUNCIL = "\u0000pending";
export function councilFor(chat: string | null): CouncilPrefs {
  return councilByChat.get(chat ?? PENDING_COUNCIL) ?? loadCouncilPrefs();
}
export function setCouncilFor(chat: string | null, prefs: CouncilPrefs): void {
  councilByChat.set(chat ?? PENDING_COUNCIL, structuredClone(prefs));
}

/** Stash the open chat's threads and take the next chat's, if any —
 *  every open thread, not only the front one (backlog 176; 137's FE4).
 *  Exported for the suite; the chat openers call it. */
export function switchAside(next: string | null): void {
  // The project the chat being opened lives in (backlog 309): its asides,
  // stashed when he leaves it — for another project, maybe — are listed
  // under it in the running list.
  if (next !== null) chatHome.set(next, { project: app.project?.id ?? null, name: app.project?.name ?? null });
  // 545: the project layer of its hand-off mark.
  noteChatProject(next, app.project?.id ?? null);
  const from = app.activeSessionId;
  if (from !== null) {
    if (app.asides.length > 0) asideStash.set(from, app.asides);
    else asideStash.delete(from);
  }
  app.asides = next === null ? [] : (asideStash.get(next) ?? []);
  syncFrontAside();
}

/** The exchange with `seq`, on a card or in a stashed thread. */
export function findAsideTurn(seq: number): AsideTurn | null {
  for (const a of app.asides) {
    const t = a.turns.find((t) => t.seq === seq);
    if (t) return t;
  }
  for (const list of asideStash.values()) {
    for (const a of list) {
      const t = a.turns.find((t) => t.seq === seq);
      if (t) return t;
    }
  }
  return null;
}

/**
 * Open the aside card as a question box about a highlighted passage
 * (backlog 107): the quote is shown, nothing is sent until he asks.
 * ~~A running or answered aside is replaced — one at a time~~ — since
 * backlog 176 (2026-09-23) a new passage opens a **new card** beside the
 * others and replaces nothing; the new card's box takes the caret.
 * Returns the new thread (null off the Claude Code engine).
 */
export function draftAside(quote: AsideQuote, anchor: AsideAnchor | null = null): Aside | null {
  if (app.connection?.engine !== "claude-code") return null;
  // ~~One floating card at a time (backlog 141): a second passage
  // replaces the first's card~~ — each passage its own card (176).
  const a = openAsideThread({ id: nextAsideId(), quote, draft: true, turns: [], anchor });
  app.asideFocus = a.id;
  return a;
}

/**
 * The card's ×. An aside still `asking…` is cancelled on the backend too
 * (whole-project review F13, `cancel_aside`): before this it was only
 * hidden, and the CLI ran its `--max-turns 2` out behind the card.
 * Mid-stream (backlog 128) the card stays, with what had arrived and a
 * mark that it was cut short — his reading is not thrown away with the
 * process; the next × dismisses. Nothing had arrived: the card goes at
 * once, as before.
 */
export function dismissAside(thread: Aside | null = null): void {
  // The card's own thread since backlog 176; the front one when none is
  // named. Its own exchange is the one cancelled, by `seq`, and no other.
  const a = thread ?? app.aside;
  if (!a) return;
  const t = asideAsking(a);
  if (t) {
    void api.cancelAside(t.seq).catch(() => {});
    // What arrived stays, and so does a card whose box holds his next
    // words (backlog 283: the box is there while it answers).
    if (t.partial.trim() || asideHasDraft(a)) {
      t.cancelled = true;
      return;
    }
    // Nothing arrived: marked cancelled too, so a late result is dropped.
    t.cancelled = true;
  }
  // Night batch B (item 229): the chat the thread belongs to, for the
  // past-asides history told below.
  const closedIn = app.asides.includes(a)
    ? app.activeSessionId
    : ([...asideStash].find(([, list]) => list.includes(a))?.[0] ?? null);
  const i = app.asides.indexOf(a);
  if (i >= 0) {
    app.asides.splice(i, 1);
    syncFrontAside();
  } else {
    // A stashed chat's thread (its tab's ×): out of that chat's list.
    for (const [k, list] of asideStash) {
      const j = list.indexOf(a);
      if (j < 0) continue;
      list.splice(j, 1);
      if (list.length === 0) asideStash.delete(k);
    }
  }
  if (app.asidePanelThread === a.id) app.asidePanelThread = null;
  if (app.asideFocus === a.id) app.asideFocus = null;
  if (app.asideDiscard === a) app.asideDiscard = null;
  // Its composer's entry goes with it (backlog 283): every close with
  // anything in the box went through the Discard question; the words go
  // to the box's ring of earlier drafts on the way, as a send's do.
  discardDraft(asideDraftKey(a), closedIn ?? undefined);
  if (closedIn !== null) for (const fn of asideClosedListeners) fn(closedIn, a);
}

/** Stop the thread's answer where it is (backlog 283, the aside
 *  composer's Stop): what arrived stays, marked; the card stays. */
export function stopAside(a: Aside): void {
  const t = asideAsking(a);
  if (!t) return;
  void api.cancelAside(t.seq).catch(() => {});
  t.cancelled = true;
  if (t.segments) closeThinking(t.segments);
}

/**
 * One event of an aside's stream into its exchange (item 403): text onto
 * `partial` as before, and every drawn event into `segments` by the chat's
 * own `applyToSegments`, so the thread draws it with the chat's pieces.
 * An exchange that has its answer, or was stopped, takes nothing more.
 * Exported for the suite.
 */
export function asideTurnEvent(t: AsideTurn, ev: TurnEvent, now = Date.now()): void {
  if (t.answer !== null || t.cancelled) return;
  if (!t.segments) t.segments = [];
  applyToSegments(t.segments, ev);
  if (ev.type === "text_delta") t.partial += ev.text;
  t.heardAt = now;
  t.phase = "running";
}

/** The backend's word on where an exchange stands (item 404); `running`
 *  starts the stalled clock. Exported for the suite. */
export function asidePhase(t: AsideTurn, phase: "queued" | "running", now = Date.now()): void {
  if (t.answer !== null || t.cancelled) return;
  if (phase === "running" && t.phase !== "running") t.heardAt = now;
  t.phase = phase;
}

/**
 * The answer's end on its segments (item 403): an open thinking block
 * closes, and the text drawn is the result's — the whole answer, where a
 * delta was lost or none came (the result alone carried it). The thinking
 * and calls stay where they were, the text after them. Exported for the
 * suite.
 */
export function settleAsideSegments(t: AsideTurn, answer: string): void {
  const segs = t.segments;
  if (!segs) return;
  closeThinking(segs);
  const text = segs.flatMap((s) => (s.kind === "text" ? [s.text] : [])).join("");
  if (text === answer) return;
  for (let i = segs.length - 1; i >= 0; i--) if (segs[i]!.kind === "text") segs.splice(i, 1);
  if (answer) segs.push({ kind: "text", text: answer });
}

/** The text typed in a thread's box, into app state (backlog 228). Since
 *  backlog 283 the box is the chat's composer, whose text lives in the
 *  drafts store under the thread's key; `unsent` is kept equal to it, for
 *  the store's keep rule, the discard question and the lists. */
export function setAsideUnsent(a: Aside, text: string): void {
  a.unsent = text;
  setDraftText(asideDraftKey(a), text);
}

/** Whether the thread's composer holds anything of his (backlog 283):
 *  text, a chip, or a held message. */
export function asideHasDraft(a: Aside): boolean {
  return !!(a.unsent ?? "").trim() || hasDraft(asideDraftKey(a));
}

/**
 * A close from the card, its Cancel, its Escape or a tab's × (backlog
 * 228, practices §7 — only an explicit Discard drops his text, and a
 * Discard confirms): a thread whose box holds unsent text asks first,
 * through `app.asideDiscard`; anything else closes as `dismissAside`
 * always did. A thread still asking has no box, so its × stops the
 * answer at once, as before.
 */
export function requestDismissAside(thread: Aside | null = null): void {
  const a = thread ?? app.aside;
  if (!a) return;
  if (!asideAsking(a) && asideHasDraft(a)) {
    // The box keeps the caret otherwise, and its Enter and Escape would
    // act on the card behind the dialog.
    if (typeof document !== "undefined") (document.activeElement as HTMLElement | null)?.blur?.();
    app.asideDiscard = a;
    return;
  }
  dismissAside(a);
}

/** The dialog's answer: Discard closes the thread, text and all. */
export function answerAsideDiscard(discard: boolean): void {
  const a = app.asideDiscard;
  app.asideDiscard = null;
  if (discard && a) dismissAside(a);
}

/**
 * Night batch B (item 229, 2026-09-26): who hears of a thread closed by
 * its ×, so `asideHistory.svelte.ts` can keep it under the chat's Past
 * list instead of it being gone. A listener, not an import, so the state
 * does not import the history (which imports the state).
 */
const asideClosedListeners = new Set<(chat: string, a: Aside) => void>();
export function onAsideClosed(fn: (chat: string, a: Aside) => void): () => void {
  asideClosedListeners.add(fn);
  return () => asideClosedListeners.delete(fn);
}

/** A past thread back as an open card of the open chat (item 229): under
 *  its passage, folding the oldest past the crowd rule as a new one does.
 *  Returns the live thread; null with no chat open. */
export function reopenAside(a: Aside): Aside | null {
  if (app.activeSessionId === null) return null;
  return openAsideThread({ ...a, draft: false, folded: false, moved: null });
}
