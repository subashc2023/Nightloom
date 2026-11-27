// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { takeThreadHandoff } from "../threadHandoff.svelte";
import { noteHandoffOpened } from "../handoffLog";
import { hasHiddenChars } from "../shellRun";
import * as api from "../api";
import { carryReadOrder, clearAwaySent, firstMessage, awayNow, extractStartPrompt, handoff, idleAway, isUnattended, markUnattended, neverHandsOff, noteAwayWrapUp, noteChatProject, noteSystemIdle, noteThread, leaveHandoff, projectFor, threadFor, undoAwayWrapUp, waitingCards, withHistory, wrapUpToSend } from "../handoff.svelte";
import { setDraftText } from "../drafts.svelte";
import { chatName, notifyTurnEnd } from "../notify";
import { limitPauseFrom, resumeDelayMs, resumeMessage } from "../limit";
import { askedResume, dueResumes, extractContinue, limitResumeTime, nextResumeAt, readResumes, RESUMES_KEY, writeResumes, type ChatResume } from "../chatResume";
import { liveHost } from "../browse";
import type { AgentTurnResult, SessionEvent, Usage } from "../types";
import { chatHome } from "./asides.svelte";
import { chatHomeOf } from "../chatHomeOf";
import { type Segment, app, sendUntyped, refreshSessions, continueWithPrompt, historyFrom, backgroundName, chatRuns, sendInChat, addToast, turnWasStopped } from "../state.svelte";

/**
 * Resume a turn the usage limit paused (nightshift backlog 164): sends the
 * continue that names the subagents that died. Before the window has
 * reset it is scheduled for the reset plus a margin — never into a window
 * that is still exhausted — and `app.limitResumeAt` says so on the card;
 * a second click while it waits cancels.
 *
 * The time is kept by the backend's clock (backlog 535, `wake.rs`: the
 * `limit` wake), not only by a timer in the page — a hidden window's
 * timer stopped, and his resume went an hour late. And it goes into the
 * chat that was paused, whatever is on screen by then: there when that
 * chat is open, off screen in its own chat and project otherwise
 * (`sendInChat`; its agent spec is kept at the click). ~~else it is
 * dropped with a toast, since a turn cannot start in a chat that is not
 * open~~ — only a chat that is running another turn by then is left, with
 * a toast.
 */
/** Every chat waiting to be continued by Nightloom, by chat id (backlog
 *  543, `chatResume.ts`): a turn the limit paused, each with its own time
 *  — ~~one slot, one timer~~ — kept across a relaunch. `app.limitPause`
 *  and `app.limitResumeAt` are the open chat's entry, as the card and the
 *  phone read them (`showResume`). */
export const resumes: Record<string, ChatResume> = $state(loadResumes());
function loadResumes(): Record<string, ChatResume> {
  try {
    return readResumes(localStorage.getItem(RESUMES_KEY));
  } catch {
    return {};
  }
}
function saveResumes(): void {
  try {
    localStorage.setItem(RESUMES_KEY, writeResumes(resumes));
  } catch {
    // Storage refused: the entries hold for this launch only.
  }
}
/** The suite's reset: no entry, no timer. */
export function clearResumes(): void {
  for (const k of Object.keys(resumes)) delete resumes[k];
  resumeWent.clear();
  resuming.clear();
  handedOff.clear();
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
  // 912's state too.
  if (awayTimer !== null) clearTimeout(awayTimer);
  awayTimer = null;
  awayArmed = false;
  for (const c of chains.values()) clearTimeout(c.cap);
  chains.clear();
  clearAwaySent();
}
let limitTimer: ReturnType<typeof setTimeout> | null = null;
/** When each chat's last entry was sent (`limitResumeTime`'s loop guard). */
const resumeWent = new Map<string, number>();
/** The entries being checked with the backend right now: sent once. */
const resuming = new Set<string>();
/** The pending chat's key: a pause with no chat id yet. */
const NO_CHAT = "";

