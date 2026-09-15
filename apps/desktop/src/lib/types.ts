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
  /** Offer compact_context; omitted reads as false. */
  selfCompact: boolean;
  /**
   * Give the model the knowledge base: the `@kb` tree and its index in the
   * preamble. Omitted reads as true.
   *
   * Its own switch rather than riding on `tools`, because turning tools on has
   * always meant "may write inside this folder" and the vault is a second
   * directory outside it.
   */
  knowledge: boolean;
  /** Root for the file tools and project-instruction discovery. */
  workspace?: string;
}

/**
 * Connecting the Claude Code engine: turns run through the signed-in CLI and
 * are billed to the subscription instead of to an API key.
 *
 * A separate shape from `ConnectArgs` rather than a provider value on it,
 * because almost none of that call's fields mean anything here — Claude Code
 * assembles its own prompt and runs its own loop, so a base URL, a thinking
 * mode and a sidecar all have nobody to talk to. The preamble is the one
 * layer that crosses: it goes in `--append-system-prompt` ahead of `system`.
 */
export interface AgentConnectArgs {
  /** The CLI to run. Defaults to `claude` on PATH. */
  binary?: string;
  /** A model alias (`opus`, `sonnet`, `haiku`) or a full id. */
  model?: string;
  workspace?: string;
  tools: boolean;
  /**
   * Maps to the CLI's permission mode: on means `auto` (its classifier
   * decides, and denies what it cannot approve rather than waiting), off
   * means `bypassPermissions`. Nightloom's own approval prompt does not run
   * on this engine — the gate belongs to whoever owns the loop, and that is
   * not us.
   */
  approval: boolean;
  /**
   * Run without the host's CLAUDE.md, hooks, plugins and MCP servers. This is
   * `--safe-mode` and not `--bare`: bare mode never reads OAuth credentials,
   * so it would silently put the turn back on an API key.
   */
  safeMode: boolean;
  /** Stop the turn if the CLI's own cost estimate passes this. */
  budget?: number;
  /** Appended to Claude Code's system prompt, after the preamble. */
  system?: string;
  /**
   * Send Nightloom's preamble — the user's AGENTS.md, the walk, the notes
   * and vault indexes — ahead of `system`. Same default as `connect`: on.
   */
  preamble?: boolean;
}

/** The agent engine as the rail shows it; see the Rust `AgentInfo`. */
export interface AgentInfo {
  /**
   * The binary that actually answered, which is the *resolved* path and not
   * necessarily the name that was asked for: a GUI process on macOS gets a
   * minimal PATH, so a bare `claude` is looked for in the usual install
   * locations too. The two differ exactly when that fallback did something,
   * which is worth showing rather than hiding.
   */
  binary: string;
  /** What `--version` printed at connect. */
  version: string | null;
  /** The API key is withheld, so the turn goes to the plan. */
  subscription: boolean;
  /** "auto" | "bypassPermissions", or null when tools are off. */
  permission_mode: string | null;
  safe_mode: boolean;
  /** The agent session this chat continues, when it has one. */
  resume: string | null;
}

/** What one agent turn spent, and which plan window it came out of. */
export interface AgentTurnResult {
  /** The model the CLI resolved the alias to. */
  model: string | null;
  context_limit: number | null;
  /** The CLI's estimate of what this turn would have cost on the API. Not a
   *  bill: nothing here is charged per token under a subscription. */
  cost_usd: number | null;
  rounds: number | null;
  /** Present only on an OAuth run, which makes it the one honest signal that
   *  the turn was billed to the plan and not to a key. */
  plan: {
    status: string | null;
    rateLimitType: string | null;
    resetsAt: number | null;
    isUsingOverage: boolean;
  } | null;
  notices: string[];
  is_error: boolean;
}

/** A reviewer as the rail shows it: the name the model asks for, and the
 *  model actually behind it. */
export interface ReviewerInfo {
  name: string;
  model: string;
}

