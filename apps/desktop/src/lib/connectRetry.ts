/**
 * Item 888 (his "why the fuck are the buttons all blurred out", 3:53 PM
 * 2026-11-19): a connect that fails leaves `app.connection` null, and with
 * it the composer's +, model and effort buttons disabled and Ask aside and
 * Council gone. The 3:52 PM launch's connect gave up twice after 20 s on a
 * slow disk (the chat's folders, a stat each; `connect.log`), and nothing
 * tried the same chat again — only another chat, a rail change, the
 * transcript's Retry card, or a relaunch. Now a failed connect is retried
 * on its own after a growing wait, until one succeeds.
 *
 * The waits: 5 s, 15 s, 30 s, then every 60 s. A connect costs no tokens
 * (a stat of the folders and the binary's `--version`), so a minute apart
 * is cheap, and a disk that stalls for minutes still comes back on its own.
 */
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

/** The wait before retry number `attempt` (0-based). */
export function retryDelay(attempt: number): number {
  const i = Math.max(0, Math.min(Math.floor(attempt), RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[i];
}

/**
 * The timer that owns the retries: at most one pending, its attempt count
 * reset by a connection that came up. `due` says whether a retry should run
 * when the timer fires (still not connected, an error standing, nothing in
 * flight); `run` connects.
 */
export function makeConnectRetry(opts: {
  due: () => boolean;
  run: () => Promise<void> | void;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setT = opts.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearT = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let attempt = 0;
  return {
    /** Arm the next retry unless one is pending. */
    arm(): void {
      if (timer !== null) return;
      const ms = retryDelay(attempt);
      attempt += 1;
      timer = setT(() => {
        timer = null;
        if (opts.due()) void opts.run();
      }, ms);
    },
    /** Connected (or retried by hand): drop the pending retry, start the waits over. */
    reset(): void {
      if (timer !== null) clearT(timer);
      timer = null;
      attempt = 0;
    },
    get pending(): boolean {
      return timer !== null;
    },
    get attempts(): number {
      return attempt;
    },
  };
}
