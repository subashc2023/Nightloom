// Types mirroring the Tauri backend IPC contract.
// Unknown discriminant values may arrive at runtime (the enums will grow);
// consumers must ignore variants they don't recognize.

export interface ProviderInfo {
  kind: string;
  available: boolean;
  default_model: string | null;
  /** Where the key in use comes from; null when no key is present. */
  key_source: "stored" | "env" | null;
}

export interface ConnectArgs {
  provider: string;
  model?: string;
  baseUrl?: string;
  /** "default" | "effort=low|medium|high" | "budget=<N>" */
  thinking?: string;
  /** Extra system-prompt text, appended after the assembled preamble. */
  system?: string;
  tools: boolean;
  /** Assemble the built-in preamble; omitted reads as true on the backend. */
  preamble: boolean;
  /** Attach the per-turn status block; omitted reads as true. */
  sidecar: boolean;
  /** Ask before running `mutating` tools; omitted reads as true. */
  approval: boolean;
  /** Offer web_fetch and web_search; omitted reads as true. */
  web: boolean;
  /** Root for the file tools and project-instruction discovery. */
  workspace?: string;
}

/** A reviewer as the rail shows it: the name the model asks for, and the
 *  model actually behind it. */
export interface ReviewerInfo {
  name: string;
  model: string;
}

/**
 * A search backend as the settings pane shows it. `active` is the one that
 * would actually answer: only the first backend with a key is used, so a
 * second key set is inert, and two filled boxes with no hint of which is live
 * would be worse than one.
 */
export interface SearchBackendInfo {
  name: string;
  label: string;
  env_key: string;
  key_source: "stored" | "env" | null;
  active: boolean;
}

export interface ConnectResult {
  provider: string;
  model: string;
  /**
   * The model's context window, when the backend knows it. Null for models
   * absent from the limits table — the gauge then shows raw token counts
   * rather than a percentage, because a guessed denominator would claim
   * headroom that may not exist.
   */
  context_limit: number | null;
  /** What the model charges. Null for a model with no verified price; the
   *  UI then shows no dollar figure at all rather than $0.00. */
  price: Price | null;
  /** MCP servers configured for this workspace, failures included. */
  mcp: McpServerInfo[];
  /**
   * The curated bench the `review` tool can ask for a second opinion. Empty
   * when no other lineage is reachable, in which case the tool is not offered
   * at all — a review by the model under review is the one answer it must not
   * give, so there is deliberately no fallback.
   */
  reviewers: ReviewerInfo[];
  /** Where the backend actually rooted the tools, after falling back. */
  workspace: string;
  /**
   * Which search provider `web_search` queries, or null when no key is set
   * and the tool is therefore absent. Read for the same reason `reviewers`
   * is: a model with no search does not say so, it guesses, and there is no
   * way to tell those apart from the transcript.
   */
  search: string | null;
  /**
   * The project this connection is filed under, echoed back from the
   * backend. Read rather than assumed: an open project overrides the
   * workspace the rail last saved, so this is the authority on which folder
   * the chat is actually in.
   */
  project: ProjectInfo | null;
}

/**
 * A project: a folder the user named, plus what is in it.
 *
 * The folder is the identity. Chats live in `<root>/.nightloom/sessions`,
 * shared notes in `<root>/.nightloom/notes`, and instructions in
 * `<root>/AGENTS.md` — so a project is a set of conventions over a directory
 * rather than a record in a database somewhere else.
 */
export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  notes_dir: string;
  /** Notes in the docspace, and chats logged under this project. */
  notes: number;
  chats: number;
  /**
   * False when the folder has moved or been deleted. Shown, not hidden: an
   * unplugged drive is not a decision to forget a project.
   */
  exists: boolean;
  /** ISO8601 */
  last_opened: string;
}

/** One file in a project's shared notes directory. */
export interface Note {
  /** Path relative to the notes dir, always with `/` separators. */
  name: string;
  bytes: number;
  /** ISO8601 */
  modified: string;
  /** First heading or first non-empty line; null for a non-text file. */
  summary: string | null;
}

