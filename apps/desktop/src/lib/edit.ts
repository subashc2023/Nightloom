import type {
  Attachment,
  ContentBlock,
  DocumentInput,
  EditedAttachments,
  ImageInput,
  SessionEvent,
  SessionMeta,
} from "./types";
import { liveFlags } from "./state.svelte";
import { remainingText, type CacheState } from "./cache";
import { isImeKey } from "./imeKey";

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
 * What each user message says now: the text of the latest *live* `edit`
 * marker aimed at it, or null where it says what it always said. Live, so
 * a rewind past an edit puts the original back for free. A reply's edits
 * are per block (`blockEdits`, backlog 066); this reads null for every
 * reply, as `Session::edit_texts` does.
 */
export function editTexts(events: SessionEvent[]): (string | null)[] {
  const live = liveFlags(events);
  const texts: (string | null)[] = events.map(() => null);
  events.forEach((e, i) => {
    if (!live[i] || e.event !== "edit") return;
    if (events[e.target]?.event === "user_message") texts[e.target] = e.text;
  });
  return texts;
}

/**
 * What each user message carries now (item 336): the set of the latest
 * live `edit` marker aimed at it that named one, or null where it carries
 * its own — `Session::edit_attachments`. A text-only edit after it leaves
 * the set standing.
 */
export function editAttachments(events: SessionEvent[]): (EditedAttachments | null)[] {
  const live = liveFlags(events);
  const sets: (EditedAttachments | null)[] = events.map(() => null);
  events.forEach((e, i) => {
    if (!live[i] || e.event !== "edit" || !e.attachments) return;
    if (events[e.target]?.event === "user_message") sets[e.target] = e.attachments;
  });
  return sets;
}

/**
 * What each reply's text blocks say now (nightshift backlog 066): per
 * event, the index of each edited block into its `blocks` and the text of
 * the latest live edit aimed at it — `Session::block_edits`. A marker
 * written without a block (062's shape) is the reply's first text block,
 * or one past the last for a reply that had none.
 */
export function blockEdits(events: SessionEvent[]): Map<number, string>[] {
  const live = liveFlags(events);
  const edits = events.map(() => new Map<number, string>());
  events.forEach((e, i) => {
    if (!live[i] || e.event !== "edit") return;
    const target = events[e.target];
    if (target?.event !== "assistant_message") return;
    let block = e.block;
    if (block == null) {
      const first = target.blocks.findIndex((b) => b.type === "text");
      block = first >= 0 ? first : target.blocks.length;
    }
    edits[e.target].set(block, e.text);
  });
  return edits;
}

/**
 * Which events are removed from the context: `elide` and `unelide`
 * markers applied in log order, live ones only, the last word on an
 * index winning. A marker with a `block` names one block, not the event
 * (`blockElisions`), and leaves the event's flag alone.
 */
export function elideFlags(events: SessionEvent[]): boolean[] {
  const live = liveFlags(events);
  const flags = events.map(() => false);
  events.forEach((e, i) => {
    if (!live[i]) return;
    if (e.event !== "elide" && e.event !== "unelide") return;
    if (e.block != null) return;
    for (const t of e.targets) if (t < flags.length) flags[t] = e.event === "elide";
  });
  return flags;
}

/**
 * Which blocks of each reply are removed on their own (backlog 066):
 * `Session::block_elisions`. A removed `tool_use` takes the result that
 * answers it with it; the result's own event is never named.
 */
export function blockElisions(events: SessionEvent[]): Set<number>[] {
  const live = liveFlags(events);
  const gone = events.map(() => new Set<number>());
  events.forEach((e, i) => {
    if (!live[i]) return;
    if (e.event !== "elide" && e.event !== "unelide") return;
    if (e.block == null) return;
    const set = gone[e.targets[0]];
    if (!set) return;
    if (e.event === "elide") set.add(e.block);
    else set.delete(e.block);
  });
  return gone;
}

