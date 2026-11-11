// Settings → Subscription, grouped and searchable (nightshift backlog 546,
// 2026-11-10). He: "i always get lost in all of the diff settings in
// there". The pane was four cards of controls with every explanation
// printed in full; now each group is a folded section whose header says
// what it is set to, a filter at the top narrows to matching controls,
// and the long explanations sit behind a "?" beside their control.
//
// This module is the pane's inventory and its pure logic: which controls
// exist, which group each is in, the words the filter matches, and the
// one-line summaries. `SettingsModal.svelte` renders it; the test checks
// every control here is still rendered and still bound.

export type GroupId = "handoff" | "models" | "subagents" | "updates" | "cache";

export interface Group {
  id: GroupId;
  title: string;
}

/** In the order he reaches for them: the hand-off most, updates least. */
export const GROUPS: readonly Group[] = [
  { id: "handoff", title: "Hand-off" },
  { id: "models", title: "Models" },
  { id: "subagents", title: "Subagent rules" },
  { id: "updates", title: "Updates" },
  // Item 608: keep-warm, on by default for every chat.
  { id: "cache", title: "Keeping caches warm" },
];

export interface Control {
  id: string;
  group: GroupId;
  label: string;
  /** Extra words the filter matches: what he might type looking for it. */
  terms: string;
}

export const CONTROLS: readonly Control[] = [
  { id: "handoff-default", group: "handoff", label: "Hand off at", terms: "percent mark threshold default every chat context window wrap up compact" },
  { id: "handoff-cap", group: "handoff", label: "or at k tokens", terms: "token cap limit 300k thousand whichever first" },
  { id: "handoff-chat", group: "handoff", label: "This chat's mark", terms: "this chat own mark percent open chat use the default" },
  { id: "handoff-away", group: "handoff", label: "When you are away", terms: "away queue wrap-up automatic present notice minute" },
  { id: "handoff-message", group: "handoff", label: "The wrap-up message", terms: "wrap-up message handoff.md prompt start reset default text" },
  { id: "handoff-readorder", group: "handoff", label: "The read order", terms: "read order new chat continue prompt box reset default" },
  { id: "models-list", group: "models", label: "Model list", terms: "models picker order alias id fable opus sonnet haiku move up down remove reset built-in" },
  { id: "models-add", group: "models", label: "Add a model", terms: "add new model id alias" },
  { id: "models-away", group: "models", label: "Away server's default", terms: "away server phone model default --model" },
  { id: "subagents-default", group: "subagents", label: "Default subagent rules", terms: "subagents agents rules words limits default" },
  { id: "updates-cli", group: "updates", label: "Claude Code version", terms: "claude code cli version check now update installed newest release" },
  { id: "updates-binary", group: "updates", label: "Claude Code binary", terms: "binary path cli claude executable program location which" },
  { id: "updates-auto", group: "updates", label: "Keep Claude Code up to date", terms: "auto update automatic cold moment claude update" },
  { id: "updates-layers", group: "updates", label: "Changed memory or instructions files", terms: "memory instructions claude.md layer file cold running chats" },
  { id: "cache-keepwarm", group: "cache", label: "Keep chats' caches warm automatically", terms: "keep warm cache ping 1-hour hour 6 h six automatic default every chat cold" },
];

/** The filter's words, lower-cased; empty when the box is blank. */
export function filterWords(filter: string): string[] {
  return filter.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every word appears in the control's label, terms or group title. */
export function controlMatches(c: Control, filter: string): boolean {
  const words = filterWords(filter);
  if (words.length === 0) return true;
  const group = GROUPS.find((g) => g.id === c.group)?.title ?? "";
  const hay = `${c.label} ${c.terms} ${group}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The controls of a group that the filter keeps. */
export function matchingControls(group: GroupId, filter: string): Control[] {
  return CONTROLS.filter((c) => c.group === group && controlMatches(c, filter));
}

/** How many controls the filter keeps, over the whole pane. */
export function matchCount(filter: string): number {
  return CONTROLS.filter((c) => controlMatches(c, filter)).length;
}

// --- the one-line summaries on each folded header ---

export function handoffSummary(o: {
  pct: number;
  capK: number;
  chatPct: number | null;
  chatOwn: boolean;
  messageEdited: boolean;
  readOrderEdited: boolean;
}): string {
  const parts = [o.capK > 0 ? `${o.pct}% or ${o.capK}k` : `${o.pct}%, no cap`];
  if (o.chatPct !== null && o.chatOwn) parts.push(`this chat ${o.chatPct}%`);
  const edited = [o.messageEdited && "message", o.readOrderEdited && "read order"].filter(Boolean);
  if (edited.length) parts.push(`${edited.join(" and ")} edited`);
  return parts.join(" · ");
}

export function modelsSummary(models: readonly string[], awayDefault: string | null): string {
  const list = models.length > 4 ? `${models.slice(0, 4).join(", ")} +${models.length - 4}` : models.join(", ");
  return `${list} · away: ${awayDefault ?? "server's own"}`;
}

export function subagentsSummary(rules: string): string {
  const t = rules.trim().replace(/\s+/g, " ");
  if (!t) return "none set";
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

export function updatesSummary(o: {
  installed: string | null;
  latest: string | null;
  behind: boolean;
  auto: boolean;
  layersAtCold: boolean;
}): string {
  const version = o.installed ? (o.behind && o.latest ? `${o.installed} → ${o.latest}` : o.installed) : "not checked";
  return `${version} · auto-update ${o.auto ? "on" : "off"} · files at cold ${o.layersAtCold ? "on" : "off"}`;
}

/** Item 608: the keep-warm group's header. */
export function cacheSummary(on: boolean | null): string {
  if (on === null) return "not read yet";
  return on ? "every chat kept warm, up to the cap" : "off unless a chat's switch is on";
}
