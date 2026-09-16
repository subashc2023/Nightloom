/**
 * The message navigator's model (nightshift backlog 065, 2026-09-15): one
 * tick per live message, for the strip `Navigator.svelte` draws at the
 * transcript's right edge. Pure — events in, ticks out — so the suite can
 * pin it without a DOM, and so the strip is a projection of the log the
 * way the transcript is.
 *
 * Modelled on the screenshot he sent of LibreChat's rail (their
 * `client/src/components/Chat/Messages/MessageNav.tsx`, read 2026-09-15):
 * a short horizontal tick per message, wider for a longer one, the one
 * being read drawn bright, a hover bubble with the start of its text.
 * Nothing of theirs is copied; the interaction is what was borrowed.
 */
import type { SessionEvent } from "./types";

export interface Tick {
  /** The event's index in the log — what the turn's anchor carries. */
  index: number;
  role: "user" | "assistant";
  /** Log-scaled length in [0.25, 1]: the tick's width as a fraction. */
  weight: number;
  /** The message's first non-empty line, for the hover bubble. */
  first_line: string;
}

/** Under this many ticks the strip is not drawn: three rows need no map. */
export const MIN_TICKS = 4;

/** Characters at which a tick is full width; anything longer is the same. */
export const FULL_WEIGHT_CHARS = 4000;
export const MIN_WEIGHT = 0.25;
const FIRST_LINE_CHARS = 140;

/**
 * Log scale, so a two-line question and a ten-line one look different
 * and a 4k reply and a 40k one do not: past a screenful the width stops
 * saying anything the bubble does not say better.
 */
export function weightOf(chars: number): number {
  const n = Math.max(0, chars);
  const t = Math.log10(1 + n) / Math.log10(1 + FULL_WEIGHT_CHARS);
  return MIN_WEIGHT + (1 - MIN_WEIGHT) * Math.min(1, Math.max(0, t));
}

/** The first non-empty line, whitespace collapsed, cut with an ellipsis. */
export function firstLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    return line.length > FIRST_LINE_CHARS ? `${line.slice(0, FIRST_LINE_CHARS - 1).trimEnd()}…` : line;
  }
  return "";
}

/**
 * The ticks. `live` is `liveFlags(events)`: a rewound turn is drawn greyed
 * in the transcript but is not part of the conversation, and a map of the
 * conversation should not offer it. `texts`, when given, is `editTexts`'s
 * output — the edited wording where a turn has one — so the bubble says
 * what the bubble on screen says. Compactions and tool results are not
 * messages and get no tick.
 */
export function ticks(
  events: SessionEvent[],
  live: boolean[],
  texts?: (string | null)[],
): Tick[] {
  const out: Tick[] = [];
  events.forEach((e, index) => {
    if (!live[index]) return;
    const edited = texts?.[index] ?? null;
    if (e.event === "user_message") {
      const text = edited ?? e.text;
      out.push({ index, role: "user", weight: weightOf(text.length), first_line: firstLine(text) });
    } else if (e.event === "assistant_message") {
      let said = "";
      let calls = 0;
      for (const b of e.blocks) {
        if (b.type === "text") said += b.text;
        else if (b.type === "tool_use") calls++;
      }
      const text = edited ?? said;
      // A reply that only called tools has nothing to quote; say so rather
      // than show an empty bubble, and give it the thinnest tick.
      const line = firstLine(text) || (calls > 0 ? `(${calls} tool ${calls === 1 ? "call" : "calls"})` : "");
      out.push({ index, role: "assistant", weight: weightOf(text.length), first_line: line });
    }
  });
  return out;
}

/** How far under the viewport's top edge a jump lands a message. */
export const JUMP_OFFSET = 12;
/** The reading line: this far under the top edge, or a third of the
 *  viewport if that is less. */
export const READ_LINE = 48;

/**
 * Which tick is being read: the last one whose top is at or above the
 * reading line, a little under the viewport's top edge — the message the
 * top of the screen is inside. A line a third of the way down was tried
 * first and picked the *next* message after every jump to a short one,
 * since a short question and the reply under it both fit above such a
 * line; the line has to be closer to the edge than a short message is
 * tall. At the foot of the chat the last message is the one being read
 * whatever the line says (the last message may be shorter than the
 * viewport). `tops` are the anchors' offsets in the viewport's scroll
 * space, in tick order; null for none.
 */
export function activeTick(
  tops: readonly number[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number = Infinity,
): number | null {
  if (tops.length === 0) return null;
  if (scrollTop + clientHeight >= scrollHeight - 8) return tops.length - 1;
  const line = scrollTop + Math.min(clientHeight / 3, READ_LINE);
  let best = 0;
  tops.forEach((top, i) => {
    if (top <= line) best = i;
  });
  return best;
}

/**
 * The tick a step lands on from the current one: ⌥↓ from the last stays
 * on it, ⌥↑ from the first stays on it, and with nothing current a step
 * down goes to the first and a step up to the last.
 */
export function stepTick(current: number | null, dir: 1 | -1, count: number): number | null {
  if (count === 0) return null;
  if (current === null) return dir > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + dir));
}
