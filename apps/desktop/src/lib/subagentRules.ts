// His subagent rules in words (nightshift backlog 291, 2026-10-03): "if I
// could just tell the model in words what my rules are on sub-agents, the
// same way I do to you". Each chat may have its own text, written in the
// rail's *Subagent rules* box; a chat with none reads the default from
// Settings. The text reaches the model in the chat's subagent rules layer
// (backlog 293, Rust `prompt::subagent_rules_segment`), beside the limits
// Nightloom enforces whatever the words say.
//
// Kept in localStorage beside the per-chat model choice (`chatChoice.ts`),
// saved on every keystroke — no way out of the box loses what he typed
// (practices §7). A New chat's text waits under `newChat` until the turn
// that makes the chat, then becomes that chat's own.

import type { SubagentLimits } from "./catalog";

export const SUBAGENT_RULES_KEY = "nightloom.subagent-rules";

export interface SubagentRulesStore {
  /** What a chat with no text of its own reads (Settings). */
  default: string;
  /** Each chat's own text, by chat id. */
  chats: Record<string, string>;
  /** What he typed in a New chat's box, before the chat exists. */
  newChat: string | null;
}

export function emptyRules(): SubagentRulesStore {
  return { default: "", chats: {}, newChat: null };
}

/** A stored value, strictly: anything not a string is dropped. */
export function readRules(v: unknown): SubagentRulesStore {
  const out = emptyRules();
  if (!v || typeof v !== "object") return out;
  const o = v as Record<string, unknown>;
  if (typeof o.default === "string") out.default = o.default;
  if (typeof o.newChat === "string") out.newChat = o.newChat;
  if (o.chats && typeof o.chats === "object") {
    for (const [id, t] of Object.entries(o.chats as Record<string, unknown>)) {
      if (typeof t === "string") out.chats[id] = t;
    }
  }
  return out;
}

export function loadRules(storage: Pick<Storage, "getItem">): SubagentRulesStore {
  try {
    const raw = storage.getItem(SUBAGENT_RULES_KEY);
    return raw ? readRules(JSON.parse(raw)) : emptyRules();
  } catch {
    // a torn value reads as nothing written
    return emptyRules();
  }
}

export function saveRules(storage: Pick<Storage, "setItem">, store: SubagentRulesStore): void {
  try {
    storage.setItem(SUBAGENT_RULES_KEY, JSON.stringify(store));
  } catch {
    // best-effort; the text stays in app state for this run
  }
}

/** Whether `chat` (null = New chat) has text of its own. */
export function hasOwnRules(store: SubagentRulesStore, chat: string | null): boolean {
  return chat === null ? store.newChat !== null : chat in store.chats;
}

/** The text `chat` (null = New chat) sends: its own, else the default. */
export function rulesFor(store: SubagentRulesStore, chat: string | null): string {
  const own = chat === null ? store.newChat : store.chats[chat];
  return own ?? store.default;
}

/** He typed in the rail's box for `chat`. */
export function setRulesFor(store: SubagentRulesStore, chat: string | null, text: string): void {
  if (chat === null) store.newChat = text;
  else store.chats[chat] = text;
}

/** *Use the default*: the chat drops its own text and reads Settings'.
 *  The rail asks first when there is text to drop. */
export function useDefaultFor(store: SubagentRulesStore, chat: string | null): void {
  if (chat === null) store.newChat = null;
  else delete store.chats[chat];
}

/** A New chat's first turn made `chat`: what he typed in its box becomes
 *  that chat's own text. True when anything changed. */
export function adoptNewChat(store: SubagentRulesStore, chat: string): boolean {
  if (store.newChat === null) return false;
  if (!(chat in store.chats)) store.chats[chat] = store.newChat;
  store.newChat = null;
  return true;
}

/** The folded grid's one line (backlog 291): the limits in force, in
 *  words, so the fold says what it hides. */
export function limitsSummary(l: SubagentLimits): string {
  const parts: string[] = [];
  parts.push(l.off.per_turn ? "no cap a message" : `${l.per_turn} a message`);
  parts.push(l.off.concurrent ? "any number at once" : `${l.concurrent} at once`);
  parts.push(l.off.depth ? "any depth" : `depth ${l.depth}`);
  if (!l.off.per_day && l.per_day > 0) parts.push(`${l.per_day} a day`);
  if (!l.off.slow) parts.push(`${l.slow_to} from ${l.slow_at}%`);
  parts.push(l.off.stop_at ? "no stop line" : `stop at ${l.stop_at}%`);
  parts.push(l.off.budget_pct || l.budget_pct === 0 ? "no message budget" : `${l.budget_pct}% a message`);
  return parts.join(" · ");
}
