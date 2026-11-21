// Each chat's model and engine (nightshift backlog 205, 2026-09-25).
//
// Until this item the rail's draft was one object for the window: picking
// Haiku in a test chat put his Stuart 9 on Haiku too, and choosing the
// Provider engine in chat B turned chat A to it (the app walk of
// 2026-09-25, part 2). Since 159 A2 two chats run turns at once, so a
// shared pick could send one chat's turn on the other's model.
//
// What is per chat is the four fields that say *which model answers*:
// the engine, the provider and its model, and the Claude Code model. The
// rest of the draft (effort, approval, tools, …) stays the window's, as it
// was. A chat's choice is recorded when a connect for it succeeds — the
// one place every picker ends up — and put back on the draft when the chat
// is opened again. A New chat takes the default: the most recent pick made
// by hand anywhere (blocker 400 holds that choice). Kept in localStorage,
// beside `nightloom.last-connection` where the draft itself already lives.

import type { ConnectionDraft, Engine } from "./catalog";
import { HOME_EFFORT, HOME_MODEL } from "./home";

export const CHAT_CHOICE_KEY = "nightloom.chat-choice";

/** Which model answers in a chat. */
export interface ChatChoice {
  engine: Engine;
  provider: string;
  model: string;
  agentModel: string;
}

/** Every chat's choice, and the one a New chat starts on. */
export interface ChatChoices {
  /** What a New chat takes (and a chat recorded before this item). */
  default: ChatChoice | null;
  chats: Record<string, ChatChoice>;
  /** Item 763 (blocker 2041): Home's effort, apart from the window's —
   *  `low` until he picks another while in Home. */
  homeEffort?: string;
  /** The window's effort, kept while a Home chat is shown and put back
   *  when he leaves; null when nothing is held. */
  windowEffort?: string | null;
}

export function choiceOf(d: ConnectionDraft): ChatChoice {
  return { engine: d.engine, provider: d.provider, model: d.model, agentModel: d.agentModel };
}

export function sameChoice(a: ChatChoice, b: ChatChoice): boolean {
  return a.engine === b.engine && a.provider === b.provider && a.model === b.model && a.agentModel === b.agentModel;
}

/** A stored choice, strictly: anything malformed reads as none. */
export function readChoice(v: unknown): ChatChoice | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.engine !== "provider" && o.engine !== "claude-code") return null;
  if (typeof o.provider !== "string" || typeof o.model !== "string" || typeof o.agentModel !== "string") return null;
  return { engine: o.engine, provider: o.provider, model: o.model, agentModel: o.agentModel };
}

export function loadChoices(storage: Pick<Storage, "getItem">): ChatChoices {
  const out: ChatChoices = { default: null, chats: {} };
  try {
    const raw = storage.getItem(CHAT_CHOICE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as { default?: unknown; chats?: unknown };
    out.default = readChoice(parsed.default);
    if (parsed.chats && typeof parsed.chats === "object") {
      for (const [id, c] of Object.entries(parsed.chats as Record<string, unknown>)) {
        const choice = readChoice(c);
        if (choice) out.chats[id] = choice;
      }
    }
    const raw2 = parsed as { homeEffort?: unknown; windowEffort?: unknown };
    if (typeof raw2.homeEffort === "string") out.homeEffort = raw2.homeEffort;
    if (typeof raw2.windowEffort === "string") out.windowEffort = raw2.windowEffort;
  } catch {
    // a torn value reads as nothing recorded
  }
  return out;
}

export function saveChoices(storage: Pick<Storage, "setItem">, choices: ChatChoices): void {
  try {
    storage.setItem(CHAT_CHOICE_KEY, JSON.stringify(choices));
  } catch {
    // best-effort
  }
}

/**
 * The choice `chat` (null = New chat) should be on: its own, else the
 * default, else null — nothing recorded, the draft stands.
 */
export function wantedChoice(choices: ChatChoices, chat: string | null): ChatChoice | null {
  return (chat !== null ? choices.chats[chat] : undefined) ?? choices.default;
}

/**
 * A connect for `chat` succeeded with `c`: it is the chat's now. The
 * default moves only on a pick — a New chat's, or one that changed what a
 * chat was on — never when a chat was merely reopened on its own choice.
 */
export function noteConnected(choices: ChatChoices, chat: string | null, c: ChatChoice): void {
  const before = chat === null ? undefined : choices.chats[chat];
  if (chat !== null) choices.chats[chat] = { ...c };
  if (chat === null || !before || !sameChoice(before, c)) choices.default = { ...c };
}

/** A chat a turn just made: the choice its first turn ran on, unless one
 *  is recorded already. */
export function noteMade(choices: ChatChoices, chat: string, c: ChatChoice): void {
  if (!choices.chats[chat]) choices.chats[chat] = { ...c };
}

/** Put `c` on the draft; true when anything changed. */
export function applyChoice(d: ConnectionDraft, c: ChatChoice): boolean {
  if (sameChoice(choiceOf(d), c)) return false;
  d.engine = c.engine;
  d.provider = c.provider;
  d.model = c.model;
  d.agentModel = c.agentModel;
  return true;
}

// ---- Home's model and effort (item 763 finish, blocker 2041) ----

/** A Home chat with no choice of its own: Claude Code on Opus 5.5, the
 *  rest of `base` kept. Once recorded it is the chat's like any. */
export function homeChoice(base: ChatChoice): ChatChoice {
  return { ...base, engine: "claude-code", agentModel: HOME_MODEL };
}

/**
 * Put Home's effort on the draft while a Home chat is shown (`inHome`),
 * holding the window's to put back when he leaves; true when the draft's
 * effort changed. Effort is otherwise the window's (backlog 205), so only
 * Home carries its own.
 */
export function applyHomeEffort(choices: ChatChoices, d: ConnectionDraft, inHome: boolean): boolean {
  if (inHome) {
    if (choices.windowEffort == null) choices.windowEffort = d.agentEffort;
    const want = choices.homeEffort ?? HOME_EFFORT;
    if (d.agentEffort === want) return false;
    d.agentEffort = want;
    return true;
  }
  if (choices.windowEffort == null) return false;
  const back = choices.windowEffort;
  choices.windowEffort = null;
  if (d.agentEffort === back) return false;
  d.agentEffort = back;
  return true;
}