function resumeLog(text: string): void {
  void api.scheduleLog(`resume ${text}`).catch(() => {});
}

/** The open chat's entry on `app`, for the transcript's card. */
export function showResume(): void {
  const r = resumes[app.activeSessionId ?? NO_CHAT];
  app.limitPause = r?.pause ?? null;
  app.limitResumeAt = r?.pause ? r.at : null;
}

/** After any change to the entries: the backend's clock is told the
 *  earliest time (the `limit` wake — it asks again every 15 s while that
 *  time is past and the entry still waits), the page's own timer follows,
 *  the card is redrawn and the store is written. */
export function armResumes(): void {
  if (limitTimer !== null) clearTimeout(limitTimer);
  limitTimer = null;
  const at = nextResumeAt(resumes);
  void api.armWake("limit", at).catch(() => {});
  if (at !== null) {
    // A time already past is an entry waiting on something (no engine, its
    // project closed): looked at again, not spun on.
    const wait = at - Date.now();
    limitTimer = setTimeout(
      () => {
        // The page's own clock ran it (item 535m's log line).
        void api.scheduleLog("limit timer").catch(() => {});
        void runResumes();
      },
      Math.min(wait > 0 ? wait : 15_000, 0x7fffffff),
    );
  }
  showResume();
  saveResumes();
}

/** The words of a reply still held as live segments (a turn that ended
 *  off screen or parked: its log is not re-read here). */
export function liveText(segs: readonly Segment[]): string {
  return segs.map((g) => (g.kind === "text" ? g.text : "")).filter((t) => t).join("\n");
}

/** Where chat `id` lives, as far as this launch knows. */
export function homeFor(id: string | null): { id: string | null; name: string | null } {
  // Item 874: an off-screen turn's record names its project first.
  return chatHomeOf(id, {
    active: app.activeSessionId,
    open: { id: app.project?.id ?? null, name: app.project?.name ?? null },
    record: id ? app.background[id] : null,
    known: id ? chatHome.get(id) : null,
  });
}

/**
 * A turn in `chat` ended with `res` (backlog 543): on the usage limit, the
 * chat gets its entry — with its time set, so it goes by itself at the
 * reset (nightshift blocker 1738) and, the resumed turn making the next
 * entry the same way, at every reset after until the turn ends some other
 * way. Any other end clears a pause the chat had (164: "kept until a turn
 * runs in that chat again"). On screen or off, in any project.
 */
