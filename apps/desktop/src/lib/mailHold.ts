/*
 * The hold before a mail goes (nightshift item 993e, blocker 2305: "maybe an undo button for a few seconds for
 * things that can be undo'd"). A sent mail cannot be called back, so its Undo is a wait: his click on "Send to …"
 * starts a countdown, and the one command that sends is called only when it ends. Undo in that time — the card's
 * button, the toast's, or Esc in the card — and nothing is ever called: there is no pass, no process, no send.
 *
 * Pure (a timer and a promise), so the tests pin it with fake timers.
 */

/** How long a mail waits before it goes (Gmail's own default undo window is 5 s). */
export const MAIL_HOLD_MS = 5000;

export interface MailHold {
  /** When the mail goes (ms since the epoch). */
  until: number;
  /** Stop it. True when it was stopped; false when the hold had already ended (too late: it is going). */
  undo: () => boolean;
  /** True when the hold ran out (send now); false when he undid it (send nothing). */
  done: Promise<boolean>;
}

export function startHold(ms: number = MAIL_HOLD_MS, now: () => number = Date.now): MailHold {
  const until = now() + ms;
  let undo: () => boolean = () => false;
  const done = new Promise<boolean>((ok) => {
    let over = false;
    const timer = setTimeout(() => {
      if (over) return;
      over = true;
      ok(true);
    }, ms);
    undo = () => {
      if (over) return false;
      over = true;
      clearTimeout(timer);
      ok(false);
      return true;
    };
  });
  return { until, undo: () => undo(), done };
}

/** Whole seconds left, for the countdown's words (never below 0). */
export function secondsLeft(until: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** Where a mail's hold shows outside the card (the app's progress toasts): started with its Undo, its words
 *  changed each second, settled with what came of it (which drops the Undo). */
export interface HoldToast {
  start: (text: string, undo: () => void) => number;
  update: (id: number, text: string) => void;
  settle: (id: number, text: string) => void;
}

/** What the card is told when he undid a mail in its hold: nothing was sent, his words stay. */
export class MailUndone extends Error {
  readonly undone = true;
  constructor() {
    super("Not sent: you undid it. Your words are still here.");
  }
}

export const isUndone = (e: unknown): e is MailUndone => typeof e === "object" && e !== null && (e as { undone?: unknown }).undone === true;
