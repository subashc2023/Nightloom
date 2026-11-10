/**
 * The new-chat page's readings (item 563, Filament IV stage 4; 521 report
 * §2 "The new-chat page"), pure so the suite can pin them without a DOM.
 * Each reading comes from what the app already holds; one it does not hold
 * is left out or says so, never drawn from a guess (521 §8): the folder's
 * git branch and clean state, and the last dream's time, are not on the
 * frontend (blocker 1766), so the Folder reading shows the folder only.
 */
import { shortTokens } from "./contextDial";

export interface Reading {
  /** The key the page renders by, and the read-out's caption. */
  key: "engine" | "folder" | "memory" | "plan" | "nightshift" | "model";
  label: string;
  /** The calm row's short value. */
  short: string;
  /** The lit read-out's value and its mono line under it. */
  value: string;
  sub: string;
  /** A tick before the short value: the thing is there and working. */
  ok: boolean;
  /** Something is wrong (not connected, the folder is missing). */
  warn: boolean;
}

export interface ReadingsInput {
  engine: string | null;
  /** The provider's display name, for the API engine. */
  provider: string;
  connected: boolean;
  connecting: boolean;
  subscription: boolean | null;
  cliVersion: string | null;
  model: string | null;
  limit: number | null;
  project: { root: string | null; exists: boolean } | null;
  notes: number;
  vault: number;
  chats: number;
  plan: { five: number; week: number | null; resets: string | null } | null;
  nightshift: {
    enabled: boolean;
    live: boolean;
    /** A held launch's time, already as a clock ("11:00 PM"). */
    armedAt: string | null;
    items: number;
    blockers: number;
  } | null;
}

/** `/Users/you/research/vg` → `~/research/vg`; other paths as they are. */
export function tildePath(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** The last segment of a path: what the calm row has room for. */
export function leafOf(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) || t : t;
}