export function noteTurnLimit(
  chat: string | null,
  res: AgentTurnResult,
  home: { id: string | null; name: string | null },
  reply: string | null = null,
): void {
  const key = chat ?? NO_CHAT;
  // 912: after this turn's readings (on screen the gauge's comes next), a
  // card now waiting is checked from here on.
  queueMicrotask(armAwayCheck);
  const p = limitPauseFrom(res, chat);
  // 912: a turn ended in a chain Nightloom started while he was away.
  const link = chat ? chainOf(chat) : null;
  if (!p) {
    // 543b: the reply asked to be continued later (`<continue-later>`) —
    // the chat stopped short of the limit with work left, or wants a time.
    // Its entry goes by the same clock; a newer ask replaces an older one.
    // 544: a reply that holds the next chat's prompt is a hand-off — the
    // work goes on in the linked chat, by itself when he is away.
    const prompt = chat && !res.is_error && reply ? extractStartPrompt(reply) : null;
    if (chat && prompt) {
      const handing = handOffUnattended(chat, prompt, home);
      // 912: the wrap-up's reply named the next chat — the hold runs on to
      // that chat's first reply; not handed off (he came back), it ends.
      if (link?.role === "from") void handing.then((next) => (next ? chainNext(link.from, next) : endChain(link.from, "not handed off")));
      // 544's own hand-off (its wrap-up queued at a turn's end) holds from
      // here: the wrap-up's turn held the Mac itself.
      else if (!link)
        void handing.then((next) => {
          if (next) {
            holdChain(chat);
            chainNext(chat, next);
          }
        });
    }
    const ask = chat && !res.is_error && reply && !prompt ? extractContinue(reply) : null;
    // 912: the next chat's first reply ended, or the wrap-up ended with no
    // prompt and no ask — the chain is over, the Mac may sleep.
    if (link && !(link.role === "from" && (prompt || ask))) endChain(link.from, link.role === "next" ? "first reply ended" : "no prompt");
    if (chat && ask) {
      resumes[key] = askedResume(chat, home, ask, app.planUsage, Date.now());
      resumeLog(`asked ${key.slice(0, 8)} at=${new Date(resumes[key].at as number).toISOString()} (${ask.at})`);
      if (app.connection?.engine === "claude-code") void api.reserveChatAgent(chat, true).catch(() => {});
      armResumes();
      return;
    }
    // ~~`resumes[key]?.why === "limit"`~~ (543m review): an ask is ended by
    // a turn that ran in the chat too — a message he sent there before its
    // time continued it, and the ask's stale "you asked to be continued"
    // must not follow hours later. The resumed turn's own entry was taken
    // at its send (`goResume`), so this never drops the entry it made.
    if (resumes[key]) {
      delete resumes[key];
      armResumes();
    }
    return;
  }
  // 912: a limit inside the chain keeps the hold; the entry below resumes
  // the chat at the reset and the chain carries on from there.
  if (link) resumeLog(`away chain ${link.from.slice(0, 8)} waits for the reset (${link.role})`);
  const at = chat ? limitResumeTime(p, Date.now(), resumeWent.get(key) ?? null) : null;
  resumes[key] = { chat: key, project: home, at, why: "limit", text: resumeMessage(p), pause: p };
  resumeLog(`paused ${key.slice(0, 8)} project=${home.id ?? "unfiled"} at=${at === null ? "his click" : new Date(at).toISOString()}`);
  // Its agent spec is kept for the time, so it runs in its own project
  // whatever is open then (535).
  if (chat && at !== null && app.connection?.engine === "claude-code") void api.reserveChatAgent(chat, true).catch(() => {});
  armResumes();
}

/** The Mac's idle time, read now for the hand-off's away rule (544). */
export async function readIdle(): Promise<void> {
  try {
    noteSystemIdle(await api.idleSeconds());
  } catch {
    noteSystemIdle(null);
  }
}

/** The replies already continued by Nightloom this launch (`chat|prompt`). */
const handedOff = new Set<string>();

/**
 * An unattended chat hands off by itself (backlog 544; his words: "is it
 * automatically gonna do that handoff message and then click continue in
 * the next chat"). A turn in `chat` ended with the next chat's `prompt` in
 * its reply — the wrap-up's, or one the model wrote unasked. If he is away
 * (`awayNow`: nothing typed for a minute and the window not in front or
 * the chat not open, or no input on the Mac for ten minutes) the linked
 * chat is started and the prompt sent with no click: on screen through the
 * card's own `continueWithPrompt`; off screen where the chat lives, the
 * view untouched (`continue_chat`, then the keyed send). The new chat runs
 * unattended too, so its limit pause, its ask to be continued and its own
 * hand-off all go the same way. With him present the card waits for his
 * click, as before. A chat whose mark is "never" (545) is left alone.
 */
