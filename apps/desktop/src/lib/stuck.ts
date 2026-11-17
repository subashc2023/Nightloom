/**
 * The runaway guard's card (nightshift item 784): a run nobody was watching
 * — a job, a Mac he had left, an away server with no phone connected —
 * made the same tool call with the same result three times in a row (or
 * far more calls than its runs usually take), so it was paused. The card
 * arrives on the approval channel under a name no real tool has; Continue
 * is an allow, Stop a deny. Pure: the words the Mac's card, the phone's
 * card and the push share.
 */

/** The backend's name for the card (`runaway::STUCK_TOOL`). */
export const STUCK_TOOL = "nightloom_stuck";

export function isStuck(name: string): boolean {
  return name === STUCK_TOOL;
}

export interface StuckView {
  /** "Looks stuck: ran `cargo test` 3 times, same result". */
  sentence: string;
  /** The job's name, when the run is a job's. */
  job: string | null;
  /** The repeated call as typed, for a repeat; null for the calls ceiling. */
  ran: string | null;
  /** What it got back each time. */
  result: string | null;
  error: boolean;
  /** What Continue does, in one line. */
  then: string;
}

/** The card's fields from its input (`runaway::Trip::card_input`). */
export function stuckView(input: unknown, reason?: string | null): StuckView {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string) : null);
  const repeat = o.why === "repeat";
  const count = typeof o.count === "number" ? o.count : 3;
  return {
    sentence: str("sentence") ?? reason ?? "Looks stuck",
    job: str("job"),
    ran: repeat ? str("shown") : null,
    result: repeat ? str("result") : null,
    error: o.error === true,
    then: repeat
      ? `Continue: it carries on and pauses again only after ${count * 2} more of the same.`
      : "Continue: it carries on, up to twice as many calls.",
  };
}
