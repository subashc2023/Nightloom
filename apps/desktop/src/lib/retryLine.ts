/**
 * The turn's retry line (nightshift items 440 + 441, 2026-10-27).
 *
 * The Claude Code CLI retries a failed API call up to ten times, and says
 * so on each try (`system/api_retry`; the service's `retry` event). Until
 * now each try was a notice the window toasted when the turn returned: a
 * stalled send showed only the ticking clock while it retried (440), and a
 * Stop pressed during the retries ended in a stack of "retrying after
 * unknown (n/10)" toasts — "unknown" being the CLI's word for a call that
 * got no HTTP status back, a failed connection — under "interrupted —
 * Claude Code ended the turn" (441).
 *
 * Now: **one** line in the live reply, updated in place on each try, in
 * words ("Can't reach Claude — no connection · retrying (2/10)"). It goes
 * away the moment the reply's first word or call arrives; a Stop turns it
 * to "stopping" and later tries leave it alone. A Stop he pressed himself
 * toasts nothing: the transcript's own "stopped" mark is the one notice.
 */

/** The live reply's retry line. One per reply, replaced in place. */
export interface RetrySegment {
  kind: "retry";
  attempt: number;
  max: number;
  /** The CLI's category: `overloaded`, `rate_limit`, `authentication_failed`,
   *  `server_error`, `cloud_credential_error`, or `unknown`. */
  error: string | null;
  /** The HTTP status, null when nothing came back (no connection). */
  status: number | null;
  /** Wait before the next try, ms. */
  delayMs: number | null;
  /** Set when the call timed out with no response at all, ms waited. */
  waitedMs: number | null;
  /** He pressed Stop: the line says so and later tries leave it. */
  stopping?: boolean;
}

/** The service's event, as `types.ts` carries it. */
export interface RetryEvent {
  type: "retry";
  attempt: number;
  max_retries: number;
  error: string | null;
  status: number | null;
  delay_ms: number | null;
  waited_ms: number | null;
}

/** Whether the failure is the connection's: nothing came back at all. */
export function isConnectionFailure(seg: Pick<RetrySegment, "error" | "status" | "waitedMs">): boolean {
  return seg.status === null && (seg.error === null || seg.error === "unknown" || seg.waitedMs !== null);
}

/** Why it is retrying, in his words — the real reason when the CLI gave one. */
export function retryReason(seg: Pick<RetrySegment, "error" | "status" | "waitedMs">): string {
  if (seg.waitedMs !== null && seg.status === null) {
    return `Claude didn't answer in ${Math.round(seg.waitedMs / 1000)} s`;
  }
  if (isConnectionFailure(seg)) return "Can't reach Claude — no connection";
  const http = seg.status !== null ? ` (HTTP ${seg.status})` : "";
  switch (seg.error) {
    case "overloaded":
      return `Claude is overloaded${http}`;
    case "rate_limit":
      return `Rate limited by Anthropic${http}`;
    case "authentication_failed":
      return `Claude Code's sign-in was refused${http}`;
    case "server_error":
      return `Anthropic's server returned an error${http}`;
    case "cloud_credential_error":
      return "The cloud credentials were refused";
    default:
      return `The call to Claude failed${http}`;
  }
}

/** The line's words. */
export function retryText(seg: RetrySegment): string {
  const why = retryReason(seg);
  if (seg.stopping) return `${why} — stopping`;
  return `${why} · retrying (${seg.attempt}/${seg.max})…`;
}

type Seg = { kind: string };

/**
 * One try into the live reply's segments: the line updated in place when
 * there is one, else pushed. A line already stopping is left as it is —
 * the CLI may try once more on its way out, and the count climbing after
 * Stop read as Stop not working. Returns whether anything changed.
 */
export function applyRetry(segments: Seg[], ev: RetryEvent): boolean {
  const at = segments.findIndex((s) => s.kind === "retry");
  const old = at >= 0 ? (segments[at] as unknown as RetrySegment) : null;
  if (old?.stopping) return false;
  const seg: RetrySegment = {
    kind: "retry",
    attempt: ev.attempt,
    max: ev.max_retries,
    error: ev.error ?? null,
    status: ev.status ?? null,
    delayMs: ev.delay_ms ?? null,
    waitedMs: ev.waited_ms ?? null,
  };
  if (old) Object.assign(old, seg);
  else segments.push(seg as unknown as Seg);
  return true;
}

/** The reply's first word or call arrived: the connection is back, and
 *  the line goes. Returns whether one was there. */
export function clearRetry(segments: Seg[]): boolean {
  const at = segments.findIndex((s) => s.kind === "retry");
  if (at < 0) return false;
  segments.splice(at, 1);
  return true;
}

/** He pressed Stop while it retried: the line says "stopping". */
export function markRetryStopping(segments: Seg[] | null | undefined): boolean {
  const seg = segments?.find((s) => s.kind === "retry") as RetrySegment | undefined;
  if (!seg || seg.stopping) return false;
  seg.stopping = true;
  return true;
}

/**
 * The notices a returned turn toasts. A Stop he pressed himself ends the
 * turn as he asked, and the transcript marks the reply stopped — so the
 * service's "interrupted" notice (kept on the outcome for its other
 * readers: the council's seats, the phone) is not toasted as well. A kill
 * after an unanswered interrupt still is: that is news. A retry notice
 * from an older service is never toasted — the line said it.
 */
export function turnNotices(notices: readonly string[], stoppedByHim: boolean): string[] {
  return notices.filter((n) => {
    if (/^retrying after .+ \(\d+\/\d+\)$/.test(n)) return false;
    if (stoppedByHim && (n === "interrupted" || n === "interrupted — Claude Code ended the turn")) return false;
    return true;
  });
}
