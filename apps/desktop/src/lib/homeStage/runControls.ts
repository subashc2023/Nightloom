/**
 * Run's controls (item 872; 846 §4 Run, §7 step 7), pure where they can be: the words Home reads for each, and Stop
 * now's order — the routed chat is stopped first, and only a stop that landed is told to Home (a short turn,
 * blocker 2143); one that did not says so and changes nothing. Resume and Run this step again are short turns too
 * (blocker 2199's default). Nothing here calls a model itself.
 */
import { stageHost } from "./host";
import { nudge } from "./tasks.svelte";

export function stopNowLine(live: string | null): string {
  return `you stopped the chat running this now${live ? `, in the middle of "${live}"` : ""} — what it had done stays; start nothing in this chain until you resume it`;
}

export function resumeLine(halted: boolean): string {
  return `you resumed the chain (${halted ? "its chat was stopped" : "you had asked it to stop after the step in hand"}) — carry on from where it stopped`;
}

export function againLine(step: string, failed: boolean): string {
  return `you asked to run step "${step}" again${failed ? " (it had failed)" : ""} — send it into the chat running this`;
}

/** Stop the routed chat, then tell Home. True when the chat was stopped. */
export async function stopThenTell(task: { name: string; view: string }, chat: string, live: string | null): Promise<boolean> {
  try {
    await stageHost.now.stopChat(chat);
  } catch (e) {
    stageHost.now.toast(`The chat was not stopped — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  nudge(task, stopNowLine(live));
  return true;
}