/**
 * The text of the reply at `index` as it reads now — its text blocks in
 * order with their edits, the removed ones left out — or null for a reply
 * nothing has touched (and for anything that is not a reply). What the
 * navigator's bubble and an undo of a block edit read; `Session::reply_text`.
 */
export function replyText(
  events: SessionEvent[],
  index: number,
  // Item 482: a caller asking for every turn passes both projections in;
  // read per call they made `displayTexts` quadratic (44 ms per call at
  // 300 turns, several calls a tab switch).
  allEdits: Map<number, string>[] = blockEdits(events),
  allGone: Set<number>[] = blockElisions(events),
): string | null {
  const e = events[index];
  if (e?.event !== "assistant_message") return null;
  const edits = allEdits[index];
  const gone = allGone[index];
  if (edits.size === 0 && gone.size === 0) return null;
  let out = "";
  e.blocks.forEach((b, n) => {
    if (gone.has(n) || b.type !== "text") return;
    out += edits.get(n) ?? b.text;
  });
  out += edits.get(e.blocks.length) ?? "";
  return out;
}

/**
 * What each turn says now, for a reader that wants one string per turn
 * (the navigator): a user message's edit, a touched reply's `replyText`,
 * null where the original stands.
 */
export function displayTexts(events: SessionEvent[]): (string | null)[] {
  const texts = editTexts(events);
  const edits = blockEdits(events);
  const gone = blockElisions(events);
  return texts.map((t, i) => t ?? replyText(events, i, edits, gone));
}

/**
 * Whether the turn at `index` can be reworded: a user message, or an
 * assistant reply with a text block in it. ~~A reply with a call is
 * remove-only~~ — since backlog 066 a reply is edited one text block at a
 * time with its calls held in place, so a call is no bar (`Session::is_editable`).
 */
export function isEditable(events: SessionEvent[], index: number): boolean {
  const e = events[index];
  if (!e) return false;
  if (e.event === "user_message") return true;
  if (e.event === "assistant_message") return e.blocks.some((b) => b.type === "text");
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
/** What a removed tool call shows in its place (backlog 066). */
export const REMOVED_TOOL_PLACEHOLDER = "[tool call removed]";
/** What a removed text block of a reply shows in its place. */
export const REMOVED_TEXT_PLACEHOLDER = "[text removed]";

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
 * One part of a reply in the editor (backlog 066): a text block as a
 * textarea, or a tool call as a fixed marker between them. `block` is the
 * index into the reply's `blocks`; a removed text block is a marker too,
 * since it is restored rather than typed into.
 */
export type EditPart =
  | { kind: "text"; block: number; original: string; draft: string }
  | { kind: "marker"; block: number; label: string };

/**
 * The reply at `index` as the editor shows it: its text blocks in order,
 * each saying its latest edit, with every tool call between them as a
 * marker labelled by `label` (thinking is not shown — it is not the
 * user's to edit, and the API leaves it out of later turns anyway). A
 * removed block is a marker with the placeholder.
 */
export function editParts(
  events: SessionEvent[],
  index: number,
  label: (b: Extract<ContentBlock, { type: "tool_use" }>) => string,
): EditPart[] {
  const e = events[index];
  if (e?.event !== "assistant_message") return [];
  const edits = blockEdits(events)[index];
  const gone = blockElisions(events)[index];
  const parts: EditPart[] = [];
  e.blocks.forEach((b, block) => {
    if (b.type === "text") {
      if (gone.has(block)) parts.push({ kind: "marker", block, label: REMOVED_TEXT_PLACEHOLDER });
      else {
        const text = edits.get(block) ?? b.text;
        parts.push({ kind: "text", block, original: text, draft: text });
      }
    } else if (b.type === "tool_use") {
      parts.push({
        kind: "marker",
        block,
        label: gone.has(block) ? REMOVED_TOOL_PLACEHOLDER : `⚙ ${label(b)}`,
      });
    }
  });
  return parts;
}

/**
 * The in-place editor's state: which turn is open and what it says so
 * far, or null when nothing is being edited. One at a time — opening a
 * second turn closes the first, since two open editors would leave the
 * question of which Save means what. A user turn is `original` / `draft`;
 * a reply is `parts` (backlog 066), one draft per text block, with the
 * two strings holding the joined text for whoever wants it as one.
 */
export type EditState = {
  index: number;
  original: string;
  draft: string;
  parts?: EditPart[];
  /** A user turn's attachments as the editor opened on them (item 336),
   *  one `chipPrint` each, in order: what "changed" is measured against.
   *  The chips themselves live in the drafts store under the chat's
   *  `editDraftKey`, where the composer's attach code puts them. */
  chipsAt?: string[];
} | null;

export type EditAction =
  | { type: "begin"; index: number; text: string; parts?: EditPart[]; chipsAt?: string[] }
  /** A draft for the one text (a user turn), or for text block `block`
   *  of a reply. */
  | { type: "draft"; text: string; block?: number }
  | { type: "cancel" }
  /** Save or Send landed: the editor closes. */
  | { type: "done" }
  /** A turn started streaming: the editor closes rather than hang over a
   *  transcript that is changing under it. */
  | { type: "busy" };

export function editReduce(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case "begin":
      if (action.parts)
        return { index: action.index, original: action.text, draft: action.text, parts: action.parts };
      return action.chipsAt
        ? { index: action.index, original: action.text, draft: action.text, chipsAt: action.chipsAt }
        : { index: action.index, original: action.text, draft: action.text };
    case "draft":
      if (!state) return null;
      if (action.block == null || !state.parts) return { ...state, draft: action.text };
      return {
        ...state,
        parts: state.parts.map((p) =>
          p.kind === "text" && p.block === action.block ? { ...p, draft: action.text } : p,
        ),
      };
    case "cancel":
    case "done":
    case "busy":
      return null;
  }
}

