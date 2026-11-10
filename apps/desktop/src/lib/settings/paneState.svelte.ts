// What a grouped Settings pane remembers (nightshift backlog 546; his rule
// of 2026-11-02: every view keeps its place, mode, toggle and fold). The
// Settings modal is unmounted on close, so this lives at module level:
// which groups are open, and which "?" explanations, survive a relaunch
// (localStorage); the filter survives closing and reopening Settings but
// not a relaunch, so a stale filter never hides a setting at launch.

const KEY = "nightloom.settings.folds";

function load(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export const paneState = $state<{ open: Record<string, boolean>; filter: Record<string, string> }>({
  open: load(),
  filter: {},
});

/** Whether the fold `key` (e.g. "subscription/handoff") is open. Closed by default. */
export function isOpen(key: string): boolean {
  return paneState.open[key] === true;
}

export function setOpen(key: string, open: boolean): void {
  paneState.open[key] = open;
  try {
    localStorage.setItem(KEY, JSON.stringify(paneState.open));
  } catch {
    // A full or missing store loses only the fold, never a setting.
  }
}

export function paneFilter(pane: string): string {
  return paneState.filter[pane] ?? "";
}

export function setPaneFilter(pane: string, text: string): void {
  paneState.filter[pane] = text;
}