async function handOffUnattended(chat: string, prompt: string, home: { id: string | null; name: string | null }): Promise<string | null> {
  if (app.connection?.engine !== "claude-code" || hasHiddenChars(prompt) || neverHandsOff(chat)) return null;
  const once = `${chat}|${prompt}`;
  if (handedOff.has(once)) return null;
  await readIdle();
  const onScreen = chat === app.activeSessionId && (app.project?.id ?? null) === home.id;
  if (!awayNow(onScreen)) return null;
  if (handedOff.has(once) || chatRuns(chat)) return null;
  handedOff.add(once);
  // Item 1025: off screen too, the pointer to the full history goes under it
  // (on screen, `continueWithPrompt` adds it).
  const text = withHistory(firstMessage("", prompt), historyFrom(chat));
  resumeLog(`handoff ${chat.slice(0, 8)} ${onScreen ? "on screen" : "off screen"} project=${home.id ?? "unfiled"}`);
  if (onScreen) {
    if (app.busy) {
      handedOff.delete(once);
      return null;
    }
    let index = app.events.length - 1;
    while (index > 0 && app.events[index].event !== "assistant_message") index--;
    await continueWithPrompt(chat, index, prompt, { route: "unattended" });
    if (app.activeSessionId !== chat) {
      markUnattended(app.activeSessionId);
      return app.activeSessionId;
    }
    return null;
  }
  let next: string;
  try {
    next = await api.continueChat(chat, home.id);
  } catch (e) {
    handedOff.delete(once);
    resumeLog(`handoff ${chat.slice(0, 8)} not continued: ${String(e)}`);
    return null;
  }
  // Item 757: logged for scoring.
  noteHandoffOpened({ route: "unattended", from: chat, index: null, to: next, sent: text });
  const thread = threadFor(chat);
  leaveHandoff(chat);
  carryReadOrder(chat, next);
  noteThread(next, thread);
  noteChatProject(next, home.id);
  chatHome.set(next, { project: home.id, name: home.name });
  if (thread && (app.project?.id ?? null) === home.id) void takeThreadHandoff(thread, next);
  markUnattended(next);
  const from = app.sessions.find((x) => x.id === chat);
  addToast(`${from ? `“${chatName(from.title, from.first_user)}”` : "A chat"} handed off to a new chat while you were away — it is running there`);
  sendInChat(next, home, text, [], (why) => {
    setDraftText(next, text);
    addToast(`The hand-off's new chat could not start (${why}) — its prompt is in that chat's box`);
    // 912: nothing runs in it, so nothing holds the Mac for it.
    endChain(chat, `next chat refused: ${why}`);
  });
  void refreshSessions();
  return next;
}

// ---- 912: the card that waits while he is away ----

/** How often a waiting card checks whether he has left (912). */
export const AWAY_CHECK_MS = 60_000;
/** The longest one chain holds the Mac awake, whatever happens (912). */
export const CHAIN_CAP_MS = 6 * 60 * 60_000;
let awayTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether the backend's `handoff-away` wake is armed. */
let awayArmed = false;

/** The chains Nightloom started while he was away (912), by the chat that
 *  wrapped up: `next` once the next chat is started. While any runs, the
 *  Mac is held awake (`power.rs`'s child, by his switches). */
const chains = new Map<string, { next: string | null; cap: ReturnType<typeof setTimeout> }>();

function chainOf(chat: string): { from: string; role: "from" | "next" } | null {
  if (chains.has(chat)) return { from: chat, role: "from" };
  for (const [from, c] of chains) if (c.next === chat) return { from, role: "next" };
  return null;
}

function holdChain(from: string): void {
  if (chains.has(from)) return;
  const cap = setTimeout(() => endChain(from, "cap"), CHAIN_CAP_MS);
  chains.set(from, { next: null, cap });
  if (chains.size === 1) void api.powerHold("handoff", true).catch(() => {});
  resumeLog(`away chain ${from.slice(0, 8)} holds the Mac awake`);
}

function chainNext(from: string, next: string): void {
  const c = chains.get(from);
  if (c) c.next = next;
}

function endChain(from: string, why: string): void {
  const c = chains.get(from);
  if (!c) return;
  clearTimeout(c.cap);
  chains.delete(from);
  if (chains.size === 0) void api.powerHold("handoff", false).catch(() => {});
  resumeLog(`away chain ${from.slice(0, 8)} ends: ${why}`);
}

/** The suite's look at the chains: `from → next`. */
export function awayChains(): Record<string, string | null> {
  return Object.fromEntries([...chains].map(([k, v]) => [k, v.next]));
}

/** The cards this check may wrap up (912): the open chat's, and an
 *  unattended chat's (544: Nightloom sent its last message). A chat he
 *  was driving and left in the background is not wrapped up for him. */