export interface Usage {
  /** The whole prompt, cached or not — the backend normalizes Anthropic's
   *  exclusive count into this inclusive one. */
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  /** Subsets of `input_tokens`. Absent means the host reports no caching,
   *  which is not the same as a 0% hit rate. */
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** One MCP server, as reported by `connect`. */
export interface McpServerInfo {
  name: string;
  tools: number;
  /** Non-null when the server failed to start; its tools are simply absent. */
  error: string | null;
}

/** USD per million tokens, from the backend's pricing table. */
export interface Price {
  input: number;
  output: number;
  cache_read?: number | null;
  cache_write?: number | null;
}

export interface TurnResult {
  interrupted: boolean;
  stop_reason: string | null;
  usage: Usage;
}

export interface CompactResult {
  interrupted: boolean;
  summary: string;
  usage: Usage;
}

export interface SessionMeta {
  id: string;
  path: string;
  /** ISO8601 */
  modified: string;
  user_turns: number;
  first_user: string | null;
  /** The session's name. Null until its first turn has been named, and
   *  permanently null for a log written before names existed — so render
   *  `title ?? first_user`, never `title` alone. */
  title: string | null;
}

/** A session that matched a search. Flattened on the Rust side, so it is a
 *  `SessionMeta` with the two extra fields rather than a wrapper. */
export interface SessionHit extends SessionMeta {
  /** How many messages contain the query. */
  hits: number;
  /** Text around the first one, prefixed with who said it. */
  excerpt: string;
}

/**
 * An image sent with a user message. `data` is raw base64 with no `data:`
 * prefix — the backend stores it verbatim and each adapter builds whatever
 * envelope its vendor wants.
 */
export interface ImageInput {
  media_type: string;
  data: string;
}

/**
 * A document sent with a user message. `name` is not decoration: two of the
 * four wire dialects require a filename on the part, and it is what the
 * model has to say back when it refers to the file.
 */
export interface DocumentInput {
  media_type: string;
  name: string;
  data: string;
}

/**
 * A composer attachment: what crosses the IPC boundary plus what the strip
 * needs to render it. `kind` is what tells a thumbnail from a file chip —
 * `media_type` could be sniffed for it, but a chip that mis-sniffs renders
 * a broken <img>, and the composer already knows which branch accepted it.
 */
export interface Attachment {
  id: number;
  kind: "image" | "document";
  media_type: string;
  name: string;
  data: string;
}

/** What running a tool can touch. Classified on the backend, per tool. */
export type Effect = "read_only" | "session" | "mutating";

/**
 * A tool call parked at the approval gate, from the `tool-approval` event.
 * The backend's policy answers `read_only` and `session` calls itself, so
 * in practice `effect` is always "mutating" here.
 */
export interface ApprovalRequest {
  /** The tool_use_id; `approve_call` keys the answer on it. */
  id: string;
  name: string;
  input: unknown;
  effect: Effect;
}

export type ApprovalDecision = "allow" | "always" | "deny";

/** One entry of the model's task list (`todo_write`). */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "document"; media_type: string; name: string; data: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; signature?: string }
  /** OpenAI Responses reasoning item, replayed by id. Nothing to render. */
  | { type: "reasoning_ref"; id: string }
  | {
      type: "tool_result";
      tool_use_id: string;
      name: string;
      content: string;
      is_error?: boolean;
    };

export type SessionEvent =
  | { event: "session_created"; id: string; at: string }
  // `images` and `documents` are absent, not empty, on messages logged
  // without any — including every message logged before attachments existed.
  | {
      event: "user_message";
      text: string;
      images?: ImageInput[];
      documents?: DocumentInput[];
      at: string;
    }
  | {
      event: "assistant_message";
      model: string;
      blocks: ContentBlock[];
      stop_reason: string | null;
      usage: Usage;
      // Recorded when the exchange ran, not derived now: prices change, and
      // the provider that billed it is not recoverable from `model` alone.
      // Absent means unpriced, which is not free.
      cost?: number;
      at: string;
    }
  // Supersedes events `to..` up to this marker. The log keeps them, so the
  // UI can show what was dropped; see `liveFlags` in state.svelte.ts.
  | { event: "rewind"; to: number; at: string }
  | {
      event: "tool_result";
      tool_use_id: string;
      name: string;
      content: string;
      is_error?: boolean;
      at: string;
    }
  | { event: "todo_state"; todos: TodoItem[]; at: string }
  // What the session is called. Not rendered in the transcript — the sidebar
  // reads it off `SessionSummary.title` instead — but part of the union so a
  // reader of the log sees every kind of line that can be in one.
  | { event: "title"; text: string; at: string }
  // Content markers, not deletions: the listed events keep their place in the
  // conversation and project a stand-in instead of their payload. The log
  // still holds the content, so the transcript renders these turns in full and
  // only the context panel cares.
  | { event: "elide"; targets: number[]; at: string }
  | { event: "unelide"; targets: number[]; at: string }
  | { event: "compaction"; summary: string; at: string }
  // A log entry the backend could not read: an event from a newer build, or a
  // line the disk damaged. It holds its index so that `rewind` and `elide`,
  // which address events by position, still point where they were aimed. There
  // is nothing to render, and the transcript's if/else chain skips it.
  | { event: "unknown" };