/**
 * What a Save of a reply does, block by block (backlog 066): a text block
 * whose draft changed is reworded; one whose draft is blank is removed —
 * "keep the start of it but don't need the rest" is deleting the rest —
 * so `text` is "" for those. Blocks that did not change are not listed.
 */
export function editChanges(state: EditState): { block: number; text: string }[] {
  if (!state?.parts) return [];
  const out: { block: number; text: string }[] = [];
  for (const p of state.parts) {
    if (p.kind !== "text") continue;
    const draft = p.draft.trim();
    if (draft === p.original.trim()) continue;
    out.push({ block: p.block, text: draft.length === 0 ? "" : p.draft });
  }
  return out;
}

/**
 * Which of the editor's buttons are live. Save needs a change and some
 * text — saving the same text would record a marker that changes
 * nothing, and blank text is what Remove is for. Send needs only text:
 * sending the same words again into a fork is a real thing to want.
 *
 * For a reply (`parts`): Save needs a changed block, and something left —
 * a text block with words in it or a tool call still standing — since a
 * reply emptied whole is what Remove is for; there is no Send, a fork
 * cutting only at a user turn.
 */
export function editButtons(state: EditState, chips?: ChipLike[]): { save: boolean; send: boolean } {
  if (!state) return { save: false, send: false };
  if (state.parts) {
    const changed = editChanges(state).length > 0;
    const left = state.parts.some(
      (p) =>
        (p.kind === "text" && p.draft.trim().length > 0) ||
        (p.kind === "marker" && p.label.startsWith("⚙")),
    );
    return { save: changed && left, send: false };
  }
  // Item 336: a user turn's attachments count as content and as a change —
  // an image-only message can be sent or saved, and adding or removing a
  // chip is an edit even with the words untouched. `chips` absent: the
  // editor before 336, words only.
  const draft = state.draft.trim();
  const content = draft.length > 0 || (chips?.length ?? 0) > 0;
  const changed = draft !== state.original.trim() || (chips != null && chipsChanged(state, chips));
  // Save still needs words: the log refuses a blank edit (blank is what
  // Remove is for); Send can go with chips alone, as the composer's can.
  return { save: draft.length > 0 && changed, send: content };
}

