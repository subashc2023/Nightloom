// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { searchGrowth } from "../search.svelte";
import { DEFAULT_USAGE_LIMITS, parseLimit } from "../autoPass";
import { app } from "../state.svelte";

/**
 * Which project the app reopens at launch. A UI preference, not a source of
 * truth — the backend registry is that, and this only records where the user
 * left off.
 */
const LAST_PROJECT_KEY = "nightloom.last-project";

export function loadLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function saveLastProject(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_PROJECT_KEY, id);
    else localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // best-effort
  }
}

/**
 * How the dream runs: whether a compaction triggers one, and on which model.
 * A UI preference like the last connection — the backend holds no opinion.
 */
const DREAM_PREFS_KEY = "nightloom.dream";

/**
 * The `provider` value that means the Claude Code engine (2026-09-16,
 * nightshift backlog 070): the same string the backend's `AGENT` is, and
 * the one value in the dream dropdown that is not a provider kind.
 */
export const DREAM_ENGINE = "claude-code";

export interface DreamPrefs {
  /** ~~Dream automatically after a compaction, when the inbox has entries.~~
   *  Since nightshift item 278 (2026-10-02): capture and dream by themselves
   *  — at a hand-off, after a compaction, and (with the daily switch) once a
   *  night when the Mac is idle. On by default, his yes. */
  auto: boolean;
  /** Provider that dreams — a provider kind or `DREAM_ENGINE`; "" means
   *  whatever the rail is connected to, the Claude Code engine included. */
  provider: string;
  /** Model that dreams; "" means the provider's default. On `DREAM_ENGINE`
   *  a CLI alias (`haiku`, `sonnet`) and "" the CLI's default. */
  model: string;
  /** Automatic passes wait while the plan's five-hour window is above
   *  this percent (nightshift item 279; default 50). Run now ignores it. */
  limitFiveHour: number;
  /** … or the week above this percent (default 80). */
  limitWeek: number;
}

/**
 * The preference's version. A stored value without it predates item 278,
 * when `auto` defaulted off and meant "after a compaction" — a trigger he
 * never fires — so it is read as on, the new default (his yes, 2026-10-02);
 * the switch he sets from now on is saved with the version and kept.
 */
export const DREAM_PREFS_VERSION = 2;

