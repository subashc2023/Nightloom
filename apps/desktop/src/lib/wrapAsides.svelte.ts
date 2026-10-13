/**
 * Open asides chip into the wrap-up (nightshift item 285, 2026-10-02 —
 * his "whenever the main chat is told to wrap up, all of the threads are
 * supposed to like chip into that wrap up … a popup that asks which
 * threads you want to include in the handoff, with default all of them
 * that are open selected … and maybe there's a delete button").
 *
 * *Wrap up* in a chat with open asides first shows a picker
 * (`WrapAsidesDialog.svelte`): every asked aside, all ticked. Untick to
 * leave one out; Delete (confirmed) closes it into the chat's Past list —
 * never a hard delete. Wrap up then runs 282's fold step
 * (`summarizeAside`) for every ticked aside at once — the backend answers
 * asides one at a time (blocker 317), so "at once" is queued, not truly
 * parallel — and waits up to `WAIT_MS` in all. Then:
 *
 * - a **bound** chat: each summary is appended to the thread's log.md
 *   (the app's write, `appendSummary`), and the wrap-up — whose step 3
 *   folds aside entries into thread.md — is told which landed;
 * - an **unbound** chat: the summaries ride in the wrap-up message, for
 *   the HANDOFF section it writes.
 *
 * Asides that failed or did not answer in time are named in the wrap-up
 * message and stay open. Every way out keeps the asides as they were:
 * Cancel touches nothing; nothing is closed except by a confirmed Delete.
 */
import * as api from "./api";
import { app, chatThread, dismissAside, type Aside } from "./state.svelte";
import { asideLabel } from "./asides";
import { appendSummary, chatTitle, summarizeAside } from "./asideFold.svelte";

/** The longest the wrap-up waits for the summaries, in all (285's ~2 min). */
export const WAIT_MS = 120_000;

export interface WrapRow {
  aside: Aside;
  ticked: boolean;
}

export const wrapPick = $state<{
  chat: string | null;
  rows: WrapRow[];
  stage: "pick" | "summarizing";
  /** The row whose Delete waits on its confirmation. */
  deleting: Aside | null;
  /** Labels whose summary has arrived, while summarizing. */
  done: string[];
}>({ chat: null, rows: [], stage: "pick", deleting: null, done: [] });

/** What sends the wrap-up, given the extra text the asides add. */
type Go = (extra: string) => Promise<void>;
let pendingGo: Go | null = null;
let skipWait: (() => void) | null = null;

/** The asides that can chip in: asked ones (a draft has nothing to say). */
export function wrapCandidates(list: readonly Aside[]): Aside[] {
  return list.filter((a) => !a.draft && a.turns.some((t) => t.partial.trim()));
}

/**
 * The wrap-up's entry point for the open chat. No asides to ask: `go`
 * runs at once with nothing extra. Otherwise the picker opens and `go`
 * waits for its Wrap up (or never runs, on Cancel).
 */
export async function requestWrapUp(chat: string | null, go: Go): Promise<void> {
  const list = chat !== null && chat === app.activeSessionId ? wrapCandidates(app.asides ?? []) : [];
  if (list.length === 0) {
    await go("");
    return;
  }
  pendingGo = go;
  wrapPick.chat = chat;
  wrapPick.rows = list.map((aside) => ({ aside, ticked: true }));
  wrapPick.stage = "pick";
  wrapPick.deleting = null;
  wrapPick.done = [];
}

function closePicker(): void {
  pendingGo = null;
  skipWait = null;
  wrapPick.chat = null;
  wrapPick.rows = [];
  wrapPick.stage = "pick";
  wrapPick.deleting = null;
  wrapPick.done = [];
}

/** Cancel: no wrap-up, every aside as it was. */
export function cancelWrapPick(): void {
  if (wrapPick.stage !== "pick") return;
  closePicker();
}

export function setTicked(a: Aside, ticked: boolean): void {
  const r = wrapPick.rows.find((x) => x.aside === a);
  if (r) r.ticked = ticked;
}

/** Delete asks first; the answer closes the aside into Past (yes) or
 *  keeps it (no). */
