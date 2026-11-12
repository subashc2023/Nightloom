/**
 * What a transcript draws (item 674, 2026-11-12): `Transcript.svelte` reads
 * its chat through one `TranscriptSource` — the open chat's (`chatSource`),
 * a pane's chat (`paneSource`, read-only), or an aside thread
 * (`AsideTranscript.svelte` builds it from `asideTranscript.ts`). The
 * component itself is the same for all three; what differs is said here,
 * once: where the events and the live turn come from, which per-message
 * actions exist (an absent action is a control not drawn), where folds,
 * scroll place and the Reply quote are kept.
 *
 * A feature added to the transcript therefore reaches every source unless
 * it is guarded by `kind` — and `transcriptFeatures.ts` lists every such
 * guard with its reason, checked by a test.
 */
import { app, chatAgentSession, openChatKey, paneChat, type Segment } from "./state.svelte";
import type { AsideNote } from "./asideTranscript";
import { scrollKey } from "./scroll.svelte";
import type { ApprovalRequest, Attachment, SessionEvent } from "./types";
import type { TurnSize } from "./tokens";
import type { ReplyUsageView } from "./replyUsage";

export interface TranscriptActions {
  /** Rewind to the user turn at `index`. False: nothing was rewound. */
  rewind?: (index: number) => boolean | void | Promise<boolean | void>;
  /** The edit box's Send: ask `text` (with `chips`) in place of turn
   *  `index`. Absent with `forkEdit` absent: no Edit on his messages. */
  askEdited?: (index: number, text: string, chips: Attachment[]) => boolean | void | Promise<boolean | void>;
  /** Answer the turn that ends in reply `index` again. */
  retry?: (index: number) => void | Promise<void>;
}

export interface TranscriptSource {
  kind: "chat" | "pane" | "aside";
  /** `compact`: an aside's card or side panel — no ground, no rail. */
  frame: "full" | "compact";
  /** The chat, for what is the chat's alone (versions, plan use per reply,
   *  keep-warm, the continued-from line); null for an aside. */
  chat: string | null;
  events: SessionEvent[];
  live: { segments: Segment[]; since?: number | null } | null;
  /** Read by the follow-the-foot effect: changes with every delta. */
  liveVersion: () => unknown;
  approvals: ApprovalRequest[];
  /** The per-message tools are off (a turn runs; a pane, always). */
  locked: boolean;
  /** A turn runs here: an open editor is put away until it ends. */
  busy: boolean;
  /** A pane whose log is not read yet. */
  pending?: boolean;
  scrollKey: string;
  /** Where folds are kept (`keptFolds`): the scope's chat, and a turn's
   *  name in it (`"live"` for the running reply). Null chat: not kept. */
  foldChat: string | null;
  foldTurn?: (turn: number | "live") => string | null;
  /** Whose Run button a reply's shell block is. */
  runFrom: { chat: string | null; aside?: number };
  /** The send motion's channel (`sendMotion.ts`). */
  channel: "chat" | "aside";
  /** The Reply pill quotes into this draft; undefined: the chat's box. */
  draftKey?: string;
  /** Whether selected text offers Reply here. */
  reply: boolean;
  /** Claude Code's session, for a tool result's images. */
  cliSession: string | null;
  /** The live reply's model line. */
  liveModel: string | null;
  /** The chat's own actions (fork an edit, save, remove, restore, fork
   *  helpers, versions, attachments as tabs) — the open chat's alone. */
  chatActions: boolean;
  actions: TranscriptActions;
  /** An aside's words for the shared editor and tools. */
  words?: {
    rewindTip: string;
    editTip: string;
    sendLabel: string;
    sendTip: string;
    /** Why Send cannot go now, or null. */
    sendBlocked: string | null;
    editLine: string;
    retryTip: string;
  };
  /** Notes under an item (an aside's "stopped here", its error). */
  notes?: Map<number, AsideNote[]>;
  /** Replies with no token figures (a stored aside turn). */
  bare?: Set<number>;
  /** Per event index, the per-turn figure; absent: `turnSizes` of the
   *  events (the chat's and a pane's log). An aside's: `exchangeSizes`. */
  sizes?: (TurnSize | null)[];
  /** Per reply's event index, its share of the plan; absent: the chat's
   *  measured lines (`replyUsage.svelte.ts`, by `chat`). An aside's:
   *  the estimate from its cost (`estimateView`). */
  planUse?: Map<number, ReplyUsageView>;
  /** The messages he sent while an answer runs, drawn as his greyed
   *  bubbles under it (`PendingBubbles`, item 465; an aside's since 674's
   *  follow-up): `key` is the drafts entry whose queue they are. `aside`:
   *  the queue goes when the aside's answer ends — no mid-turn choices,
   *  and `blocked` says why a held one waits (`engine` / `not-open`).
   *  Absent: none (a pane). */
  pending?: { key: string; aside?: { busy: boolean; blocked: "engine" | "not-open" | null } };
  /** A note beside the waiting moon (an aside queued behind a turn). */
  waitNote?: string | null;
}

/** The open chat. */
export function chatSource(): TranscriptSource {
  const id = app.activeSessionId;
  return {
    kind: "chat",
    frame: "full",
    chat: id,
    events: app.events,
    live: app.live,
    liveVersion: () => app.liveVersion,
    approvals: app.pendingApprovals,
    locked: app.busy,
    busy: app.busy,
    scrollKey: scrollKey(id),
    foldChat: id,
    runFrom: { chat: id },
    channel: "chat",
    reply: true,
    cliSession: chatAgentSession(app.events) ?? app.agentInit?.session_id ?? null,
    liveModel: app.connection?.model ?? null,
    chatActions: true,
    actions: {},
    pending: { key: openChatKey() },
  };
}

/** A chat in a pane that is not the open one: read-only (backlog 159). */
export function paneSource(chat: string): TranscriptSource {
  const v = paneChat(chat);
  const events = v?.events ?? NO_EVENTS;
  return {
    kind: "pane",
    frame: "full",
    chat,
    events,
    live: v?.live ?? null,
    liveVersion: () => [app.liveVersion, app.paneVersion],
    approvals: NO_APPROVALS,
    locked: true,
    busy: false,
    pending: v === null,
    scrollKey: scrollKey(chat),
    foldChat: chat,
    runFrom: { chat },
    channel: "chat",
    reply: false,
    cliSession: chatAgentSession(events),
    liveModel: null,
    chatActions: false,
    actions: {},
  };
}

const NO_EVENTS: SessionEvent[] = [];
const NO_APPROVALS: ApprovalRequest[] = [];
