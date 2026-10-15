// Playwright, Claude's own browser, behind an approval card (nightshift
// backlog 367, blocker 1413). Every Claude Code chat has its tools; each
// call the chat has not allowed pauses for the card, whatever the chat's
// position (bypass included). The card's three answers, as the backend
// keeps them (`agent::own_browser`):
//
// - Allow once — this call, and every Playwright call until this reply ends.
// - Allow for this chat — every call in this chat until its switch is off.
// - Deny — refused, "The user declined Playwright for now.", for the reply.

import type { ApprovalDecision } from "./types";

export const PLAYWRIGHT_PREFIX = "mcp__playwright__";

/** What the model reads on Deny with no note (his words, blocker 1413). */
export const PLAYWRIGHT_DECLINED = "The user declined Playwright for now.";

export function isPlaywright(name: string): boolean {
  return name.startsWith(PLAYWRIGHT_PREFIX);
}

/** The button labels, in order, with the decision each sends. */
export const PLAYWRIGHT_BUTTONS: { label: string; decision: ApprovalDecision; tip: string }[] = [
  { label: "Allow once", decision: "allow", tip: "this call, and every Playwright call until this reply ends" },
  {
    label: "Allow for this chat",
    decision: "always",
    tip: "every Playwright call in this chat runs unasked — the chat's Playwright switch on the rail turns it off",
  },
  { label: "Deny", decision: "deny", tip: "refused for this reply; the model reads the note, or that you declined" },
];

/** The keys whose value says where the call acts, most telling first. */
const TARGET_KEYS = ["url", "element", "selector", "ref", "text", "key", "values", "function", "code", "action"];

/**
 * The action line: the tool in words (`browser_navigate` → "navigate") and
 * what it acts on — the URL, the element, the selector — when the input
 * names one.
 */
export function playwrightAction(name: string, input: unknown): { tool: string; target: string | null } {
  const tool = name
    .slice(name.startsWith(PLAYWRIGHT_PREFIX) ? PLAYWRIGHT_PREFIX.length : 0)
    .replace(/^browser_/, "")
    .replace(/_/g, " ");
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  for (const k of TARGET_KEYS) {
    const v = obj[k];
    if (v === undefined || v === null || v === "") continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return { tool, target: text.length > 400 ? `${text.slice(0, 400)}…` : text };
  }
  return { tool, target: null };
}

/** Fired on the window when a chat's Playwright switch may have changed. */
export const PLAYWRIGHT_CHANGED = "nightloom:playwright-changed";
