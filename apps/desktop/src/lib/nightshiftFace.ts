/**
 * The Nightshift surface's Filament IV readings (item 566, stage 9; 521
 * report §5, `f4-night.png`): pure, so they are tested apart from the
 * components. Every value comes from data the app already reads — the held
 * launch, the shifts' `status.json` units, the plan draft and the items.
 */
import type { Item, PlanItem, UnitStatus } from "./types";

/** "11:00 PM", "11:00 PM tomorrow" or "11:00 PM Nov 12" — his 12-hour clock. */
export function clock12(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const t = `${h}:${String(d.getMinutes()).padStart(2, "0")} ${ap}`;
  if (d.toDateString() === now.toDateString()) return t;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `${t} tomorrow`;
  return `${t} ${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
}

/** A span as "2 h 46 min", "46 min", "under a minute". */
export function spanWords(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "under a minute";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** A pass's length as the trace prints it: "1 h 02", "0 h 44". */
export function passLength(ms: number): string {
  const min = Math.round(Math.max(0, ms) / 60_000);
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

/** "4 done, 1 partial" — the outcomes of a shift's passes, in a fixed order. */
export function tally(units: UnitStatus[]): string {
  const order = ["done", "partial", "failed", "wip", "running"];
  const n: Record<string, number> = {};
  for (const u of units) {
    const w = u.outcome ?? "running";
    n[w] = (n[w] ?? 0) + 1;
  }
  const words = Object.keys(n).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return words.map((w) => `${n[w]} ${w}`).join(", ");
}

export interface TraceRow {
  n: string;
  item: string;
  pass: number | null;
  /** done | partial | failed | wip | running */
  outcome: string;
  /** Position on the shift's span, 0..100. */
  left: number;
  width: number;
  length: string;
}

/**
 * The last shift pass by pass: each unit's bar placed on the span from the
 * shift's start to its last end (or `now` while one runs). A unit without
 * a start is drawn with no bar (width 0) rather than guessed.
 */
export function passTrace(units: UnitStatus[], now: number = Date.now()): { rows: TraceRow[]; start: number | null; end: number | null } {
  const t = (s: string | null) => (s ? Date.parse(s) : NaN);
  const starts = units.map((u) => t(u.started)).filter(Number.isFinite);
  const ends = units.map((u) => (u.ended ? t(u.ended) : u.started ? now : NaN)).filter(Number.isFinite);
  const start = starts.length ? Math.min(...starts) : null;
  const end = ends.length ? Math.max(...ends) : null;
  const span = start != null && end != null && end > start ? end - start : 0;
  const rows = units.map((u) => {
    const s = t(u.started);
    const e = u.ended ? t(u.ended) : Number.isFinite(s) ? now : NaN;
    const ok = span > 0 && Number.isFinite(s) && Number.isFinite(e) && start != null;
    return {
      n: String(u.n).padStart(2, "0"),
      item: u.item_id ?? "—",
      pass: u.pass,
      outcome: u.outcome ?? "running",
      left: ok ? ((s - start!) / span) * 100 : 0,
      width: ok ? Math.max(0.6, ((e - s) / span) * 100) : 0,
      length: Number.isFinite(s) && Number.isFinite(e) ? passLength(e - s) : "—",
    };
  });
  return { rows, start, end };
}

/** The plan in its run order: the selected items, each with its kind and
 *  its pass cap — what the "Tonight's plan" strip shows. */
export function planRun(planItems: PlanItem[], items: Item[]): { id: string; kind: string; passes: number; title: string }[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return planItems
    .filter((p) => p.selected && byId.has(p.id))
    .map((p) => {
      const it = byId.get(p.id)!;
      return { id: it.id, kind: it.kind, passes: it.max_passes, title: it.title };
    });
}