/** The part of an attachment `chipPrint` reads. */
export type ChipLike = Pick<Attachment, "kind" | "media_type" | "name" | "data"> & { pending?: boolean };

/**
 * One attachment as a short fingerprint (item 336): its kind, type, name,
 * size and the two ends of its data — enough to tell a removed or added
 * chip from the ones the message had, without holding a second copy of
 * every image in the editor's state. A chip still converting prints as
 * pending: it is a change, since the message never had it.
 */
export function chipPrint(a: ChipLike): string {
  if (a.pending) return `${a.kind}|pending|${a.name}`;
  return `${a.kind}|${a.media_type}|${a.name}|${a.data.length}|${a.data.slice(0, 48)}|${a.data.slice(-48)}`;
}

/** Whether the editor's chips differ from the turn's own (item 336). */
export function chipsChanged(state: EditState, chips: ChipLike[]): boolean {
  const at = state?.chipsAt ?? [];
  if (at.length !== chips.length) return true;
  return chips.some((c, i) => chipPrint(c) !== at[i]);
}

/**
 * Whether closing the editor would lose something typed (practices §7,
 * item 336): a user turn's words or chips changed, or a reply's block
 * drafts. Cancel and Escape ask before dropping such an edit.
 */
export function editDirty(state: EditState, chips?: ChipLike[]): boolean {
  if (!state) return false;
  if (state.parts) return editChanges(state).length > 0;
  return state.draft !== state.original || (chips != null && chipsChanged(state, chips));
}

/**
 * A user turn's attachments as the editor's chips (item 336), so the box
 * opens showing them — his report: the image vanished from the edit box,
 * so he could neither see nor remove it. Images first, then documents,
 * the order the log keeps and the request builds. An image has no name in
 * the log; it is "image N". A text document is labelled "text", as the
 * composer labels one.
 */
export function chipsOf(
  images: ImageInput[],
  documents: DocumentInput[],
  nextId: () => number,
): Attachment[] {
  const out: Attachment[] = [];
  images.forEach((img, i) =>
    out.push({
      id: nextId(),
      kind: "image",
      media_type: img.media_type,
      name: images.length === 1 ? "image" : `image ${i + 1}`,
      data: img.data,
    }),
  );
  for (const d of documents) {
    const chip: Attachment = { id: nextId(), kind: "document", media_type: d.media_type, name: d.name, data: d.data };
    if (d.media_type.startsWith("text/")) chip.label = "text";
    out.push(chip);
  }
  return out;
}

/**
 * What a key in the editor does (item 337, his "clicking enter should
 * still send it. if i wanted to jus save i'd click save"). In a user
 * turn's editor Enter sends into a fork, as the composer's Enter sends;
 * Shift+Enter is a newline; ⌘/Ctrl+Enter (with or without Shift) sends
 * too, the old send chord kept working; Save has no key — only its
 * button. An Enter the input method holds (item 322, `isImeKey`) only
 * commits the composition. A reply's editor has no Send (a fork cuts
 * only at a user turn), so there Enter stays a newline and ⌘/Ctrl+Enter
 * saves, as before. Escape cancels in both.
 */
export type EditorKey = "send" | "save" | "cancel" | null;

export interface EditorKeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function editorKey(e: EditorKeyLike, reply: boolean): EditorKey {
  if (isImeKey(e)) return null;
  if (e.key === "Escape") return "cancel";
  if (e.key !== "Enter") return null;
  const chord = !!(e.metaKey || e.ctrlKey);
  if (reply) return chord ? "save" : null;
  if (chord) return "send";
  if (e.shiftKey || e.altKey) return null;
  return "send";
}