export type TurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "redacted_thinking" }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      name: string;
      content: string;
      is_error: boolean;
    }
  /**
   * Refused at the approval gate. Arrives *instead of* a `tool_result`,
   * since nothing ran — but the session log still records an error result,
   * so the post-turn re-sync shows one.
   */
  | { type: "tool_denied"; tool_use_id: string; name: string; reason: string }
  | { type: "round_limit"; rounds: number }
  /** The model compacted the context itself, mid-turn, via `compact_context`. */
  | { type: "compacted"; summary: string }
  | { type: "usage"; usage: Usage };

/**
 * Item size. `tokens` is an *estimate* (the backend has no tokenizer, by
 * design), and null where even an estimate would be invention — an image or
 * a document, whose cost depends on what a vendor's own decoder makes of the
 * bytes. Render a null as a byte size, never as a token count.
 */
export interface Size {
  bytes: number;
  tokens: number | null;
}

/**
 * A sum that knows what it could not count. `unestimated > 0` means `tokens`
 * is a floor and should be shown with a `≥`, exactly like a session cost
 * with unpriced exchanges.
 */
export interface ContextTotals {
  tokens: number;
  bytes: number;
  unestimated: number;
}

export type BlockKind =
  | "text"
  | "image"
  | "document"
  | "thinking"
  | "redacted_thinking"
  | "tool_use"
  | "reasoning_ref"
  | "tool_result"
  /** The per-turn status block. Composed at projection time, never logged. */
  | "sidecar";

/**
 * Where a projected block came from. `event` carries the log index that
 * `editContext` acts on; `sidecar` has no index because there is nothing in
 * the log to act on.
 */
export type BlockSource =
  | { from: "event"; index: number }
  | { from: "sidecar" }
  // Supplied by the projection to keep the request well-formed — today, the
  // result of a tool call the process died before recording. No log event sits
  // behind it, so the context panel offers no remove button for it.
  | { from: "repair" };

export interface WireBlock {
  kind: BlockKind;
  /** Leading characters only — never the whole payload. */
  preview: string;
  truncated: boolean;
  size: Size;
  source: BlockSource;
  /** The source event's content is currently replaced by a marker. */
  elided: boolean;
  /** Whether `editContext` would accept this block's source event. */
  elidable: boolean;
}

export interface WireMessage {
  role: "user" | "assistant";
  blocks: WireBlock[];
  totals: ContextTotals;
}

export interface WireSegment {
  kind: string;
  name: string;
  preview: string;
  truncated: boolean;
  size: Size;
  /** Where the cached prefix is claimed to end. */
  cache_anchor: boolean;
}

/** The request the backend would send right now, itemized. */
export interface WireView {
  system: WireSegment[];
  messages: WireMessage[];
  /** Over system and messages both — the figure to compare to the limit. */
  totals: ContextTotals;
  context_limit: number | null;
}

/** What `editContext` changed: both projections, plus how many items moved. */
export interface ContextEdit {
  view: WireView;
  events: SessionEvent[];
  changed: number;
}

/** One project produced by a claude.ai import. */
export type ImportedProject = {
  name: string;
  root: string;
  chats: number;
  already: number;
  notes: number;
  warnings: string[];
};

export type ImportSummary = {
  projects: ImportedProject[];
  unfiled: number;
  unreadable: number;
  summary: string;
  warnings: string[];
};
