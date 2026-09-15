import type { SessionEvent, SessionMeta } from "./types";
import { liveFlags } from "./state.svelte";
import { remainingText, type CacheState } from "./cache";

/**
 * Editing past turns (nightshift backlog 062, 2026-09-15): the projections
 * the transcript draws from, the sidebar's lineage line, and the small
 * state machine behind the in-place editor. Pure, so the suite can pin
 * every one of them without a DOM.
 *
 * Three projections here mirror three in the core, and have to stay in
 * step with them the way `liveFlags` mirrors `Session::live_flags`:
 * `editTexts` ↔ `Session::edit_texts`, `elideFlags` ↔ `Session::elide_flags`,
 * `isEditable` ↔ `Session::is_editable`. The transcript is drawn from
 * these; the model's request is drawn from the core's; if they disagreed
 * the user would be reading a conversation the model is not having.
 */

/**
 * What each event says now: the text of the latest *live* `edit` marker
 * aimed at it, or null where it says what it always said. Live, so a
 * rewind past an edit puts the original back for free.
 */
export function editTexts(events: SessionEvent[]): (string | null)[] {
  const live = liveFlags(events);
  const texts: (string | null)[] = events.map(() => null);
  events.forEach((e, i) => {
    if (!live[i] || e.event !== "edit") return;
    if (e.target < texts.length) texts[e.target] = e.text;
  });
  return texts;
}

/**
 * Which events are removed from the context: `elide` and `unelide`
 * markers applied in log order, live ones only, the last word on an
 * index winning.
 */
export function elideFlags(events: SessionEvent[]): boolean[] {
  const live = liveFlags(events);
  const flags = events.map(() => false);
  events.forEach((e, i) => {
    if (!live[i]) return;
    if (e.event !== "elide" && e.event !== "unelide") return;
    for (const t of e.targets) if (t < flags.length) flags[t] = e.event === "elide";
  });
  return flags;
}

/**
 * Whether the turn at `index` can be reworded: a user message, or an
 * assistant reply that calls no tool. A reply with a call is remove-only
 * — the call was made because of the text beside it.
 */
export function isEditable(events: SessionEvent[], index: number): boolean {
  const e = events[index];
  if (!e) return false;
  if (e.event === "user_message") return true;
  if (e.event === "assistant_message") return !e.blocks.some((b) => b.type === "tool_use");
  return false;
}

/**
 * The one line above the editor's buttons, from the prompt-cache timer
 * (backlog 063): warm means everything after this turn is re-written on
 * the next request and the cached prefix up to it survives; cold means
 * the next request pays full price whatever is done, so edit freely.
 */
export function editLine(cache: CacheState | null): string {
  const left = cache ? remainingText(cache.remainingMs) : null;
  return left
    ? `cache warm · ${left} — this re-writes the history after this turn`
    : "cache cold — edit freely";
}

/** What a removed turn shows in place of its text, greyed. */
export const REMOVED_PLACEHOLDER = "removed from the context — still in the log";

/**
 * The sidebar's lineage line for a fork: "from <parent's name>", the
 * parent named the way its own row is (title, else opening message), or
 * "from a deleted chat" when the parent is no longer listed. Null for a
 * chat that is not a fork.
 */
export function forkLine(meta: SessionMeta, sessions: SessionMeta[], max = 40): string | null {
  const from = meta.forked_from;
  if (!from) return null;
  const parent = sessions.find((s) => s.id === from.session);
  if (!parent) return "from a deleted chat";
  const name = (parent.title ?? parent.first_user ?? "").replace(/\s+/g, " ").trim();
  if (!name) return `from ${from.session.slice(0, 8)}`;
  return `from ${name.length > max ? name.slice(0, max - 1) + "…" : name}`;
}

/**
 * The in-place editor's state: which turn is open and what it says so
 * far, or null when nothing is being edited. One at a time — opening a
 * second turn closes the first, since two open editors would leave the
 * question of which Save means what.
 */
export type EditState = { index: number; original: string; draft: string } | null;

export type EditAction =
  | { type: "begin"; index: number; text: string }
  | { type: "draft"; text: string }
  | { type: "cancel" }
  /** Save or Send landed: the editor closes. */
  | { type: "done" }
  /** A turn started streaming: the editor closes rather than hang over a
   *  transcript that is changing under it. */
  | { type: "busy" };

export function editReduce(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "begin":
      return { index: action.index, original: action.text, draft: action.text };
    case "draft":
      return state ? { ...state, draft: action.text } : null;
    case "cancel":
    case "done":
    case "busy":
      return null;
  }
}

/**
 * Which of the editor's buttons are live. Save needs a change and some
 * text — saving the same text would record a marker that changes
 * nothing, and blank text is what Remove is for. Send needs only text:
 * sending the same words again into a fork is a real thing to want.
 */
export function editButtons(state: EditState): { save: boolean; send: boolean } {
  if (!state) return { save: false, send: false };
  const draft = state.draft.trim();
  return {
    save: draft.length > 0 && draft !== state.original.trim(),
    send: draft.length > 0,
  };
}
