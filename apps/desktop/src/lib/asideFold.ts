/**
 * Fold an aside into the chat's research thread (nightshift backlog 282,
 * 2026-10-02 — his "i need that functionality pretty soon", after going
 * deep on an idea in an aside of a thread-bound chat). The pure half: the
 * question the aside is asked, the log entry the app appends, whether the
 * action can run, and the fold's own little state machine. The stateful
 * half is `asideFold.svelte.ts`; the panel is `AsideFold.svelte`.
 *
 * The flow: *Fold into thread* runs **one turn in the aside's own
 * conversation** (it has the aside's exchanges and the chat's context)
 * asking for a summary in the thread's conventions. The text is shown
 * before anything is written — Append, Edit, Cancel — and the **app**
 * appends it to the thread's `log.md` as a dated entry (`append_log` in
 * `thread.rs`), so `thread.md` keeps its one writer, the bound chat,
 * whose next wrap-up folds the entry in (`threadWrapUp`).
 */
import type { ChatMode } from "./types";

/** Where the fold stands on its aside. Kept on the aside (and written
 *  with it by `asides.ts`), so a chat switch, a closed card or a relaunch
 *  keeps the text — edited text above all (practices §7). */
export interface AsideFold {
  /** `pick`: the chat is not bound — the panel offers the thread picker
   *  first. `asking`: the turn runs. `ready`: text to review. `error`:
   *  the turn failed; Try again. */
  stage: "pick" | "asking" | "ready" | "error";
  /** The thread the summary is written for; null while picking. */
  slug: string | null;
  /** The summary: the model's text, or his edit of it. */
  text: string;
  /** He changed the text: Cancel asks before dropping it. */
  edited: boolean;
  /** The text is in the edit box rather than drawn. */
  editing: boolean;
  error?: string | null;
  /** The running turn's sequence number, for its cancel. */
  seq?: number;
  /** The chat, its title and the project the fold began in: the entry
   *  names them, and Append refuses another project's thread. */
  chat: string;
  title: string;
  project: string | null;
}

/** One append of this aside to a thread's log, for the "already folded"
 *  warning. `at` is the entry's stamp, as written. */
export interface FoldRecord {
  at: string;
  slug: string;
}

/** Why the action cannot run, or null when it can. */
export type FoldBlock = "private" | "engine" | "not-open" | "nothing";

export function foldBlocked(o: {
  mode: ChatMode;
  claudeCode: boolean;
  /** The aside's chat is the open one: the turn forks the *open* chat. */
  open: boolean;
  /** Exchanges with an answer. */
  answered: number;
}): FoldBlock | null {
  if (o.mode !== "normal") return "private";
  if (!o.open) return "not-open";
  if (!o.claudeCode) return "engine";
  if (o.answered === 0) return "nothing";
  return null;
}

/** The disabled button's hover, per reason. */
export const FOLD_BLOCK_TEXT: Record<FoldBlock, string> = {
  private: "No fold in an incognito or ephemeral chat — it writes nothing",
  "not-open": "Open the chat to fold this aside — the summary is written from the chat's context",
  engine: "Folding runs a turn in the aside — on the Claude Code engine only",
  nothing: "Ask something first; there is nothing to fold yet",
};

/** "2026-10-02, 5:41 PM" — the entry's date, local time, 12-hour. */
export function foldStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}, ${h12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

/** A name as it goes into the entry's heading and marker: one line, no
 *  quote that would end it, no comment close. */
function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/-->/g, "—>").replace(/'/g, "’").replace(/"/g, "”").trim() || "untitled";
}

/** The pointer the model is told to use for an exchange of this aside. */
export function asidePointer(chatId: string, label: string): string {
  return `${chatId} aside "${clean(label)}" ex <n>`;
}

/**
 * The question the fold's turn asks, inside the aside's own conversation
 * (the caller frames it with the earlier exchanges, `asideFollowUp`). The
 * model writes the entry's body only; the app adds the dated heading.
 */
