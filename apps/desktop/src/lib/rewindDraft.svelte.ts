/**
 * Rewind puts his message back in the composer (nightshift backlog 247):
 * the Claude app's way — a rewind on one of his messages drops it and
 * everything after it from the thread and puts its text (and its images
 * and files) back in the box, ready to change and send again.
 *
 * What was half-typed there is replaced (blocker 581, his answer): its
 * text goes to the top of the box's draft history and a toast says so,
 * and its attachment chips stay, after the message's own — the history
 * keeps text only, and a chip dropped here would be work lost.
 *
 * Undo gives the box back what it held, unless he has changed the
 * restored text since — then his change stays (never-lose-work).
 */
import type { Attachment, SessionEvent } from "./types";
import { editTexts } from "./edit";

/** What a rewind to `to` hands back to the composer: his message there,
 *  as it now reads (its latest edit), or null when `to` is not one. */
export function rewoundMessage(
  events: SessionEvent[],
  to: number,
  nextId: () => number,
): { text: string; attachments: Attachment[] } | null {
  const e = events[to];
  if (!e || e.event !== "user_message") return null;
  const text = editTexts(events)[to] ?? e.text;
  const attachments: Attachment[] = [
    ...(e.images ?? []).map((img, i) => ({
      id: nextId(),
      kind: "image" as const,
      name: `image-${i + 1}`,
      media_type: img.media_type,
      data: img.data,
    })),
    ...(e.documents ?? []).map((doc) => ({
      id: nextId(),
      kind: "document" as const,
      name: doc.name,
      media_type: doc.media_type,
      data: doc.data,
    })),
  ];
  return { text, attachments };
}

/** The box before and after a rewind filled it — what Undo compares and
 *  gives back. */
export interface BoxSwap {
  before: { text: string; attachments: Attachment[] };
  after: { text: string; attachments: Attachment[] };
  /** The half-typed text went to the history: the toast's cue. */
  stashed: boolean;
  /** Item 724: the box kept what he was typing; the message went to the
   *  drafts instead, offered above the drafts button. */
  kept?: boolean;
}

/**
 * Item 724 (his words, 2026-11-15): a rewind while he has a draft in the
 * box keeps the draft. The box keeps its text; the message's chips join
 * his after them (the history keeps text only, and a chip dropped here
 * would be work lost — 581's rule); the message's text goes to the drafts
 * and is offered alone, just above the drafts button.
 */
export function keepsBox(box: { text: string }): boolean {
  return box.text.trim().length > 0;
}

/** The kept-box rewind (item 724): the box as it was, plus the message's
 *  chips after his. Nothing goes to the history from the box. */
export function keepIn(
  box: { text: string; attachments: Attachment[] },
  back: { text: string; attachments: Attachment[] },
): BoxSwap {
  return {
    before: { text: box.text, attachments: [...box.attachments] },
    after: { text: box.text, attachments: [...box.attachments, ...back.attachments] },
    stashed: false,
    kept: true,
  };
}

/** A click on the offered message (item 724): it takes the box, and what
 *  the box held goes to the drafts when it has any words — nothing lost. */
export function takeOffered(boxText: string, offered: string): { box: string; toDrafts: string | null } {
  return { box: offered, toDrafts: boxText.trim().length > 0 && boxText !== offered ? boxText : null };
}

/**
 * The one-item drafts popover (item 724): the rewound message, offered in
 * the box named by `key` until he picks it, opens another menu or clicks
 * elsewhere. `seq` moves on each offer, so the same text offered twice
 * still opens it again.
 */
export const rewoundOffer = $state<{ key: string | null; text: string; seq: number }>({ key: null, text: "", seq: 0 });

export function offerRewound(key: string, text: string): void {
  rewoundOffer.key = key;
  rewoundOffer.text = text;
  rewoundOffer.seq += 1;
}

/** The offer withdrawn — for `key` only, when one is named. The text
 *  stays in the drafts list either way. */
export function dismissRewoundOffer(key?: string): void {
  if (key === undefined || rewoundOffer.key === key) rewoundOffer.key = null;
}

/** The swap a rewind makes: the message in, the typed text out to the
 *  history (when there is any), its chips kept after the message's. */
export function swapIn(
  box: { text: string; attachments: Attachment[] },
  back: { text: string; attachments: Attachment[] },
): BoxSwap {
  return {
    before: { text: box.text, attachments: [...box.attachments] },
    after: { text: back.text, attachments: [...back.attachments, ...box.attachments] },
    stashed: box.text.trim().length > 0,
  };
}

/** Whether Undo may give the box back: only while the text is still
 *  what the rewind put there. */
export function untouched(box: { text: string }, swap: BoxSwap): boolean {
  return box.text === swap.after.text;
}

/**
 * Where the transcript draws its quiet "N messages rewound" line (blocker
 * 582): at the first item of each run of superseded ones, the run's count
 * of messages — his, and replies that start a new header — and null
 * everywhere else. Superseded items themselves are not drawn.
 */
export function rewoundRuns(
  items: { kind: string; superseded: boolean }[],
  continued: boolean[],
): (number | null)[] {
  const out: (number | null)[] = items.map(() => null);
  let start = -1;
  items.forEach((it, i) => {
    if (!it.superseded) {
      start = -1;
      return;
    }
    if (start < 0) {
      start = i;
      out[i] = 0;
    }
    const counts = it.kind === "user" || (it.kind === "assistant" && !continued[i]);
    if (counts) out[start] = (out[start] ?? 0) + 1;
  });
  return out;
}

/** Asks the composer to take focus with the caret at the end, after a
 *  rewind filled it. */
export const composerFocus = $state<{ seq: number; key?: string }>({ seq: 0 });

/** `key` (item 674's follow-up): the drafts entry whose box takes it — an
 *  aside's box too; absent, the chat's composer, as before. */
export function requestComposerFocus(key?: string): void {
  composerFocus.key = key;
  composerFocus.seq += 1;
}