function awayCandidates(): string[] {
  return waitingCards().filter((c) => c === app.activeSessionId || isUnattended(c));
}

/**
 * Item 912 (his bug, 3:25 PM: the card waited 1.5 h while he was away and
 * nothing happened): the away rule was read only when a turn ended, so a
 * card up in an idle chat waited forever. While a card waits, this checks
 * every `AWAY_CHECK_MS` — the backend's `handoff-away` wake, which a hidden
 * window cannot slow (535), and the page's own timer — with the Mac's idle
 * time read fresh. Once he has left the Mac (`idleAway`), the wrap-up goes
 * into that chat as the card's *Wrap up now* would send it, and the rest is
 * 544's chain: the reply's start prompt starts the next chat with no click.
 * From the wrap-up until the next chat's first reply ends, the Mac is held
 * awake. Never twice for one card; nothing for a *Stay here*, a "never"
 * mark (545), a chat that runs a turn, or another chat he was driving.
 */
export async function checkAwayHandoffs(): Promise<void> {
  if (app.connection?.engine !== "claude-code" || awayCandidates().length === 0) return armAwayCheck();
  await readIdle();
  if (!idleAway()) return armAwayCheck();
  for (const chat of awayCandidates()) {
    const onScreen = chat === app.activeSessionId;
    if (chatRuns(chat) || (onScreen && app.busy)) continue;
    const text = wrapUpToSend(chat);
    if (!text.trim()) continue;
    // Off screen, only where this launch knows it lives — `homeFor` would
    // guess the open project for a chat it has never seen.
    const home = onScreen ? homeFor(chat) : knownHome(chat);
    if (!home) {
      resumeLog(`away wrap-up ${chat.slice(0, 8)} skipped: its project is not known`);
      continue;
    }
    noteAwayWrapUp(chat);
    markUnattended(chat);
    holdChain(chat);
    resumeLog(`away wrap-up ${chat.slice(0, 8)} ${onScreen ? "on screen" : "off screen"} project=${home.id ?? "unfiled"}`);
    sendInChat(chat, home, text, [], (why) => {
      undoAwayWrapUp(chat);
      endChain(chat, `wrap-up refused: ${why}`);
      resumeLog(`away wrap-up ${chat.slice(0, 8)} refused: ${why}`);
    });
  }
  armAwayCheck();
}

/** Where an off-screen chat lives, if this launch knows (912). */
function knownHome(chat: string): { id: string | null; name: string | null } | null {
  const rec = app.background[chat];
  if (rec) return { id: rec.project ?? null, name: rec.projectName ?? null };
  const known = chatHome.get(chat);
  if (known) return { id: known.project, name: known.name };
  const project = projectFor(chat);
  return project === undefined ? null : { id: project, name: null };
}

/** Arm the next away check while a card waits, or clear it (912). */
export function armAwayCheck(): void {
  if (awayTimer !== null) clearTimeout(awayTimer);
  awayTimer = null;
  const waiting = app.connection?.engine === "claude-code" && awayCandidates().length > 0;
  const at = waiting ? Date.now() + AWAY_CHECK_MS : null;
  // Cleared once, not at every turn's end with no card waiting.
  if (at !== null || awayArmed) void api.armWake("handoff-away", at).catch(() => {});
  awayArmed = at !== null;
  if (at !== null) awayTimer = setTimeout(() => void checkAwayHandoffs(), AWAY_CHECK_MS);
}

/** The backend's `limit` wake fired (`scheduleRuntime.ts` listens), or the
 *  Mac woke: every entry whose time has come goes. */
export function limitWakeDue(): void {
  // Item 535m's diagnosis line, read against the per-chat entries (543).
  void api.scheduleLog(`limit wake-due armed=${nextResumeAt(resumes) !== null}`).catch(() => {});
  void runResumes();
}

async function runResumes(): Promise<void> {
  for (const r of dueResumes(resumes, Date.now())) await goResume(r.chat, false);
  armResumes();
}