/**
 * A search backend as the settings pane shows it. `order` is its 1-based
 * place in the chain, or null with no key: every key is used, asked in turn
 * until one answers, so the position is what a reader needs and a bare "this
 * one is live" flag would not say.
 */
export interface SearchBackendInfo {
  name: string;
  label: string;
  env_key: string;
  key_source: "stored" | "env" | null;
  order: number | null;
}

export interface ConnectResult {
  provider: string;
  model: string;
  /**
   * Which engine is behind this connection: "provider" or "claude-code".
   *
   * More than a label. The controls that rewind, compact and itemize the
   * context all act on the session log, and on the agent engine that log is a
   * record of a conversation kept somewhere else — so they would change what
   * the window shows and nothing about what the next turn replays.
   */
  engine: string;
  /** Present only on the agent engine. */
  agent: AgentInfo | null;
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
   * Which search providers `web_search` queries — the whole chain, arrowed in
   * the order they are asked — or null when no key is set and the tool is
   * therefore absent. Read for the same reason `reviewers` is: a model with
   * no search does not say so, it guesses, and there is no way to tell those
   * apart from the transcript.
   */
  search: string | null;
  /**
   * The knowledge base this connection can reach, or null when the switch is
   * off (and always null on the agent engine, which owns its own file
   * access). Read for the same reason `search` is: a folder the model is
   * quietly reading — or quietly not reading — cannot be worked out from the
   * transcript.
   */
  knowledge: KnowledgeInfo | null;
  /**
   * The project this connection is filed under, echoed back from the
   * backend. Read rather than assumed: an open project overrides the
   * workspace the rail last saved, so this is the authority on which folder
   * the chat is actually in.
   */
  project: ProjectInfo | null;
}

/**
 * A project: something the user named, which *may* be about a folder.
 *
 * Notes live in `<root>/.agents` and instructions in `<root>/AGENTS.md`, both
 * inside the folder and both the user's to commit. Chats live outside it, in
 * `~/.nightloom/projects/<id>/sessions`, because a repository is not a place
 * to leave personal history.
 */