export function requestDelete(a: Aside): void {
  wrapPick.deleting = a;
}
export function answerDelete(yes: boolean): void {
  const a = wrapPick.deleting;
  wrapPick.deleting = null;
  if (!yes || !a) return;
  // `dismissAside` hands it to the past-asides history (item 229): it is
  // reopenable from the chat's asides list; its unsent text, if any, is
  // what the confirmation said would go.
  dismissAside(a);
  wrapPick.rows = wrapPick.rows.filter((r) => r.aside !== a);
}

/** While summarizing: wrap up now with what has arrived. */
export function skipWaiting(): void {
  skipWait?.();
}

/** The extra text the wrap-up message gets. Pure. */
export function wrapExtra(o: {
  slug: string | null;
  landed: { label: string; text: string }[];
  missing: { label: string; why: string }[];
}): string {
  const out: string[] = [];
  if (o.slug && o.landed.length > 0) {
    out.push(
      `Aside summaries appended to .agents/threads/${o.slug}/log.md just now, for step 3: ${o.landed.map((l) => `'${l.label}'`).join(", ")}.`,
    );
  } else if (!o.slug && o.landed.length > 0) {
    out.push(
      "Summaries of this chat's side conversations (asides), written by each aside just now. Put them in the HANDOFF section you write, under a heading \"From asides\": his words verbatim with their pointers, the rest condensed claim by claim with its tag and pointer.",
    );
    for (const l of o.landed) out.push("", `#### Aside '${l.label}'`, l.text);
  }
  if (o.missing.length > 0) {
    out.push(
      "",
      `Asides with no summary (still open in the chat; mention them in the hand-off so they are not lost): ${o.missing.map((m) => `'${m.label}' (${m.why})`).join("; ")}.`,
    );
  }
  return out.join("\n").trim();
}

/**
 * *Wrap up* in the picker: the fold step for every ticked aside at once,
 * a wait of at most `waitMs`, the summaries placed (log.md or the
 * message), then the wrap-up itself.
 */
export async function confirmWrapPick(waitMs: number = WAIT_MS, now: () => Date = () => new Date()): Promise<void> {
  const go = pendingGo;
  const chat = wrapPick.chat;
  if (!go || !chat || wrapPick.stage !== "pick") return;
  const ticked = wrapPick.rows.filter((r) => r.ticked).map((r) => r.aside);
  if (ticked.length === 0) {
    closePicker();
    await go("");
    return;
  }
  wrapPick.stage = "summarizing";
  const slug = chatThread(app.events);
  const title = chatTitle(chat);
  const results = new Map<Aside, { text: string | null; error: string | null }>();
  const seqs = new Map<Aside, number>();
  const all = Promise.all(
    ticked.map(async (a) => {
      const r = await summarizeAside(a, slug, chat, { onSeq: (n) => seqs.set(a, n) });
      results.set(a, r);
      if (r.text !== null && wrapPick.stage === "summarizing") wrapPick.done = [...wrapPick.done, asideLabel(a, 60)];
    }),
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      skipWait = resolve;
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
  const landed: { label: string; text: string }[] = [];
  const missing: { label: string; why: string }[] = [];
  for (const a of ticked) {
    const label = asideLabel(a, 60);
    const r = results.get(a);
    if (!r) {
      missing.push({ label, why: "no summary within the wait" });
      continue;
    }
    if (r.text === null) {
      missing.push({ label, why: r.error ?? "failed" });
      continue;
    }
    if (slug) {
      try {
        await appendSummary(a, { slug, chat, title, text: r.text }, now());
      } catch (e) {
        missing.push({ label, why: `not appended: ${String(e)}` });
        continue;
      }
    }
    landed.push({ label, text: r.text });
  }
  // Summaries still running past the wait are stopped: the wrap-up turn
  // is next, and the asides stay open for a fold by hand.
  for (const a of ticked) {
    const seq = seqs.get(a);
    if (!results.has(a) && seq !== undefined) void api.cancelAside(seq).catch(() => {});
  }
  closePicker();
  await go(wrapExtra({ slug, landed, missing }));
}
