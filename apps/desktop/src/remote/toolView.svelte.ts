/**
 * The phone page's tool-call view (nightshift item 977): the desktop's three views (`lib/toolView.ts`), kept in
 * the phone browser's localStorage so a reload keeps it (the phone does not share the Mac's storage). Set from
 * the chat menu; read by the transcript's tool boxes.
 */
import { TOOL_VIEWS, isToolView, nextToolView, type ToolView } from "../lib/toolView";
import type { ToolRow } from "./client";

export const PHONE_TOOL_VIEW_KEY = "nightloom.phone.toolView";

function load(): ToolView {
  try {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(PHONE_TOOL_VIEW_KEY);
    return isToolView(v) ? v : "all";
  } catch {
    return "all";
  }
}

export const phoneTools: { view: ToolView } = $state({ view: load() });

export function setPhoneToolView(view: ToolView): void {
  phoneTools.view = view;
  try {
    localStorage.setItem(PHONE_TOOL_VIEW_KEY, view);
  } catch {
    // best-effort: the view still applies until the page reloads
  }
}

export function stepPhoneToolView(): void {
  setPhoneToolView(nextToolView(phoneTools.view));
}

export function toolViewName(view: ToolView): string {
  return TOOL_VIEWS.find((t) => t.id === view)?.name ?? "Show all";
}

/** Whether the view leaves this row out (the phone's `ok`: null running, false failed, true succeeded). */
function hides(t: ToolRow, view: ToolView): boolean {
  if (view === "all" || t.name === "AskUserQuestion") return false;
  if (view === "none") return true;
  return t.ok === true;
}

/**
 * The rows the view lists. A row it hides stays when something under it shows (a failed step under a
 * finished Agent call), so a failure is never cut off from its parent.
 */
export function filterToolRows(tools: readonly ToolRow[], view: ToolView): ToolRow[] {
  if (view === "all") return [...tools];
  const out: ToolRow[] = [];
  for (const t of tools) {
    const children = filterToolRows(t.children, view);
    if (!hides(t, view) || children.length > 0) out.push({ ...t, children });
  }
  return out;
}

/** Every row, children included. */
export function countRows(tools: readonly ToolRow[]): number {
  return tools.reduce((n, t) => n + 1 + countRows(t.children), 0);
}
