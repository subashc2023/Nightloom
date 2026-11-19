/**
 * The hand-off card's Minimize (backlog 383): a chat's card folds to one
 * line above the box. Kept per chat for the app's run, so a chat switch
 * keeps it folded; keyed by the stage it was folded at. ~~so the next stage
 * (the notice becomes "HANDOFF.md written") opens in full once~~ — item 506:
 * only the notice folds now.
 *
 * Item 705 (option A, Console — his pick, blocker 2167): three sizes, not
 * two — `full`, `compact` (the explanation and the goal hide, the message
 * folds to two lines) and `mini` (the one line). ~~Kept for the app's run~~ —
 * kept on disk (`viewState`), so a size he chose survives a relaunch as well
 * as a chat switch (practices §7: every view keeps its state). Folding
 * drops nothing: the message and the goal are kept per chat in
 * `handoff.svelte.ts` as he types.
 */
import type { HandoffStage } from "./handoff.svelte";
import { viewGet, viewSet } from "./viewState";

export type CardSize = "full" | "compact" | "mini";
export const CARD_SIZES: readonly CardSize[] = ["full", "compact", "mini"];

/** Bumped on each change: `viewState` is a plain map, this makes reads reactive. */
const tick = $state({ n: 0 });

const key = (chat: string) => `handoff.card:${chat}`;

/** The kept value, `<size>:<stage>`; "" when the card is full. */
function read(chat: string): { size: CardSize; stage: string } | null {
  void tick.n;
  const v = viewGet(key(chat), "");
  const [size, stage] = v.split(":");
  if ((size === "compact" || size === "mini") && stage) return { size, stage };
  return null;
}

function write(chat: string, v: string): void {
  viewSet(key(chat), v, "");
  tick.n++;
}

/** The card's size for `chat` at `stage`: full unless he shrank it at that stage. */
export function cardSize(chat: string | null, stage: HandoffStage): CardSize {
  if (chat === null) return "full";
  const r = read(chat);
  return r && r.stage === stage ? r.size : "full";
}

export function setCardSize(chat: string | null, stage: HandoffStage, size: CardSize): void {
  if (chat === null) return;
  write(chat, size === "full" ? "" : `${size}:${stage}`);
}

/** A *Stay here* ends any fold (~~and notes which card it closed~~ — item 506:
 *  the wrapped card is gone, *Hand off* reopens the notice): the card's next showing (the re-ask
 *  past the mark, or *Hand off*) is a fresh ask and opens in full (review
 *  2026-10-18: a notice folded, then wrapped up from the folded line and
 *  stayed past, came back folded at the re-ask). */
export function noteStay(chat: string | null): void {
  if (chat === null) return;
  write(chat, "");
}

export function isFolded(chat: string | null, stage: HandoffStage): boolean {
  return cardSize(chat, stage) === "mini";
}

export function fold(chat: string | null, stage: HandoffStage): void {
  setCardSize(chat, stage, "mini");
}

export function unfold(chat: string | null): void {
  if (chat !== null) write(chat, "");
}

/** How far the grip moves for one step of the card (full → compact → mini). */
export const CARD_STEP_PX = 44;

/**
 * Option A's one handle (his "the thing that resizes the textbox only resizes
 * the textbox … the handoff note should be able to be madde smaller too"):
 * the composer's grip, dragged `dy` px down from where the drag began (up is
 * negative), shrinks the card a step per `CARD_STEP_PX` first, then the box;
 * dragged up, it grows the card back first, then the box. `rest` is what is
 * left of `dy` for the box once the card has gone as far as it goes.
 */
export function dragCard(start: CardSize, dy: number, step: number = CARD_STEP_PX): { size: CardSize; rest: number } {
  const s = CARD_SIZES.indexOf(start);
  const last = CARD_SIZES.length - 1;
  if (dy > 0) {
    const room = last - s;
    const steps = Math.min(room, Math.floor(dy / step));
    return { size: CARD_SIZES[s + steps], rest: steps === room ? dy - room * step : 0 };
  }
  if (dy < 0) {
    const steps = Math.min(s, Math.floor(-dy / step));
    return { size: CARD_SIZES[s - steps], rest: steps === s ? dy + s * step : 0 };
  }
  return { size: start, rest: 0 };
}