export interface ProjectInfo {
  id: string;
  name: string;
  /**
   * The folder, or null for a project about no folder — an imported claude.ai
   * project is instructions, documents and conversations with no code
   * anywhere. Anything rendering this has to handle the null.
   */
  root: string | null;
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

/**
 * Which of the two note stores a call means.
 *
 * `project` is `<workspace>/.agents` — about the code, and only while a
 * project is open. `knowledge` is the user's own vault — about them, the same
 * one in every project, and available with no project at all.
 */
/**
 * `project` and `knowledge` are folders of notes; `instructions`
 * (`<workspace>/AGENTS.md`) and `memory` (`~/.nightloom/AGENTS.md`) each
 * name one fixed file — the always-loaded half of the two stores, reached
 * through the same editor. Neither lists, neither deletes.
 *
 * `models` is `~/.nightloom/models/`: one file per model id, read whole into
 * the preamble of a chat on that model and no other. A folder, so it lists
 * and deletes, but its names are ids rather than titles — see
 * `modelInstructionFile` in catalog.ts. A missing file reads as empty text,
 * like the fixed files, so the editor can open on a model that has none yet.
 */
export type NoteScope = "project" | "knowledge" | "instructions" | "memory" | "models";

/** What one dream did, flattened for a toast. `git` arrives as a finished
 *  sentence — one clause per folder the pass touched — because the frontend
 *  has nothing to add to it. `filed` is the split by target in the order the
 *  turns ran, projects first and the vault last. */
export interface DreamReport {
  consolidated: number;
  filed: { project: string | null; consolidated: number; proposed: boolean }[];
  remaining: number;
  interrupted: boolean;
  git: string;
  /** "proposed a change to Lanternfish's instructions …" — the backend's
   *  own clause, null when no turn proposed. */
  proposed: string | null;
  cost_usd: number | null;
}

/** The two scopes the dream may propose a change to: the fixed files. */
export type ProposalScope = "instructions" | "memory";

/** A proposed replacement for an always-loaded file, written by the dream
 *  beside the store and never applied by it: the user loads it into the
 *  editor as a draft and saves, or dismisses it. */
export interface Proposal {
  v: number;
  at: string;
  target: { kind: "project"; id: string; name: string } | { kind: "user" };
  /** One paragraph: what changed and which observations asked for it. */
  why: string;
  /** The full replacement text. */
  text: string;
  from_dream: boolean;
}

/** A pending proposal as the backend lists it: the handle every other call
 *  takes, and the content. */
export interface ProposalEntry {
  id: string;
  proposal: Proposal;
}

/** What one capture pass did, flattened for a toast. `per_project` is the
 *  split by source in the order the session dirs were walked, "unfiled" for
 *  the chats with no project. */
export interface CaptureReport {
  observations: number;
  logs_read: number;
  skipped: number;
  deferred: number;
  remaining: number;
  per_project: { project: string; observations: number }[];
  interrupted: boolean;
  cost_usd: number | null;
}

/** Where the knowledge base is and what is in it. */
export interface KnowledgeInfo {
  dir: string;
  /** How the model addresses it (`@kb`), so the UI shows the same string the
   *  system prompt does rather than inventing a name for it. */
  alias: string;
  notes: number;
  /** Whether it sits where it would with nothing configured. */
  is_default: boolean;
  /** False until the first note is written — the ordinary state of a new
   *  install, not an error. */
  exists: boolean;
}

/** Where new projects go (Settings → Projects folder). */
export interface ProjectsFolderInfo {
  dir: string;
  /** Whether it is where new projects would go with nothing configured. */
  is_default: boolean;
  /** False until the first project is created there — Create makes it. */
  exists: boolean;
}

/**
 * What the New project form shows as its folder row: the slug the name
 * makes and the path under the projects folder. Computed by the backend by
 * the same rule Create uses, so the preview and the folder cannot disagree.
 */
export interface NewProjectPath {
  /** `<projects folder>/<slug>`; empty when the slug is. */
  path: string;
  /** Empty when the name has no letter or digit in it. */
  slug: string;
  folder: string;
}

/** What a `[[link]]` target turned out to name. */
export type Resolution =
  | { kind: "note"; index: number }
  /** Two or more notes share the basename. Reported rather than picked: the
   *  user is the only one who knows which was meant. */
  | { kind: "ambiguous"; indexes: number[] }
  /** Nothing answers to it — normal in a vault, where writing `[[thing]]`
   *  before the note exists is how a note gets planned. */
  | { kind: "missing" };

/** A resolved link between two notes, by index into `LinkGraph.notes`. */
export interface Edge {
  from: number;
  to: number;
}

/** A link that names no single note, kept with the note that wrote it. */
export interface BrokenLink {
  from: number;
  target: string;
  resolution: Resolution;
}

/** The vault as notes and the links between them. */
export interface LinkGraph {
  notes: Note[];
  /** Deduplicated, and self-links dropped: what a graph draws is whether two
   *  notes are connected. */
  edges: Edge[];
  broken: BrokenLink[];
}

/** One file in a project's shared notes directory, or in the vault. */
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
  // Which of an external agent's sessions this log mirrors. Metadata about
  // where the conversation is kept rather than a turn in it, so the
  // transcript skips it; latest wins, like a title.
  | { event: "agent_session"; agent: string; id: string; at: string }
  // Which system-prompt layers this chat has switched off, as `SegmentKind`
  // names (`project_instructions`, `project_notes`, …). Latest wins, like a
  // title; absent or empty means all on. Not a turn: the backend reads it at
  // connect time and assembles the prompt without those layers, and the
  // transcript skips it. See `promptLayersOff` in state.svelte.ts.
  | { event: "prompt_layers"; off: PromptLayer[]; at: string }
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
  /** The whole segment — the system prompt is the item a reader came to
   *  read, unlike a tool result, which carries a preview only. */
  text: string;
  size: Size;
  /** Where the cached prefix is claimed to end. */
  cache_anchor: boolean;
}

