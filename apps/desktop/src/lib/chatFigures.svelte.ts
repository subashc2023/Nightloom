/**
 * The open Claude Code chat's own totals, read once and shown everywhere
 * (nightshift item 675, 2026-11-12). The right column's "This chat" read
 * them by itself (item 569) while the top bar's "Spent" summed the log's
 * per-reply `cost` — which a Claude Code reply never carries, so the bar
 * said "at least $0.00" beside the column's real figure. Both now read
 * this store: Claude Code's own running cost for the chat, over every CLI
 * session it has run on, so a rewind never lowers it
 * (`session_figures::read_chain`).
 */
import * as api from "./api";
import { app, chatAgentSession, chatAgentSessions, sessionCost } from "./state.svelte";
import type { SessionFigures } from "./usageFigures";

export const chatFigures = $state<{ of: string | null; figures: SessionFigures | null }>({ of: null, figures: null });

let wanted: string | null = null;
let flying: string | null = null;

/**
 * Read the figures of the chat whose live CLI session is `id`; `all` is
 * every session it has run on, oldest first (`chatAgentSessions`). Called
 * from each surface's effect when a turn ends; one read at a time per
 * chain, and only the chat asked for last lands.
 */
export function loadChatFigures(id: string, all: readonly string[]): void {
  const earlier = all.filter((x) => x !== id);
  const key = [...earlier, id].join(",");
  wanted = id;
  if (flying === key) return;
  flying = key;
  api
    .sessionFigures(id, earlier)
    .then((f) => {
      if (wanted !== id) return;
      chatFigures.of = id;
      chatFigures.figures = f;
    })
    .catch(() => {})
    .finally(() => {
      if (flying === key) flying = null;
    });
}

/** The figures of session `id`, when they are the ones held and found. */
export function figuresOf(id: string | null): SessionFigures | null {
  return id && chatFigures.of === id && chatFigures.figures?.found ? chatFigures.figures : null;
}

/**
 * The top bar's "Spent" for a Claude Code chat (pure; the suite pins it):
 * the CLI's running cost for the chat — rewound replies included — plus
 * whatever the log itself priced (replies the same chat ran on the API
 * engine). `complete` is false only when the CLI could not price a model.
 * Null before the chat's first turn has ended: nothing is known, and
 * "$0.00" would say it was free.
 */
export function agentChatSpend(
  figures: Pick<SessionFigures, "cost_usd" | "unknown_cost"> | null,
  logged: { usd: number; complete: boolean } | null,
): { usd: number; complete: boolean } | null {
  const fromLog = logged?.usd ?? 0;
  if (!figures || figures.cost_usd == null) return fromLog > 0 ? { usd: fromLog, complete: false } : null;
  return { usd: figures.cost_usd + fromLog, complete: !figures.unknown_cost };
}

/**
 * Keep the open Claude Code chat's figures read — called inside an
 * `$effect` by each surface that shows them (both top bars, the right
 * column). A turn's end writes the newest totals, so it reads again when
 * one ends; nothing while a turn runs, and nothing for an API-engine chat.
 */
export function trackOpenChatFigures(): void {
  if (app.connection?.engine !== "claude-code" || app.busy) return;
  const id = chatAgentSession(app.events);
  if (!id) return;
  loadChatFigures(id, chatAgentSessions(app.events));
}

/** The open chat's figures, when it is a Claude Code chat and they are in. */
export function openChatFigures(): SessionFigures | null {
  if (app.connection?.engine !== "claude-code") return null;
  return figuresOf(chatAgentSession(app.events));
}

/**
 * The open chat's "Spent" for the top bar: the log's own sum on the API
 * engine (`sessionCost`), Claude Code's running cost on its engine
 * (`agentChatSpend`). `agent` says which, for the hover's words.
 */
export function openChatSpend(): { usd: number; complete: boolean; agent: boolean } | null {
  const logged = sessionCost();
  if (app.connection?.engine !== "claude-code") return logged ? { ...logged, agent: false } : null;
  const c = agentChatSpend(openChatFigures(), logged);
  return c ? { ...c, agent: true } : null;
}
