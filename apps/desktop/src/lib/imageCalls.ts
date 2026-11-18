// The image tool's count in Settings → Usage (nightshift item 823, stage 1):
// every chat has a `generate_image` tool that is not built yet; each call is
// logged and fails. The count says whether a real one is worth building.
// Tooltips: two short lines, numbers first (memory tooltips-two-short-lines).
import type { ImageCall, ImageCallSummary } from "./api";

/** The card's headline: `3 calls · 2 in the last 14 days`. */
export function countLine(s: ImageCallSummary): string {
  const calls = `${s.total} ${s.total === 1 ? "call" : "calls"}`;
  return `${calls} · ${s.recent} in the last ${s.recent_days} days`;
}

/** The count's hover, two short lines. */
export function countTip(s: ImageCallSummary): string {
  return `${s.total} total · ${s.recent} in ${s.recent_days} days\nEach call failed; none reached a company`;
}

/** What one call asked for, as its row shows it. */
export function askedLine(c: ImageCall): string {
  const what = c.private ? "(incognito chat: prompt not kept)" : (c.prompt ?? "(no prompt)");
  const extras = [c.size, c.style, c.edit ? `edit ${c.edit}` : null].filter(Boolean).join(" · ");
  return extras ? `${what} — ${extras}` : what;
}

/** Where one call came from: `Nightloom · Claude Code`. */
export function whereLine(c: ImageCall): string {
  const engine = c.engine === "api" ? "API" : "Claude Code";
  return [c.project ?? (c.private ? null : "Unfiled"), engine].filter(Boolean).join(" · ");
}