/** The request the backend would send right now, itemized. */
export interface WireView {
  system: WireSegment[];
  /** The system prompt as one string, rendered by the backend with the same
   *  join the adapters use — "as sent", not a re-join done here. Null when
   *  there is no system prompt. */
  system_text: string | null;
  messages: WireMessage[];
  /** Over system and messages both — the figure to compare to the limit. */
  totals: ContextTotals;
  context_limit: number | null;
}

/**
 * A system-prompt layer a chat can switch off, by the backend's
 * `SegmentKind` name. `custom` is a kind but not a layer: the library prompt
 * has its own dropdown. `engine_note` exists on the Claude Code engine only.
 */
export type PromptLayer =
  | "identity"
  | "environment"
  | "user_memory"
  | "model_instructions"
  | "project_instructions"
  | "project_notes"
  | "knowledge"
  | "engine_note";

/**
 * The open chat's switched-off layers beside the set the live engine was
 * built with; the two differ exactly when a reconnect is due.
 */
export interface PromptLayersInfo {
  off: PromptLayer[];
  built: PromptLayer[];
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
  /** Empty when the import was asked for no folders. */
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
  /** Projects whose claude.ai memory was too long for AGENTS.md, with the size. */
  needs_condensing: [string, number][];
};

// ---- Nightshift ----
//
// Mirrors of the serde shapes in `crates/nightloom-service/src/nightshift/`
// and the `#[tauri::command]` return types in `apps/desktop/src-tauri/src/
// nightshift.rs`. See SHIFT-CONTRACT.md in the nightshift repo for what each
// file means; the section references below point at it.

/** A registered project as the Nightshift list shows it. */
export interface NightshiftRow {
  id: string;
  name: string;
  /** The Nightloom workspace, or null for a project about no folder. */
  workspace: string | null;
  exists: boolean;
  nightshift: NightshiftInfo | null;
  /** The folder holding a `nightshift.json.disabled` — a root Disable turned
   *  off, which Enable restores rather than scaffolds (item 037). */
  disabled: string | null;
}

/** What detection found for a project, plus the counts a row needs. */
export interface NightshiftInfo {
  contract_root: string;
  nested: boolean;
  config: Config;
  config_error: string | null;
  /** `state/run.lock`, when present. */
  lock: Lock | null;
  /** A shift is running, or the platform cannot say it is not. */
  live: boolean;
  /** Where the runner is looked for: `runner` from `nightshift.json`, else
   *  the contract root itself (§3, blocker 024). */
  runner: string;
  /** `bin/nightshift.sh` exists under `runner`. */
  runner_present: boolean;
  git: boolean;
  /** Files the runner's `git add -A` would sweep into a `WIP:` commit at
   *  launch; `null` when the root is not a repo or git cannot say. */
  dirty: number | null;
  items: number;
  open_blockers: number;
  newest_morning: string | null;
  latest_shift: string | null;
}

/** `nightshift.json` — see SHIFT-CONTRACT.md §3, amended by §12.2. */
export interface Config {
  version: number;
  /** `research` or `build`; the default for items and shifts (§13.1). */
  kind: string;
  name: string;
  /** Where build units edit code, relative to the contract root. `"."`
   *  means none (§12.1). */
  workspace: string;
  /** The permission allowlist a unit runs under (§12.2). */
  allowed_tools: string[];
  /** Passes an item gets before the shift moves on (§12.3). */
  max_passes: number;
  /** The directory holding `bin/nightshift.sh` — the one runner install
   *  (§3, blocker 024). Absent means this root's own `bin/`. */
  runner?: string;
}

/** `state/run.lock`, and whether that pid is still running (§10). */
export interface Lock {
  /** The pid in the file, or null when the file exists but holds none. */
  pid: number | null;
  /** true running, false dead (a stale lock), null when this platform
   *  cannot say. */
  alive: boolean | null;
}

