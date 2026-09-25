/**
 * Settings' nav order and the Usage & Cost refresh, pure so the tests can
 * hold them (nightshift backlog 153, 2026-09-24; backlog 206, 2026-09-25).
 *
 * Backlog 127 split Usage and Cost into two panes; 153 merged them into one
 * page. That misread his ask — 206, his words: "i did not say to put usage
 * and cost in the same direct page, just in the same category of settings
 * bro, like two diff tabs but both in the same like header category". So:
 * one nav category, *Usage & Cost*, with two tabs under it — Usage (the
 * plan's windows, the surfaces and caps) and Cost (the spend, the provider
 * credits, the ledger). 153's second half stands: Refresh now, on either
 * tab, refreshes both.
 */

/** A nav group: its title and its panes, in order (backlog 109's ⌘-digits count groups). */
export interface NavGroup {
  title: string;
  panes: string[];
}

/** The Usage tab's pane id — the top of Settings. */
export const USAGE_PANE = "usage";
/** The Cost tab's pane id (127's, back since 206). */
export const COST_PANE = "cost";
/** The nav category both tabs sit under (backlog 206). */
export const USAGE_COST_GROUP = "Usage & Cost";

/**
 * A pane id as the modal holds it. Between 153 and 206 `cost` folded into
 * the merged pane; it is a tab of its own again, so every id is its own.
 * Kept as the one place a retired id would be mapped.
 */
export function canonicalPane(pane: string): string {
  return pane;
}

/**
 * The pane Settings opens on (backlog 109): the pane a round trip asked
 * for, else the pane he left within the last two minutes, else the top
 * pane — Usage, the first row of the nav. His words: "After those
 * two minutes, it should default back … to the top page." Until
 * 2026-09-25 the fallback was the rail's provider, so once a provider
 * engine had been chosen ⌘, opened on Providers → Anthropic after the two
 * minutes (walk 2026-09-25 part 2).
 */
export function openingPane(asked: string | null | undefined, recent: string | null): string {
  return canonicalPane(asked ?? recent ?? USAGE_PANE);
}

/**
 * The groups in nav order. The order is his (backlog 127, 2026-09-16) with
 * Usage and Cost as two tabs of one group since 206: ⌘1 Usage & Cost (⌘1
 * again steps Usage → Cost), ⌘2 Subscription, ⌘3 Knowledge, ⌘4 Projects,
 * ⌘5 Providers, ⌘6 Web search, ⌘7 Appearance, ⌘8 Remote.
 */
export function settingsGroups(providerKinds: string[], searchBackendNames: string[]): NavGroup[] {
  return [
    { title: USAGE_COST_GROUP, panes: [USAGE_PANE, COST_PANE] },
    { title: "Subscription", panes: ["claude-code", "council"] },
    { title: "Knowledge", panes: ["knowledge", "models"] },
    { title: "Projects", panes: ["projects"] },
    { title: "Providers", panes: [...providerKinds] },
    { title: "Web search", panes: searchBackendNames.map((n) => "search:" + n) },
    { title: "Appearance", panes: ["appearance"] },
    { title: "Remote", panes: ["remote"] },
  ];
}

/** The ⌘-chip for a group, by its title; empty when there is no such group or it is past ⌘9. */
export function groupKey(groups: NavGroup[], title: string): string {
  const i = groups.findIndex((g) => g.title === title);
  return i < 0 || i > 8 ? "" : `⌘${i + 1}`;
}

/** What Refresh now needs, injected so a test can count the calls. */
export interface UsageCostRefresh<U> {
  /** Run the collector and re-read the ledger (the surfaces and the spend table). */
  ledger: () => Promise<U>;
  /** Re-read the plan's two windows (the gauges). Swallows its own errors. */
  plan: () => Promise<void>;
  /** Ask each provider for its credits (the Cost half's second table). Swallows its own errors. */
  credits: () => Promise<void>;
  /** The clock, for the last-read stamps. */
  now?: () => Date;
}

/** What one Refresh now brought back. */
export interface UsageCostResult<U> {
  /** The fresh ledger, or null when the collector failed (the old one stays on screen). */
  usage: U | null;
  /** The collector's error, verbatim, or null. */
  error: string | null;
  /** When the ledger was read, or null when it failed. */
  ledgerReadAt: Date | null;
  /** When the plan and the credits were read (their own failures keep the last reading). */
  readAt: Date;
}

/**
 * One Refresh now for both tabs, whichever it is pressed on: the collector
 * and ledger, the plan gauges and the provider credits, all at once.
 * Before 153 the button ran
 * the collector only; the Cost pane re-read the ledger when opened and
 * the credits only by their own button. The native banner (backlog 116)
 * stays the caller's: it follows this, and only this — never the
 * automatic refresh.
 */
export async function refreshUsageAndCost<U>(deps: UsageCostRefresh<U>): Promise<UsageCostResult<U>> {
  const now = deps.now ?? (() => new Date());
  const [ledger] = await Promise.allSettled([deps.ledger(), deps.plan(), deps.credits()]);
  const readAt = now();
  if (ledger.status === "fulfilled") {
    return { usage: ledger.value, error: null, ledgerReadAt: readAt, readAt };
  }
  return { usage: null, error: String(ledger.reason), ledgerReadAt: null, readAt };
}

/** "read 14:05" — a last-read stamp in the machine's own clock. */
export function readStamp(at: Date | null): string {
  if (!at) return "not read yet";
  return "read " + at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
