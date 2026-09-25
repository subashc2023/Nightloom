/**
 * Settings' nav order and the one Usage · Cost pane's refresh, pure so the
 * tests can hold them (nightshift backlog 153, 2026-09-24).
 *
 * Backlog 127 split Usage and Cost into two panes; 153 (his words: "merge
 * both Usage and Cost in settings into one banner or whatever. Also,
 * refresh now is now on usage but not on cost") puts them back on one:
 * the gauges above, the spend below, one Refresh now for all of it.
 */

/** A nav group: its title and its panes, in order (backlog 109's ⌘-digits count groups). */
export interface NavGroup {
  title: string;
  panes: string[];
}

/** The pane id of the merged pane. `cost` was 127's second pane. */
export const USAGE_PANE = "usage";

/**
 * A pane id as the modal holds it now: `cost` — remembered by backlog
 * 109's two-minute pane memory, or asked for by an older caller — opens
 * the merged pane, which is where its table lives.
 */
export function canonicalPane(pane: string): string {
  return pane === "cost" ? USAGE_PANE : pane;
}

/**
 * The groups in nav order. The order is his (backlog 127, 2026-09-16) with
 * Usage and Cost as one group since 153: ⌘1 Usage · Cost, ⌘2 Subscription,
 * ⌘3 Knowledge, ⌘4 Projects, ⌘5 Providers, ⌘6 Web search, ⌘7 Appearance,
 * ⌘8 Remote.
 */
export function settingsGroups(providerKinds: string[], searchBackendNames: string[]): NavGroup[] {
  return [
    { title: "Usage · Cost", panes: [USAGE_PANE] },
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
 * One Refresh now for the whole pane: the collector and ledger, the plan
 * gauges and the provider credits, all at once. Before 153 the button ran
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
