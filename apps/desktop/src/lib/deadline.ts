/**
 * A backend call that must not hang the window (nightshift item 220,
 * 2026-09-25). The installed app sat at "connecting…" for forty minutes:
 * the `connect_agent` promise never settled, and the rail stays locked for
 * exactly as long as `app.connecting` is true. The backend has its own
 * deadline (`connect_deadline.rs`, 20 s, naming what it waited on); this
 * one is the window's, a little longer, for a promise the backend never
 * answers at all.
 */

/** The window's deadline on a connect: the backend's 20 s plus a margin. */
export const CONNECT_DEADLINE_MS = 25_000;

/** `p`, or a rejection with a sentence naming `what` after `ms`. */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        `${what} got no answer in ${Math.round(ms / 1000)} s. The rail is unlocked again; ` +
          "reconnect (change any setting) to try once more.",
      );
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