/** One `## ` section of an item or blocker body. */
export interface Section {
  /** The heading text after `## `, verbatim. */
  title: string;
  /** The lines under it up to the next `## `, trimmed. */
  text: string;
}

/** A backlog item — `backlog/<id>-<slug>.md` (§4). */
export interface Item {
  id: string;
  /** `backlog/<file>`. */
  file: string;
  path: string;
  title: string;
  /** Resolved: the item's own `kind`, else the project's. */
  kind: string;
  /** `todo | in-progress | done | killed | deferred`; empty when unset. */
  status: string;
  created: string;
  /** `interview | manual | migrated | followup:<blocker>`. */
  source: string;
  /** Resolved: the item's own `max_passes`, else the project's. */
  max_passes: number;
  /** `model:` when the item names one (§12.4). */
  model: string | null;
  /** Every frontmatter field, last value wins. */
  fields: Record<string, string>;
  /** Body text before the first `## ` heading. */
  preface: string;
  sections: Section[];
  /** The bullet lines under `## Progress`, one per pass the runner recorded. */
  progress: string[];
  /** Where this item sits in `order.json`, or null when unlisted. */
  order: number | null;
}

export interface ItemList {
  items: Item[];
  order: string[];
  /** Files that did not read, by message. Shown, not dropped. */
  errors: string[];
}

/** A blocker — `blockers/<id>-<slug>.md` (§5). */
export interface Blocker {
  id: string;
  file: string;
  path: string;
  /** `open | answered | withdrawn | applied`. */
  status: string;
  raised: string;
  /** The shift that raised it; empty for one raised by a human, or
   *  migrated from before the contract. */
  shift: string;
  item: string;
  /** The follow-up item the runner created from the answer (§13.6). */
  follow_up: string | null;
  question: string;
  /** `## What I would have done, and why`. */
  guess: string;
  /** `## What it blocks`. */
  blocks: string;
  answer: string;
  /** `## Where the guess lives` — build blockers name the path(s) (§13.3). */
  where_guess_lives: string;
  fields: Record<string, string>;
  sections: Section[];
}

export interface BlockerList {
  blockers: Blocker[];
  errors: string[];
}

/** One entry of a plan's item list. */
export interface PlanItem {
  id: string;
  selected: boolean;
}

/** `shifts/<id>/plan.json` (§6). `until`, `max_units` and `budget_usd` are
 *  null when the plan does not bound that axis. */
export interface Plan {
  shift_id: string;
  created: string;
  /** `manual` or `schedule:<schedule-id>`. */
  source: string;
  /** `research | build` (§13.1); absent in plans written before round 5. */
  kind: string | null;
  items: PlanItem[];
  until: string | null;
  max_units: number | null;
  budget_usd: number | null;
}

/** One `units[]` entry of `status.json`. */
export interface UnitStatus {
  n: number;
  item_id: string | null;
  pass: number | null;
  started: string | null;
  ended: string | null;
  /** `done | partial | failed | wip`, null while running (§13.2). */
  outcome: string | null;
  commit: string | null;
  cost_usd: number | null;
  turns: number | null;
  continuation_commit: string | null;
  /** The pass ended in a landing pass (§13.5). */
  landing: boolean;
}

/** `status.json` (§6, amended by §13.5). */
export interface Status {
  shift_id: string;
  pid: number | null;
  /** `preflight | gate | unit | landing | continuation | checkpoint |
   *  review | page | sleeping | done | failed`. */
  phase: string;
  phase_started: string | null;
  started: string | null;
  updated: string | null;
  head_at_start: string | null;
  /** Repo-relative path of the plan. */
  plan: string | null;
  unit_index: number;
  item_id: string | null;
  pass: number | null;
  units: UnitStatus[];
  /** The usage snapshot as the runner wrote it; passed through unshaped
   *  since its keys have moved before. */
  usage: unknown;
  next_wake: string | null;
  /** The morning page, once written. */
  page: string | null;
  /** The review note, once written, repo-relative. */
  review: string | null;
  /** The exit code once finished; null while running or interrupted. */
  exit: number | null;
}

