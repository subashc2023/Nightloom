/**
 * Item 657 (his "the aside * subscription button doesn't do anything in the
 * aside page"): the aside tab's engine chip opens that aside's own pickers.
 *
 * In a main chat the chip `Claude Code · subscription` opens the rail — the
 * chat's settings (engine, kind, model, effort…). An aside's settings are its
 * model and effort (backlog 283, kept on the thread), and they live in the
 * aside composer's two pickers, so the chip asks that composer to open its
 * model menu, with the effort button beside it. The chip and the composer
 * are in different components (TopBar, AsideView's Composer); this is the
 * one wire between them: the chip bumps `n`, the composer of the same
 * thread opens its menu, and writes back whether it is open so the chip can
 * draw `aria-expanded` and toggle.
 */

export interface AsidePickAsk {
  /** The aside's chat id and thread id the ask is for. */
  chat: string | null;
  thread: number | null;
  /** Bumped on every ask; a composer acts on a number it has not seen. */
  n: number;
  /** The chat and thread whose composer has its model or effort menu open. */
  openChat: string | null;
  openThread: number | null;
}

export const asidePick = $state<AsidePickAsk>({ chat: null, thread: null, n: 0, openChat: null, openThread: null });

/** The chip: ask the composer of this thread to open its model menu. */
export function askAsidePick(chat: string, thread: number): void {
  asidePick.chat = chat;
  asidePick.thread = thread;
  asidePick.n += 1;
}

/** Whether an ask is new for the composer of `chat`'s thread `thread`. */
export function askIsFor(ask: Pick<AsidePickAsk, "chat" | "thread" | "n">, chat: string | null, thread: number | null, seen: number): boolean {
  return ask.n !== seen && chat !== null && thread !== null && ask.chat === chat && ask.thread === thread;
}

/** Whether `chat`'s thread `thread` has its composer's picker open. */
export function pickOpenFor(state: Pick<AsidePickAsk, "openChat" | "openThread">, chat: string | null, thread: number | null): boolean {
  return chat !== null && thread !== null && state.openChat === chat && state.openThread === thread;
}
