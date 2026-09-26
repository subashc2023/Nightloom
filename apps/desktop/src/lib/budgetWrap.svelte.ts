/**
 * *Wrap up* at the usage line (nightshift backlog 192, his words on blocker
 * 292: "there should still be a button somewhere saying like wrap up or
 * something that i can click which then causes the wrap up"). On the stop
 * card and on the budget meter (Running tasks).
 *
 * While the chat's turn runs, the click is an answer to the budget hook
 * (`wrap`, with the instruction): the chat's next tool call — the held one,
 * if one is held — is refused with the instruction, which is how the model
 * hears it mid-turn, and the rest of the message's calls go on so it can
 * write its hand-off (spawns refused). If the turn ends before any call
 * carried it, the instruction goes as the next message instead. With no
 * turn running it goes as a message at once. The words are the chat's own
 * 086 wrap-up (his edit, else the default), with the usage line's reason
 * in place of the full-context one (blocker 311).
 */
import { app, addToast, readTurnBudget, send } from "./state.svelte";
import { message } from "./handoff.svelte";
import { budgetOverride } from "./api";
import { usageWrapUp } from "./budget";

/** The chat whose running turn was asked to wrap up, until the turn ends. */
export const wrapAsk = $state<{ session: string | null }>({ session: null });

/** The words the button sends for this chat. */
export function wrapUpText(session: string): string {
  return usageWrapUp(message(session));
}

/** The chat the button acts on: the running chat while a turn runs
 *  (parked or not), else the open one. */
export function wrapTarget(): string | null {
  if (app.connection?.engine !== "claude-code") return null;
  return app.busy ? app.budgetSession : app.activeSessionId;
}

/** The click. Errors are toasts; nothing throws. */
export async function wrapUp(session: string): Promise<void> {
  const text = wrapUpText(session);
  try {
    if (app.busy) {
      if (app.budgetSession !== session) {
        addToast("Wrap up: that chat is not the one running");
        return;
      }
      await budgetOverride(session, "wrap", text);
      wrapAsk.session = session;
      await readTurnBudget(session);
      return;
    }
    if (app.activeSessionId !== session) {
      addToast("Wrap up: open the chat first");
      return;
    }
    await send(text);
  } catch (e) {
    addToast(String(e));
  }
}

/** The turn has ended: a wrap-up no call carried goes as the next message. */
export async function afterWrapTurn(): Promise<void> {
  const session = wrapAsk.session;
  if (!session || app.busy) return;
  wrapAsk.session = null;
  await readTurnBudget(session);
  if (app.turnBudget?.wrap_at_ms) return;
  if (app.busy || app.activeSessionId !== session) {
    addToast("The turn ended before your Wrap up reached the model — press Wrap up again in that chat");
    return;
  }
  await send(wrapUpText(session));
}