/** `claude-opus-5-5` → `Opus 5.5`; anything else as it is, `claude-` dropped. */
export function modelName(id: string | null | undefined): string {
  if (!id) return "";
  const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (x) return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}`;
  return id.replace(/^claude-/, "");
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function readings(i: ReadingsInput): Reading[] {
  const out: Reading[] = [];
  const cc = i.engine === "claude-code";

  // Engine.
  const engineName = cc ? "Claude Code" : i.provider || "API";
  const how = cc ? (i.subscription === false ? "API key" : "subscription") : "API";
  out.push({
    key: "engine",
    label: "Engine",
    short: engineName,
    value: `${engineName} · ${how}`,
    sub: i.connected
      ? [cc ? "signed in" : "connected", i.cliVersion ? `CLI ${i.cliVersion}` : ""].filter(Boolean).join(" · ")
      : i.connecting
        ? "connecting…"
        : "not connected",
    ok: i.connected,
    warn: !i.connected && !i.connecting,
  });

  // Folder.
  if (i.project) {
    const root = i.project.root;
    out.push({
      key: "folder",
      label: "Folder",
      short: root ? (i.project.exists ? leafOf(root) : "missing") : "none",
      value: root ? tildePath(root) : "No folder",
      sub: root ? (i.project.exists ? "the model's workspace" : "folder missing") : "notes and chats only",
      ok: !!root && i.project.exists,
      warn: !!root && !i.project.exists,
    });
  } else {
    out.push({
      key: "folder",
      label: "Folder",
      short: "none",
      value: "No project",
      sub: "open one for a workspace",
      ok: false,
      warn: false,
    });
  }

  // Memory.
  out.push({
    key: "memory",
    label: "Memory",
    short: plural(i.notes, "note"),
    value: `${plural(i.notes, "note")} · ${plural(i.chats, "chat")}`,
    sub: i.vault > 0 ? `${i.vault} in the knowledge base` : "no knowledge base notes",
    ok: i.notes + i.vault > 0,
    warn: false,
  });

  // Plan use: the subscription engine's account-wide windows only.
  if (i.plan) {
    const week = i.plan.week != null ? `${Math.round(i.plan.week)}%` : null;
    out.push({
      key: "plan",
      label: "Plan use",
      short: week ? `${Math.round(i.plan.five)}% · ${week}` : `${Math.round(i.plan.five)}%`,
      value: `5 hours ${Math.round(i.plan.five)}%${week ? ` · week ${week}` : ""}`,
      sub: i.plan.resets ? `resets ${i.plan.resets}` : "account-wide",
      ok: false,
      warn: false,
    });
  }

  // Nightshift.
  const ns = i.nightshift;
  if (ns) {
    let short: string;
    let value: string;
    if (!ns.enabled) {
      short = value = "Off";
    } else if (ns.live) {
      short = value = "Running";
    } else if (ns.armedAt) {
      short = `Armed ${ns.armedAt}`;
      value = `Armed for ${ns.armedAt}`;
    } else {
      short = value = "Ready";
    }
    out.push({
      key: "nightshift",
      label: "Nightshift",
      short,
      value,
      sub: ns.enabled
        ? `${plural(ns.items, "item")} · ${plural(ns.blockers, "open blocker")}`
        : "not set up for this project",
      ok: false,
      warn: false,
    });
  }

  // Model: the lit read-outs' sixth.
  const m = modelName(i.model);
  if (m) {
    out.push({
      key: "model",
      label: "Model",
      short: m,
      value: m,
      sub: i.limit ? `${shortTokens(i.limit)} window · cache cold` : "window unknown",
      ok: false,
      warn: false,
    });
  }
  return out;
}

/** "Good morning/afternoon/evening" by the hour (5–12, 12–17, else evening). */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning.";
  if (hour >= 12 && hour < 17) return "Good afternoon.";
  return "Good evening.";
}

/** The four quarter labels around the dial, for a window: 0, ¼, ½, ¾. */
export function quarterLabels(limit: number | null): string[] {
  if (!limit || limit <= 0) return [];
  return [0, 0.25, 0.5, 0.75].map((q) => (q === 0 ? "0" : shortTokens(limit * q)));
}

/**
 * Where a label at share `s` of the way round sits, centred on a circle of
 * radius `r` about (`mid`, `mid`): 0 at twelve o'clock, clockwise.
 */
export function aroundAt(s: number, r: number, mid: number): { x: number; y: number } {
  const a = s * 2 * Math.PI;
  return { x: mid + r * Math.sin(a), y: mid - r * Math.cos(a) };
}

/**
 * The dial's diameter for the page: the mockup's 330 when the pane has room
 * for it over everything under it (`below`: the column's measured height
 * plus the page's padding and the dial's own margin, in the same px as
 * `paneH`, so a zoom changes both alike), smaller on a short pane, and none
 * (0) below a floor — the page is then the column alone, as the old page
 * was below its rings' floor, and the message box stays in view.
 */
export const DIAL_MAX = 330;
export const DIAL_MIN = 150;
export function dialSize(paneH: number, below: number): number {
  const fit = Math.floor(paneH - below);
  if (fit < DIAL_MIN) return 0;
  return Math.min(DIAL_MAX, fit);
}

/** The lit read-outs need the dial plus two columns of ~250 px either side. */
export function readoutsFit(paneW: number, size: number): boolean {
  return size >= 260 && paneW >= size + 2 * 270;
}

/** A thread's `touched` (YYYY-MM-DD) as the list's right-hand date: "today", "Nov 8". */
export function threadWhen(touched: string | null, now: Date = new Date()): string {
  if (!touched) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(touched);
  if (!m) return touched;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.toDateString() === now.toDateString()) return "today";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString("en-US", opts);
}

/** "Mon, Nov 9 · 8:14 PM": the clock line inside the dial (12-hour). */
export function clockLine(now: Date): string {
  const day = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

/** An ISO time as "9:40 PM", or null for none or an unreadable one. */
export function shortClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
