/**
 * Item 991: a skip's reason as stored when it happened. Items 950/953 (installed 2026-11-25 2:15 PM) changed what the
 * spend guard writes — a window's figure names when and where its reading was taken, and the pace only advises unless
 * its forecast is sure — but a skip written before (the 8:00 AM scan that morning, under the older build) keeps its
 * old words on the job's row, its Run anyway card, the brief and the phone. Those words are not rewritten (the time of
 * that reading was never kept); they are said as what they are: an older build's rule. Anything else passes through.
 */
export function skipWhy(why: string): string {
  const pace = /^at this pace the (5-hour|weekly) window runs out before it resets$/i.exec(why.trim());
  if (pace) return `by an older build's rule: the ${pace[1]} pace looked too fast (the pace alone no longer skips a run)`;
  return why;
}
