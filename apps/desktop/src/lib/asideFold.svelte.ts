/**
 * *Fold into thread*, the stateful half (nightshift backlog 282; the pure
 * half and the why are in `asideFold.ts`). The fold lives on its aside
 * (`aside.fold`), which the aside store writes, so nothing here holds his
 * text: a chat switch, a closed card (the past list keeps it) or a
 * relaunch keeps the summary and his edit of it.
 */
import * as api from "./api";
import { addToast, app, chatThread, onAsideClosed, type Aside } from "./state.svelte";
import { asideFollowUp } from "./asideQuote";
import { asideLabel } from "./asides";
import { scheduleAsideSave } from "./asides.svelte";
import { beginFold, cancelVerdict, editFold, foldEntry, foldPrompt, foldStamp } from "./asideFold";

/** The fold turns' sequence numbers: far from the asks' (`asideSeq`), so
 *  an `aside-delta` of a fold never lands on an exchange's card. */
let foldSeq = 1_000_000_000;

/** The aside whose fold Cancel waits on "Discard your edit?". */
export const foldDiscard = $state<{ aside: Aside | null }>({ aside: null });

export function chatTitle(chat: string): string {
  const s = app.sessions.find((x) => x.id === chat);
  return s?.title ?? s?.first_user?.split("\n")[0]?.slice(0, 80) ?? "untitled";
}

/**
 * *Fold into thread* clicked on an aside of the open chat: bound, the
 * summary's turn runs at once; unbound, the panel offers the thread
 * picker first (`continueFold` once a thread is picked).
 */
export async function startFold(a: Aside): Promise<void> {
  const chat = app.activeSessionId;
  if (!chat || a.draft) return;
  if (a.fold && a.fold.stage !== "error") return;
  a.fold = beginFold(chatThread(app.events), { chat, title: chatTitle(chat), project: app.project?.id ?? null });
  scheduleAsideSave();
  if (a.fold.stage === "asking") await runFold(a);
}

/** After the picker bound the chat: write the summary for that thread. */
export async function continueFold(a: Aside): Promise<void> {
  const f = a.fold;
  const bound = chatThread(app.events);
  if (!f || !bound || (f.stage !== "pick" && f.stage !== "error")) return;
  f.slug = bound;
  f.project = app.project?.id ?? null;
  await runFold(a);
}

/**
 * **The fold step** — the one turn both callers run (282's *Fold into
 * thread*, 285's wrap-up picker): the aside's exchanges and the fold's
 * question, sent in the aside's own conversation off the open chat's
 * context, as a follow-up is asked. `slug` null writes for an unbound
 * chat's hand-off. Never throws; a turn past `timeoutMs` is cancelled and
 * reads as an error.
 */