/**
 * Send chat `key`'s entry now, into that chat, whatever is on screen:
 * there when it is the open chat, off screen in its own chat and project
 * otherwise (`sendInChat`). An entry that cannot go yet — its chat runs a
 * turn, no engine, its project closed after a relaunch — is kept with the
 * reason and asked again by the clock; `clicked` says the reason in a
 * toast too (his Resume). Its chat's log gone: the entry is dropped.
 */
async function goResume(key: string, clicked: boolean): Promise<void> {
  const r = resumes[key];
  if (!r || resuming.has(key)) return;
  // The resume's own moment, whichever clock ran it (item 535m).
  void api.scheduleLog(`limit go connected=${!!app.connection}`).catch(() => {});
  const id = key === NO_CHAT ? null : key;
  const { text, at } = r;
  const project = { id: r.project.id, name: r.project.name };
  const wait = (why: string, toast: string) => {
    if (resumes[key] && resumes[key].note !== why) {
      resumes[key].note = why;
      resumeLog(`kept ${key.slice(0, 8)} ${why}`);
      saveResumes();
    }
    if (clicked) addToast(toast);
  };
  if (id && chatRuns(id)) {
    return wait("its chat is running a turn", "The paused chat is running another turn — press Resume again when it ends.");
  }
  if (!app.connection) return wait("no engine is connected", "No engine is connected — connect one and press Resume again.");
  const sent = () => {
    delete resumes[key];
    // It runs without him from here (544): its hand-off, when it comes,
    // sends itself while he is away.
    markUnattended(id);
    resumeWent.set(key, Date.now());
    resumeLog(`sent ${key.slice(0, 8)} project=${project.id ?? "unfiled"}`);
    armResumes();
  };
  const refused = (why: string) => {
    if (!resumes[key]) resumes[key] = { ...r, project, note: why };
    resumeLog(`refused ${key.slice(0, 8)} ${why}`);
    armResumes();
    if (clicked) addToast(`The paused chat could not be resumed (${why}) — open it and press Resume.`);
  };
  if (app.activeSessionId === id && (id === null || (app.project?.id ?? null) === project.id)) {
    if (app.busy) return wait("its chat is busy", "The paused chat is not open or is busy — open it and press Resume again.");
    sent();
    if (id === null) void sendUntyped(text);
    else sendInChat(id, project, text, [], refused);
    return;
  }
  if (!id || app.connection.engine !== "claude-code") {
    return wait(
      "open this chat: the API-key engine sends only in the chat on screen",
      "The paused chat is not open or is busy — open it and press Resume again.",
    );
  }
  // Not the chat on screen: in its own chat, off screen.
  resuming.add(key);
  try {
    await api.canSendInChat(id, project.id);
  } catch (e) {
    const why = String(e);
    if (/log could not be read/.test(why)) {
      // Deleted or moved since: nothing to continue.
      delete resumes[key];
      resumeLog(`dropped ${key.slice(0, 8)} ${why}`);
      armResumes();
    } else wait(why, `The paused chat could not be resumed (${why}) — open it and press Resume.`);
    if (clicked && !resumes[key]) addToast(`The paused chat could not be resumed (${why}).`);
    return;
  } finally {
    resuming.delete(key);
  }
  const now = resumes[key];
  if (!now || now.at !== at || now.text !== text || chatRuns(id)) return;
  sent();
  sendInChat(id, project, text, [], refused);
}

/**
 * The card's button (and the phone's): Resume, or — while the chat's
 * resume waits for its time — Cancel, after which only another press
 * sends it. Pressed before the window has reset it sets the time (never
 * into a window that is still exhausted); after, it goes at once.
 */