export function foldPrompt(o: {
  /** The thread the summary goes to; null for an unbound chat's hand-off
   *  (item 285: the wrap-up puts it in the HANDOFF section it writes). */
  slug: string | null;
  chatId: string;
  label: string;
  /** The passage's event in the chat, when the aside is about one. */
  passageEvent: number | null;
}): string {
  const dir = o.slug ? `.agents/threads/${o.slug}` : "";
  const ptr = asidePointer(o.chatId, o.label);
  const lines = [
    (o.slug
      ? `Fold this side conversation into the research thread ${dir}/. Nightloom (not you) will append what you write now to ${dir}/log.md as one dated entry; the chat bound to the thread folds it into thread.md at its next wrap-up.`
      : "Fold this side conversation into the chat's hand-off. Nightloom (not you) will hand what you write now to the chat's wrap-up, which puts it in the HANDOFF section it writes.") +
      " Do not write or edit any file and do not use tools: reply with the summary's body only, in Markdown, under these headings, leaving out a heading with nothing under it:",
    `### His words — the user's words from this side conversation that carry his view, framing or decisions, verbatim, at most about three sentences per quote, each followed by its pointer.`,
    `### Inferred — what you drew from the exchange that he did not say, one line each, tagged \`inferred\`, each with the pointer it rests on.`,
    `### External — claims from outside sources, each written as "source X claims Y" with whether it was verified, and its pointer.`,
    `### New queue rows — a Markdown table | id | Item | Status | Pointer | with ids new-1, new-2, … (the wrap-up gives them the next ids).`,
    `### Open questions — what this side conversation left open, one line each.`,
    `Pointers: \`${ptr}\` is this side conversation's n-th exchange (1 is its first question)` +
      (o.passageEvent !== null ? `; \`${o.chatId} ev ${o.passageEvent}\` is the chat message the side conversation is about` : "") +
      `; \`${o.chatId} ev <n>\` is the chat's own event n. No [brackets], placeholders or text for me to fill in, and no heading of your own above the first section.`,
  ];
  return lines.join("\n");
}

/**
 * The entry the app appends to `log.md`: the fold markers (so the upkeep
 * does not take it for a round, `last_round` in `thread.rs`), the dated
 * heading — "<date, time AM/PM> — aside '<name>' from chat '<title>'" —
 * and the summary as he approved or edited it.
 */
export function foldEntry(o: { at: string; chatId: string; chatTitle: string; label: string; body: string }): string {
  const label = clean(o.label);
  return [
    `<!-- aside fold chat=${o.chatId} aside="${label}" -->`,
    `## ${o.at} — aside '${label}' from chat '${clean(o.chatTitle)}'`,
    "",
    o.body.trim(),
    "<!-- /aside fold -->",
  ].join("\n");
}

/** The warning a second fold carries; null for the first. */
export function foldedWarning(done: readonly FoldRecord[] | undefined): string | null {
  if (!done || done.length === 0) return null;
  const last = done[done.length - 1]!;
  const more = done.length > 1 ? ` (${done.length} times)` : "";
  return `Already folded at ${last.at} into ◇ ${last.slug}${more} — Append adds another entry.`;
}

/** Start: the picker first when the chat is not bound, else the turn. */
export function beginFold(bound: string | null, where: { chat: string; title: string; project: string | null }): AsideFold {
  return { stage: bound ? "asking" : "pick", slug: bound, text: "", edited: false, editing: false, error: null, ...where };
}

/** His edit of the text. */
export function editFold(f: AsideFold, text: string): void {
  f.text = text;
  f.edited = true;
}

/** Cancel: `"drop"` when nothing of his is in it, `"confirm"` when the
 *  text holds his edit — the caller asks, and keeps the text until yes. */
export function cancelVerdict(f: AsideFold): "drop" | "confirm" {
  return f.edited && f.text.trim() ? "confirm" : "drop";
}

/** The fold as the aside store keeps it: a running turn is not kept (a
 *  relaunch cannot resume it; nothing of his was in it). */
export function storedFold(f: AsideFold | undefined): AsideFold | null {
  if (!f || f.stage === "asking") return null;
  const out: AsideFold = {
    stage: f.stage,
    slug: f.slug,
    text: f.text,
    edited: f.edited,
    editing: f.editing,
    chat: f.chat,
    title: f.title,
    project: f.project,
  };
  if (f.error) out.error = f.error;
  return out;
}

/** Read a stored fold back; null when malformed. */
export function loadFold(v: unknown): AsideFold | null {
  if (v === null || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  const stage = f.stage;
  if (stage !== "pick" && stage !== "ready" && stage !== "error") return null;
  if (typeof f.chat !== "string") return null;
  return {
    chat: f.chat,
    title: typeof f.title === "string" ? f.title : "",
    project: typeof f.project === "string" ? f.project : null,
    stage,
    slug: typeof f.slug === "string" ? f.slug : null,
    text: typeof f.text === "string" ? f.text : "",
    edited: f.edited === true,
    editing: f.editing === true,
    error: typeof f.error === "string" ? f.error : null,
  };
}

/** Read stored fold records back, dropping malformed ones. */
export function loadFoldRecords(v: unknown): FoldRecord[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (r): r is FoldRecord =>
      r !== null && typeof r === "object" && typeof (r as FoldRecord).at === "string" && typeof (r as FoldRecord).slug === "string",
  );
}