/** What the Runs page lists — one `shifts/<id>/` directory (§6). */
export interface ShiftSummary {
  id: string;
  dir: string;
  plan: Plan | null;
  status: Status | null;
  /** A file that exists but did not parse — shown, not swallowed. */
  plan_error: string | null;
  status_error: string | null;
  /** `exit` is null and the pid is alive. */
  live: boolean;
  /** `exit` is null and the pid is dead: the exit trap committed WIP and
   *  the next shift redoes the pass (§6). */
  interrupted: boolean;
  /** `exit` is null and this platform cannot ask about the pid. */
  unknown: boolean;
  log_bytes: number;
}

/** A morning page by name, or the newest when `name` was omitted. */
export interface MorningPage {
  name: string;
  text: string;
}

/** One file under `mornings/`. */
export interface Morning {
  /** The file name, `2026-09-11.md` or `LATEST.md`. */
  name: string;
  path: string;
  size: number;
  /** RFC 3339, or empty when the OS does not say. */
  modified: string;
}

/** One entry of the `notes/` tree. */
export interface NoteEntry {
  /** Root-relative with forward slashes, `notes/runner-design/x.md`. */
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
  modified: string;
}

/** One entry of `schedule.json` (§7). */
export interface Schedule {
  id: string;
  enabled: boolean;
  days: string[];
  start: string;
  until: string | null;
  max_units: number | null;
  budget_usd: number | null;
  /** `"global-order"` or a list of ids; kept as `unknown` since the two
   *  shapes share nothing. */
  items: unknown;
}

export interface Schedules {
  schedules: Schedule[];
}

/** What a revert would discard, or did discard, of one shift. */
export interface RevertPreview {
  /** The commit the shift started from. */
  target: string;
  head: string;
  /** Commits between the two — what would be discarded. */
  commits: number;
  /** `git diff <target>..HEAD`: the work a revert throws away. */
  diff: string;
  stat: string;
  /** Uncommitted changes in the tree. A revert refuses while true. */
  dirty: boolean;
}

/** A one-off launch the app is holding for a project (the Plan screen's
 *  Start field: when the usage window resets, or at a time). In memory in
 *  the backend only; gone with the app. */
export interface PendingLaunch {
  /** Unix epoch milliseconds. */
  fire_at_ms: number;
  /** The draft's id — re-minted to the launch moment when the timer fires. */
  shift_id: string;
  /** Selected items. */
  items: number;
}

/** The payload of a `nightshift-launched` window event: a held launch fired. */
export interface NightshiftLaunched {
  project_id: string;
  shift_id: string | null;
  pid: number | null;
  error: string | null;
}

/** `bin/usagectl.py --json` as the runner's gate reads it. Percentages are
 *  null when the probe has no reading. */
export interface NightshiftUsage {
  five_hour: number | null;
  seven_day: number | null;
  age_seconds: number | null;
  stale: boolean;
  /** ISO 8601 with offset, e.g. `2026-09-12T12:10:00.408607+00:00`. */
  five_hour_resets_at: string | null;
  source: string;
  severity: string | null;
}

/** The payload of a `nightshift-change` window event. */
export interface NightshiftChange {
  project_id: string;
  /** Root-relative paths that changed, deduplicated. */
  paths: string[];
}

/** The intake interview (item 005): the conversation as the backend holds
 *  it — one per project, in memory. */
export interface InterviewMessage {
  role: "user" | "assistant";
  text: string;
}
export interface InterviewView {
  messages: InterviewMessage[];
  model: string | null;
}
/** A `nightshift-interview` window event. */
export interface InterviewEvent {
  project_id: string;
  kind: "delta" | "done" | "error";
  text: string;
}
export interface InterviewWritten {
  id: string;
  title: string;
  kind: string;
}