export function resumeAfterLimit(): void {
  const p = app.limitPause;
  if (!p) return;
  const key = p.session ?? NO_CHAT;
  // A pause set on `app` alone (before 543, or by the suite) gets its entry.
  if (!resumes[key]) {
    resumes[key] = { chat: key, project: homeFor(p.session), at: null, why: "limit", text: resumeMessage(p), pause: p };
  }
  const r = resumes[key];
  if (r.at !== null) {
    r.at = null;
    delete r.note;
    armResumes();
    return;
  }
  const delay = resumeDelayMs(p);
  if (delay === 0) {
    void goResume(key, true);
    return;
  }
  r.at = Date.now() + delay;
  armResumes();
  // Its agent spec is kept for the time (it is the chat on screen now).
  if (p.session && p.session === app.activeSessionId) void api.reserveChatAgent(p.session, true).catch(() => {});
}

/** The chat as a banner names it (nightshift backlog 079): the open
 *  session's title, else the first message of the turn just sent. */
/** Whether a call still waits on his answer, here or in a background chat. */
export function approvalWaits(id: string): boolean {
  return (
    app.pendingApprovals.some((r) => r.id === id) ||
    Object.values(app.background).some((b) => b.approvals.some((r) => r.id === id))
  );
}

export function bannerChat(): string {
  const s = app.sessions.find((x) => x.id === app.activeSessionId);
  const sent = [...app.events].reverse().find((e) => e.event === "user_message");
  return chatName(s?.title, s?.first_user ?? (sent?.event === "user_message" ? sent.text : null));
}

/**
 * The turn-end banner (nightshift backlog 079), read from the live state
 * before `finally` clears it — the segments for the files changed, the
 * last usage for the tokens, the optimistic `user_message`'s `at` for the
 * time. Whether it is posted at all (the window's focus, the setting) is
 * `notify.ts`'s decision.
 */
export function notifyTurnEnded(error: string | null): void {
  const ranIn = app.parked ? app.parked.session : app.activeSessionId;
  // The running chat's own state when he browsed away (A4: the parked
  // chat's reply, not the empty one of the chat on screen).
  const host = liveHost(app);
  notifyEnd({
    chat: app.parked ? (ranIn ? backgroundName(ranIn, app.parked.events) : "New chat") : bannerChat(),
    events: app.parked ? app.parked.events : app.events,
    segs: host.live?.segments ?? [],
    usage: host.liveUsage,
    ranIn,
    error,
    cliError: app.agentTurn?.is_error === true,
    limit: !!app.agentTurn?.limit,
    stopped: turnWasStopped(),
  });
}

/** The banner for a turn's end in any chat (A4): the screen's or one
 *  that ran off screen, from that chat's own log and live state. */
export function notifyEnd(t: {
  chat: string;
  events: SessionEvent[];
  segs: Segment[];
  usage: Usage | null;
  ranIn: string | null;
  error: string | null;
  cliError: boolean;
  /** The plan's limit paused the turn (item 739: the phone's push says so). */
  limit?: boolean;
  /** He stopped the turn (739 review L5): no push to the phone. */
  stopped?: boolean;
  /** Where the chat lives when the caller knows (874: an off-screen turn's
   *  record, gone before this runs); else `homeFor`. */
  home?: { id: string | null; name: string | null };
}): void {
  const sent = [...t.events].reverse().find((e) => e.event === "user_message");
  const since = sent?.event === "user_message" ? Date.parse(sent.at) : NaN;
  // The wrap-up's own turn (backlog 079's third banner, with 193): the
  // hand-off is still `wrapping` in the chat the turn ran in — the turn's
  // end moves it on only after this. A turn the CLI ended with an error
  // wrote no hand-off worth announcing.
  const wrapUp = t.ranIn !== null && handoff.chat === t.ranIn && handoff.stage === "wrapping" && !t.cliError;
  void notifyTurnEnd({
    chat: t.chat,
    segs: t.segs,
    outTokens: t.usage?.output_tokens ?? null,
    elapsedMs: Number.isNaN(since) ? null : Date.now() - since,
    error: t.error,
    handoffFill: wrapUp ? handoff.fill : null,
    phone: { chat: t.ranIn, project: (t.home ?? homeFor(t.ranIn)).id, limit: t.limit === true, cliError: t.cliError, stopped: t.stopped === true },
  });
}
