/**
 * Which tool calls a reply lists (nightshift item 977): the pure parts, shared by the desktop transcript
 * (`transcriptPrefs.svelte.ts`) and the phone page (`remote/toolView.svelte.ts`). From 762's survey (T3 Code's
 * "Tool calls in chat"): every call; only those that failed, were refused or are still running; or none. A call waiting on
 * his answer and the model's own question are always shown, and a hidden run leaves one line that counts it
 * and shows it for that block.
 */
export const TOOL_VIEWS = [
  { id: "all", name: "Show all" },
  { id: "failed", name: "Hide successful" },
  { id: "none", name: "Hide all" },
] as const;
export type ToolView = (typeof TOOL_VIEWS)[number]["id"];

export function isToolView(v: unknown): v is ToolView {
  return TOOL_VIEWS.some((t) => t.id === v);
}

/** The palette's step: Show all → Hide successful → Hide all → Show all. */
export function nextToolView(view: ToolView): ToolView {
  const i = TOOL_VIEWS.findIndex((t) => t.id === view);
  return TOOL_VIEWS[(i + 1) % TOOL_VIEWS.length].id;
}

/** The slice of a call `toolHidden` reads. */
export interface ToolLike {
  id: string;
  name: string;
  result: { is_error: boolean } | null;
  denied?: boolean;
}

/**
 * Whether the trace leaves this call out under `view`. Never a call waiting on him (`waiting`), never the
 * model's question (AskUserQuestion: his answer is the conversation, not the model's working). Under
 * "failed" a call shows while it runs and when it failed or was refused.
 */
export function toolHidden(call: ToolLike, view: ToolView, waiting: boolean): boolean {
  if (view === "all" || waiting || call.name === "AskUserQuestion") return false;
  if (view === "none") return true;
  // Still running: shown, so he sees what the turn is doing now.
  if (call.result === null) return false;
  return !call.result.is_error && !call.denied;
}