export interface FoldResult {
  text: string | null;
  error: string | null;
  seq: number;
}
export async function summarizeAside(
  a: Aside,
  slug: string | null,
  chat: string,
  opts: { timeoutMs?: number; onSeq?: (seq: number) => void } = {},
): Promise<FoldResult> {
  hookClose();
  const prior = a.turns.filter((t) => t.partial.trim()).map((t) => ({ question: t.question, answer: t.partial }));
  const question = foldPrompt({ slug, chatId: chat, label: asideLabel(a, 60), passageEvent: a.anchor?.turn ?? null });
  const seq = ++foldSeq;
  opts.onSeq?.(seq);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout =
    opts.timeoutMs === undefined
      ? null
      : new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
        });
  try {
    const ask = api.askAside(asideFollowUp(a.quote, prior, question), seq);
    const res = timeout ? await Promise.race([ask, timeout]) : await ask;
    if (res === "timeout") {
      void api.cancelAside(seq).catch(() => {});
      return { text: null, error: "no summary within the wait", seq };
    }
    if (res.is_error || !res.answer.trim()) {
      return { text: null, error: res.notices.join("; ") || "the summary came back empty", seq };
    }
    return { text: res.answer.trim(), error: null, seq };
  } catch (e) {
    return { text: null, error: String(e), seq };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 282's run: the fold step for the panel, its result into the fold. */
async function runFold(a: Aside): Promise<void> {
  const f = a.fold;
  if (!f || !f.slug) return;
  f.stage = "asking";
  f.error = null;
  let seq = -1;
  const res = await summarizeAside(a, f.slug, f.chat, {
    onSeq: (n) => {
      seq = n;
      f.seq = n;
    },
  });
  if (!(a.fold === f && f.stage === "asking" && f.seq === seq)) return; // stopped meanwhile
  if (res.text === null) {
    f.stage = "error";
    f.error = res.error;
  } else {
    f.text = res.text;
    f.edited = false;
    f.editing = false;
    f.stage = "ready";
  }
  scheduleAsideSave();
}

/**
 * Append a summary to a thread's log.md as a dated entry — the app's
 * write, shared by Append (282) and the wrap-up picker (285). Records the
 * fold on the aside. Throws the backend's refusal.
 */
export async function appendSummary(
  a: Aside,
  o: { slug: string; chat: string; title: string; text: string },
  now: Date = new Date(),
): Promise<void> {
  const at = foldStamp(now);
  const entry = foldEntry({ at, chatId: o.chat, chatTitle: o.title, label: asideLabel(a, 60), body: o.text });
  await api.appendThreadLog(o.slug, entry);
  a.foldedInto = [...(a.foldedInto ?? []), { at, slug: o.slug }];
  scheduleAsideSave();
}

/** His edit of the summary, into the fold (and so into the store). */
export function setFoldText(a: Aside, text: string): void {
  if (!a.fold) return;
  editFold(a.fold, text);
  scheduleAsideSave();
}

export function setFoldEditing(a: Aside, editing: boolean): void {
  if (!a.fold) return;
  a.fold.editing = editing;
}

/**
 * Append: the app writes the dated entry to the thread's log.md — never
 * the model, never thread.md. Refused when the open project is not the
 * one the fold began in (the thread is that project's). On success the
 * fold is recorded on the aside, for the "already folded" warning, and
 * cleared; on failure the text stays.
 */
export async function appendFold(a: Aside, now: Date = new Date()): Promise<boolean> {
  const f = a.fold;
  if (!f || f.stage !== "ready" || !f.slug || !f.text.trim()) return false;
  if ((app.project?.id ?? null) !== f.project) {
    addToast("Open the project this aside's chat is in to append — the thread is that project's");
    return false;
  }
  try {
    await appendSummary(a, { slug: f.slug, chat: f.chat, title: f.title, text: f.text }, now);
  } catch (e) {
    addToast(`The fold was not appended: ${String(e)}`);
    return false;
  }
  delete a.fold;
  scheduleAsideSave();
  addToast(`Folded into ◇ ${f.slug} — appended to its log.md; the chat's next wrap-up merges it into thread.md`);
  return true;
}

/** Drop the fold, stopping its turn if one runs. */
function dropFold(a: Aside): void {
  const f = a.fold;
  if (!f) return;
  if (f.stage === "asking" && f.seq !== undefined) void api.cancelAside(f.seq).catch(() => {});
  delete a.fold;
  if (foldDiscard.aside === a) foldDiscard.aside = null;
  scheduleAsideSave();
}

/** Cancel: drops a fold with nothing of his in it; with his edit, asks
 *  first (practices §7) — the text stays until he says Discard. */
export function requestCancelFold(a: Aside): void {
  const f = a.fold;
  if (!f) return;
  if (cancelVerdict(f) === "confirm") {
    foldDiscard.aside = a;
    return;
  }
  dropFold(a);
}

/** The dialog's answer. */
export function answerFoldDiscard(discard: boolean): void {
  const a = foldDiscard.aside;
  foldDiscard.aside = null;
  if (discard && a) dropFold(a);
}

// A card closed while its fold's turn runs: the turn is stopped (nothing
// of his was in it yet); a fold with text rides into the past list with
// the thread (`storedAsideOf` keeps it), so reopening brings it back.
// Registered on the first fold rather than at import, so a suite that
// stands in for the state module need not know of it.
let hooked = false;
function hookClose(): void {
  if (hooked) return;
  hooked = true;
  onAsideClosed((_chat, a) => {
    const f = a.fold;
    if (f && f.stage === "asking" && f.seq !== undefined) {
      void api.cancelAside(f.seq).catch(() => {});
      delete a.fold;
    }
  });
}
