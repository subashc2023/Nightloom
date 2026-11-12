/**
 * Item 569: Claude Code's /usage figures for the right column (Filament IV).
 * The shapes of `plan_usage::ScopedLimits` and `session_figures::SessionFigures`
 * (Rust, nightloom-service) and the column's formatting of them.
 */

/** One per-model weekly limit — /usage's "Weekly Fable 51%". */
export interface ScopedLimit {
  name: string;
  percent: number;
  resets_at: string | null;
}

export interface ScopedLimits {
  limits: ScopedLimit[];
  sampled_at_ms: number | null;
  stale: boolean;
}

export interface ModelFigures {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
}

export interface Spender {
  who: string;
  agents: number;
  cost_usd: number;
  share: number;
}

/** A chat's own totals, from its Claude Code transcript's newest `cost-state`. */
export interface SessionFigures {
  found: boolean;
  cost_usd: number | null;
  api_ms: number | null;
  run_ms: number | null;
  lines_added: number | null;
  lines_removed: number | null;
  models: ModelFigures[];
  cache_hit: number | null;
  using: Spender[];
  unknown_cost: boolean;
  /** Item 675: of `cost_usd`, the spend of replies a rewind left behind —
   *  the newest transcript's total no longer holds them. Absent when none. */
  rewound_usd?: number | null;
}

/** `$64.03`; under a cent, `<$0.01`. */
export function usd(n: number): string {
  if (n > 0 && n < 0.005) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** /usage's durations: `2h 3m`, `22m 26s`, `41s`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** `4:30 PM` today, `Wed 2:00 AM` within the week, `Nov 18 2:00 AM` past it. */
export function resetClock(iso: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const hm = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  if (d.toDateString() === new Date(nowMs).toDateString()) return hm;
  if (t - nowMs < 6 * 86_400_000) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}

/** `claude-opus-5-5` → `Opus 5.5`, the way /usage names a model. */
export function modelName(id: string): string {
  const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (x) return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}`;
  return id.replace(/^claude-/, "");
}

/** Each model's share of the chat's cost, whole percent: /usage's "Opus 100% · Haiku 0%". */
export function modelSplit(models: readonly ModelFigures[]): { name: string; pct: number }[] {
  const total = models.reduce((a, m) => a + m.cost_usd, 0);
  if (total <= 0) return [];
  return models.map((m) => ({ name: modelName(m.model), pct: Math.round((m.cost_usd / total) * 100) }));
}

/** `general-purpose ×3`, `main chat`. */
export function spenderName(s: Pick<Spender, "who" | "agents">): string {
  if (s.who === "main") return "Main chat";
  return s.agents > 1 ? `${s.who} ×${s.agents}` : s.who;
}

/**
 * Item 584: a token count in at most five characters, for the Details table
 * at the column's width: `206`, `6.6k`, `110k`, `10.5M`, `1.7B`.
 */
export function compactCount(n: number): string {
  const v = Math.max(0, Math.round(n));
  const step = (d: number, u: string) => {
    const x = v / d;
    return x >= 100 ? `${Math.round(x)}${u}` : `${parseFloat(x.toFixed(1))}${u}`;
  };
  if (v >= 999_500_000) return step(1_000_000_000, "B");
  if (v >= 999_500) return step(1_000_000, "M");
  if (v >= 1_000) return step(1_000, "k");
  return String(v);
}

/** One part of a stacked share bar: its width (0–1) and its whole percent. */
export interface StackPart {
  name: string;
  share: number;
  pct: number;
}

/** Item 584: parts of a stacked bar from raw values (model cost, a spender's share); empty when nothing was spent. */
export function stackParts(items: readonly { name: string; value: number }[]): StackPart[] {
  const total = items.reduce((a, i) => a + Math.max(0, i.value), 0);
  if (total <= 0) return [];
  return items.map((i) => {
    const share = Math.max(0, i.value) / total;
    return { name: i.name, share, pct: Math.round(share * 100) };
  });
}
