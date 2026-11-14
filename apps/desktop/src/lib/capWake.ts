/** Item 538: kept apart from `turnCap.ts`, which imports the app state that imports this. */
/** The notice a `budget_wake` leaves in the transcript (item 538): what
 *  Nightloom told the main agent, in his terms, not its full line. */
export function wakeNotice(kind: string[], pct: number | null, cap: number | null): string {
  const usage = pct === null ? "usage" : `usage at ${pct}%`;
  const theCap = cap === null ? "the cap" : `the ${cap}% cap`;
  // Item 693: his raise on the chip after a wrap-up — the work goes on.
  if (kind.includes("raised")) return `cap raised to ${cap === null ? "a new figure" : `${cap}%`} — Nightloom told the main agent to stop wrapping up and continue, reusing helpers still warm`;
  if (kind.includes("at_cap")) return `${usage} reached ${theCap} — Nightloom told the main agent to have its helpers wrap up`;
  if (kind.includes("hard")) return `${usage} is close to the plan's limit — Nightloom told the main agent to have its helpers save their work`;
  if (kind.includes("near")) return `${usage} is near ${theCap} — Nightloom told the main agent to have its helpers wrap up`;
  if (kind.includes("reserved")) return `the running helpers are expected to reach ${theCap} — Nightloom told the main agent to launch no more`;
  return `${usage}, ${theCap} — Nightloom gave the main agent a pacing update`;
}
