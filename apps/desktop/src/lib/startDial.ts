/**
 * The new-chat dial's starting context (item 574): what a new chat holds
 * before its first message, split by source, and the motion that shows it.
 * Pure, so the suite pins the numbers the page draws.
 *
 * The backend's parts (`start_context`) are one per Nightloom layer; a
 * layer is a few pixels of a 1M dial, too thin to point at, so the dial
 * draws four groups — Claude Code's own, Nightloom's layers, the
 * instruction files, the auto memory — and a group's hover lists what is
 * in it.
 */
import type { StartContext, StartPart } from "./api";
import { shortTokens } from "./contextDial";

export type StartTone = StartPart["kind"];

export interface StartGroup {
  tone: StartTone;
  name: string;
  tokens: number;
  /** The hover: the group's name and size, then its members when several. */
  tip: string;
}

const ORDER: StartTone[] = ["claude_code", "layer", "instructions", "memory"];
const GROUP_NAME: Record<StartTone, string> = {
  claude_code: "Claude Code's prompt and tools",
  layer: "Nightloom's prompt layers",
  instructions: "Instruction files",
  memory: "Claude Code memory",
};

/** `≈ 2.1k`: every size here is an estimate. */
export function approxTokens(n: number): string {
  return `≈ ${shortTokens(n)}`;
}

/** The parts gathered into the dial's four groups, in drawing order. */
export function startGroups(ctx: StartContext | null): StartGroup[] {
  if (!ctx) return [];
  const out: StartGroup[] = [];
  for (const tone of ORDER) {
    const members = ctx.parts.filter((p) => p.kind === tone && p.tokens > 0);
    if (members.length === 0) continue;
    const tokens = members.reduce((s, p) => s + p.tokens, 0);
    const head = `${GROUP_NAME[tone]} ${approxTokens(tokens)}`;
    const many = members.length > 1 || members[0].name !== GROUP_NAME[tone];
    const tip = many ? `${head} — ${members.map((m) => `${m.name} ${shortTokens(m.tokens)}`).join(" · ")}` : head;
    const lead = tone === "claude_code" ? `${tip} (measured from your last chat here)` : tip;
    out.push({ tone, name: GROUP_NAME[tone], tokens, tip: lead });
  }
  return out;
}

/** The centre's hover: every group on one line each. */
export function startSummary(groups: readonly StartGroup[]): string {
  return groups.map((g) => `${g.name} ${approxTokens(g.tokens)}`).join("\n");
}

/** One drawn part: where it starts and how long it is, as shares of the window. */
export interface StartArc {
  tone: StartTone;
  tip: string;
  from: number;
  share: number;
}

/**
 * The groups laid end to end from 12 o'clock, as shares of `limit`. The
 * sizes passed are the tweened ones, so a re-flow moves every boundary.
 */
export function startArcs(groups: readonly StartGroup[], sizes: readonly number[], limit: number | null): StartArc[] {
  if (!limit || limit <= 0) return [];
  let at = 0;
  return groups.map((g, i) => {
    const share = Math.max(0, sizes[i] ?? 0) / limit;
    const arc = { tone: g.tone, tip: g.tip, from: at, share };
    at += share;
    return arc;
  });
}

/** Ease-out (cubic): fast away, settling in — the sweep and the re-flow. */
export function easeOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

/** The sweep on open and the re-flow on a layer change, in ms (spec 574). */
export const SWEEP_MS = 700;
export const REFLOW_MS = 400;

/**
 * Sizes for the tween at progress `t` (0..1, already eased), from `from`
 * to `to` by tone: a group that appears grows from 0, one that goes
 * shrinks to 0 — so a layer switched off draws its part closing up.
 */
export function blendSizes(
  from: ReadonlyMap<StartTone, number>,
  to: readonly StartGroup[],
  t: number,
): Map<StartTone, number> {
  const out = new Map<StartTone, number>();
  for (const tone of ORDER) {
    const a = from.get(tone) ?? 0;
    const b = to.find((g) => g.tone === tone)?.tokens ?? 0;
    if (a === 0 && b === 0) continue;
    out.set(tone, a + (b - a) * t);
  }
  return out;
}

/** Groups to draw during a tween: the target's, plus any leaving one at its shrinking size. */
export function drawnGroups(
  sizes: ReadonlyMap<StartTone, number>,
  to: readonly StartGroup[],
  leaving: readonly StartGroup[],
): { groups: StartGroup[]; sizes: number[] } {
  const groups: StartGroup[] = [];
  for (const tone of ORDER) {
    const g = to.find((x) => x.tone === tone) ?? leaving.find((x) => x.tone === tone);
    if (g && (sizes.get(tone) ?? 0) > 0) groups.push(g);
  }
  return { groups, sizes: groups.map((g) => sizes.get(g.tone) ?? 0) };
}