/** The stored preference read back, or the default when absent or malformed. */
export function parseDreamPrefs(raw: string | null): DreamPrefs {
  try {
    if (raw) {
      const p = JSON.parse(raw) as Partial<DreamPrefs> & { v?: unknown };
      return {
        auto: p.v === DREAM_PREFS_VERSION ? !!p.auto : true,
        provider: typeof p.provider === "string" ? p.provider : "",
        model: typeof p.model === "string" ? p.model : "",
        // Item 279: a value stored before the limits existed reads them as
        // the defaults; the version is not bumped, so his switch is kept.
        limitFiveHour: parseLimit(p.limitFiveHour, DEFAULT_USAGE_LIMITS.fiveHour),
        limitWeek: parseLimit(p.limitWeek, DEFAULT_USAGE_LIMITS.week),
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return {
    auto: true,
    provider: "",
    model: "",
    limitFiveHour: DEFAULT_USAGE_LIMITS.fiveHour,
    limitWeek: DEFAULT_USAGE_LIMITS.week,
  };
}

export function loadDreamPrefs(): DreamPrefs {
  try {
    return parseDreamPrefs(localStorage.getItem(DREAM_PREFS_KEY));
  } catch {
    return parseDreamPrefs(null);
  }
}

export function saveDreamPrefs(): void {
  try {
    localStorage.setItem(DREAM_PREFS_KEY, JSON.stringify({ ...app.dreamPrefs, v: DREAM_PREFS_VERSION }));
  } catch {
    // best-effort
  }
}

/**
 * The colour palette — one of the four dark candidates in `app.css`. "A"
 * (charcoal & amber) is the default and needs no attribute; the others are
 * applied as `data-palette` on the root element so the token blocks in
 * `app.css` select themselves.
 */
export type Palette = "A" | "B" | "C" | "D";
export const PALETTES: { id: Palette; name: string }[] = [
  { id: "A", name: "Charcoal & amber" },
  { id: "B", name: "Slate & copper" },
  { id: "C", name: "Graphite & teal" },
  { id: "D", name: "Espresso & gold" },
];
const PALETTE_KEY = "nightloom.palette";

export function loadPalette(): Palette {
  try {
    const raw = localStorage.getItem(PALETTE_KEY);
    if (raw === "B" || raw === "C" || raw === "D") return raw;
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return "A";
}

/** Stamp the palette on the document. Safe where there is no document. */
export function applyPalette(p: Palette): void {
  if (typeof document === "undefined") return;
  // Under the Classic layout (item 542, `layout.svelte.ts`) "A" is the old
  // charcoal & amber, kept in app.css as `classic-A`.
  if (p === "A" && document.documentElement.dataset.layout === "classic") document.documentElement.dataset.palette = "classic-A";
  else if (p === "A") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = p;
}

export function setPalette(p: Palette): void {
  app.palette = p;
  applyPalette(p);
  try {
    localStorage.setItem(PALETTE_KEY, p);
  } catch {
    // best-effort
  }
}

/**
 * Where the panes sit: the sidebar's width and whether it is collapsed, and
 * the width of every resizable pane on the Nightshift screens, keyed by
 * screen and side (`morning.aside`, `runs.list`, …). A UI preference; a
 * lost one costs a drag, not data.
 */
export interface Layout {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  panes: Record<string, number>;
}
const LAYOUT_KEY = "nightloom.layout";
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 440;

export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Layout>;
      const w = typeof p.sidebarWidth === "number" ? p.sidebarWidth : 260;
      return {
        sidebarWidth: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)),
        sidebarCollapsed: !!p.sidebarCollapsed,
        panes:
          p.panes && typeof p.panes === "object"
            ? Object.fromEntries(
                Object.entries(p.panes).filter(
                  ([, v]) => typeof v === "number" && Number.isFinite(v),
                ),
              )
            : {},
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return { sidebarWidth: 260, sidebarCollapsed: false, panes: {} };
}

function saveLayout(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(app.layout));
  } catch {
    // best-effort
  }
}

export function toggleSidebar(): void {
  app.layout.sidebarCollapsed = !app.layout.sidebarCollapsed;
  saveLayout();
}

export function sidebarColumn(): number {
  return sidebarShown() + Math.round(searchGrowth.current);
}

/**
 * The most of the window the sidebar may take (nightshift item 360, the
 * zoom audit). Its width is CSS px, so ⌘+ (page zoom) grows it with
 * everything else while the window's CSS width shrinks: at the narrowest
 * window (700 points) and 125 % the 260 px sidebar took 46 % of a 560 px
 * page, and the chat was left 300 px — the top bar on two rows, the
 * approval card scrolling sideways, the welcome composer's Send cut off.
 * Past this share the sidebar is drawn narrower (never under its minimum);
 * the saved width is untouched and comes back as the window widens.
 */
export const SIDEBAR_SHARE = 0.34;
export function fitSidebar(saved: number, viewport: number): number {
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(saved, viewport * SIDEBAR_SHARE)));
}
/** The window's CSS width — what `innerWidth` reads, page zoom included. */
export const viewport = $state({ w: typeof window === "undefined" ? 1440 : window.innerWidth });
/** The sidebar's drawn width: the saved one, fitted to the window. */
export function sidebarShown(): number {
  return fitSidebar(app.layout.sidebarWidth, viewport.w);
}

export function setSidebarWidth(px: number): void {
  app.layout.sidebarWidth = Math.round(
    Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)),
  );
  saveLayout();
}

/** A pane's saved width, or the screen's default. */
export function paneWidth(key: string, fallback: number): number {
  return app.layout.panes[key] ?? fallback;
}

export function setPaneWidth(key: string, px: number): void {
  app.layout.panes[key] = Math.round(px);
  saveLayout();
}

/**
 * Morning pages the user has opened, per project. The contract has no
 * notion of a read page — the runner writes them and nothing reads them
 * back — so "unread" is a fact about this window, kept here.
 */
export const READ_KEY = "nightloom.nightshift.read";

export function loadReadPages(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(READ_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(p)) {
        if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string");
      }
      return out;
    }
  } catch {
    // best-effort
  }
  return {};
}
