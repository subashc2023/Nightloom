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
  /**
   * The Ask position (2026-09-16): with `approval` on, the CLI pauses on
   * each call a person should decide — a write, a command, a question, a
   * plan — and the transcript asks, as on the API engine. Omitted reads as
   * false, which is `auto`.
   */
  ask?: boolean;
  /**
   * The Plan position (2026-09-16, backlog 085): Ask under the CLI's plan
   * mode — it reads, drafts a plan and asks on the card before any edit;
   * Approve picks whether the chat goes on as Ask or Auto. Implies `ask`.
   */
  plan?: boolean;
  /** Ask the CLI to predict the next prompt after each turn (nightshift
   *  backlog 083): `--prompt-suggestions true`. Off by default — about six
   *  seconds added to every turn. */
  promptSuggestions?: boolean;
  /** `--effort low|medium|high|xhigh|max` (backlog 076); omitted is the
   *  CLI's default. */
  effort?: string;
  /** `--fallback-model <alias>`; omitted is no fallback. */
  fallbackModel?: string;
  /** *Subagents run on auto* under Ask and Plan (nightshift backlog 152):
   *  a subagent's call the hook would pause for runs instead when true,
   *  is refused in words when false. Omitted is on. */
  subagentsAuto?: boolean;
  /** Stop the turn if the CLI's own cost estimate passes this. */
  budget?: number;
  /** The subagent limits (backlog 165); omitted is the defaults. */
  limits?: import("./catalog").SubagentLimits;
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
  /** `--effort` as sent, or null for the CLI's default (backlog 076). */
  effort: string | null;
  /** `--fallback-model` as sent, or null for none. */
  fallback_model: string | null;
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
    /** Share of `rateLimitType` used, 0–1. On 2.1.263 (measured 2026-09-16,
     *  nightshift backlog 073); absent from a build that does not send it. */
    utilization?: number | null;
    /** Both windows at once, 2.1.263: the live figures the plan chip
     *  prefers over any sample file. */
    unifiedWindows?: {
      five_hour: { utilization: number | null; resetsAt: number | null } | null;
      seven_day: { utilization: number | null; resetsAt: number | null } | null;
    } | null;
  } | null;
  /** The usage limit that stopped the turn (nightshift backlog 164): the
   *  transcript marks it paused, not failed, and offers a Resume that runs
   *  after `resets_at`. Null on every other end. */
  limit: {
    resets_at: number | null;
    window: string | null;
    text: string;
    /** The spawning calls of the subagents that died on it. */
    subagents: string[];
  } | null;
  notices: string[];
  is_error: boolean;
  /** Folders outside every tree the chat may see that the CLI refused a
   *  read in this turn (backlog 143, pass 2), each once: the rail offers
   *  each for a grant. */
  refused: string[];
  /** The rail's folder list, refreshed, when the approval card granted a
   *  folder this turn; null otherwise. */
  folders: FolderInfo[] | null;
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
   * The extra folders this connection may reach beyond the workspace
   * (nightshift backlog 143): the project's and the chat's own, each with
   * its source and — on the API engine — the `@alias` the tools spell it
   * by. Absent on a connection made before the field existed.
   */
  folders?: FolderInfo[];
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
  /** The other folders the project's content lives in (nightshift backlog
   *  143), granted to every chat in it. Absent on an older shape. */
  extra_folders?: string[];
}

/** One extra folder as the rail and the Context popover show it (backlog 143). */
export interface FolderInfo {
  path: string;
  /** `project` or `chat`. */
  source: string;
  /** `@name` on the API engine; null on the CLI, whose tools take the path. */
  alias: string | null;
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
 *
 * `chat` is `~/.nightloom/CHAT.md` — the Chat instructions (nightshift
 * backlog 102): how a chat of the Chat kind talks. One fixed file like
 * `memory`, reached through the same editor from Settings.
 */
export type NoteScope = "project" | "knowledge" | "instructions" | "memory" | "models" | "chat";

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
  /** Incognito chats seen and deliberately not read. */
  incognito: number;
  per_project: { project: string; observations: number }[];
  interrupted: boolean;
  cost_usd: number | null;
}

// ---- the notification centre (nightshift backlog 069) ----

/** The project a centre notice belongs to; null means the user. */
export interface ProjectRef {
  id: string;
  name: string;
}

/** One pending proposal with the project whose store holds it — the
 *  centre reads every project's, not only the open one's. */
export interface ProposalNotice {
  project: ProjectRef | null;
  entry: ProposalEntry;
}

/** One file a dream's commit touched. */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

/** One after-dream commit (`nightloom: dream — …`) in the vault or a
 *  project's `.agents`, with what it changed. */
export interface DreamCommit {
  project: ProjectRef | null;
  /** The repository: the vault, or the project's workspace. */
  repo: string;
  hash: string;
  /** RFC 3339. */
  at: string;
  subject: string;
  files: ChangedFile[];
}

/** What build is running; a change between launches is a release. */
export interface BuildStamp {
  version: string;
  exe_modified: string | null;
}

/** What the tidy step found or did in one folder. */
export interface TidyReport {
  files: number;
  spans: number;
  movable: number;
  undated: number;
  unterminated: number;
  young: number;
  saved: number;
  touched: string[];
}

export interface TidyOutcome {
  /** The project's name, or null for the vault. */
  project: string | null;
  dir: string;
  report: TidyReport;
  /** The snapshot clause, empty when nothing moved. */
  git: string;
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

/**
 * The usage ledger (Settings → Usage; nightshift backlog 045): what Claude
 * Code has cost, read from the user-global collector's files under
 * `~/.claude` and never written. Every dollar is an API-equivalent — the
 * turns were mostly billed to a subscription, and this is what they would
 * have cost — priced by `usage-rates.json` on the dedup basis (one count
 * per API message id, what the API would bill). Dates are UTC.
 */
/**
 * The plan's own five-hour and seven-day percentages (nightshift backlog
 * 073, 2026-09-16), read from the Claude desktop app's sample file and the
 * CLI's cache — whichever was sampled more recently; `plan_usage.rs` says
 * why both. Server-computed and account-wide, never estimated. `stale`
 * past twenty minutes, or with no sample at all (`source: "none"`).
 */
export interface PlanUsage {
  five_hour: number | null;
  seven_day: number | null;
  sampled_at_ms: number | null;
  age_seconds: number | null;
  stale: boolean;
  five_hour_resets_at: string | null;
  seven_day_resets_at: string | null;
  /** `turn` is the frontend's own: the last agent turn's `rate_limit_event`
   *  (see `AgentTurnResult.plan.unifiedWindows`), fresher than any file. */
  source: "desktop" | "cli-cache" | "cli-usage" | "none" | "turn";
}

export interface UsageSummary {
  /** False with `reason` when the collector has never run on this machine. */
  available: boolean;
  reason: string | null;
  /** The directory the three files live in. */
  dir: string;
  /** The collector's path, for the pane's one-line note. */
  collector: string;
  first_date: string | null;
  last_date: string | null;
  /** RFC 3339 UTC; the ledger CSV's mtime — when the collector last finished. */
  updated_at: string | null;
  today: WindowSpend | null;
  week: WindowSpend | null;
  month: WindowSpend | null;
  /** The newest surfaces snapshot, if the file exists. */
  surfaces: SurfaceRow | null;
  /** Models the ledger counted that the rates table does not price. */
  unpriced_models: string[];
}

/** A window of UTC days on the dedup basis. */
export interface WindowSpend {
  from: string;
  to: string;
  days_with_data: number;
  usd: number;
  /** Largest first; both scopes (main and subagent) folded together. */
  by_model: ModelSpend[];
}

export interface ModelSpend {
  model: string;
  usd: number;
  reqs: number;
  output: number;
  /** True when the rates table has no row: `usd` is 0 and means unpriced, not free. */
  unpriced: boolean;
}

/**
 * One snapshot of the desktop app's seven-day breakdown by surface. Percents
 * are of weekly rate-limit utilization — cost-weighted, integer-rounded,
 * not dollars. Blank cells in the file are null.
 */
export interface SurfaceRow {
  as_of: string;
  window_started_at: string;
  claude_code_pct: number | null;
  chat_pct: number | null;
  cowork_pct: number | null;
  other_pct: number | null;
  weekly_all_pct: number | null;
  weekly_scoped_model: string;
  weekly_scoped_pct: number | null;
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
  /** `cache_write_tokens` split by the lifetime it was written with
   *  (nightshift backlog 063) — Anthropic's `cache_creation` object. Absent
   *  where the host reports no split, and on every log before the fields. */
  cache_write_5m_tokens?: number;
  cache_write_1h_tokens?: number;
}

/** How long a prompt-cache entry lives from the start of the request that
 *  wrote or last read it — the API's own suffixes, as the log spells them. */
export type CacheTtl = "5m" | "1h";

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

/**
 * What a chat was started as (nightshift backlog 059, 2026-09-15). Fixed at
 * its birth: `incognito` is kept and listed, marked, writes nothing and no
 * other chat can read it; `ephemeral` drops all of that and the log too, so
 * it is never listed and is gone when closed. Absent on the wire means
 * `normal` — every log written before the field existed.
 */
export type ChatMode = "normal" | "incognito" | "ephemeral";

/**
 * What a chat is *for* (nightshift backlog 102, 2026-09-16), the axis
 * orthogonal to `ChatMode` and fixed at birth like it (blocker 143's
 * default). `build` is every chat before the field existed: the project
 * folder, every tool, approval as set — on the subscription engine the UI
 * calls it *Claude Code*, on the provider engine *Build*. `chat` is the
 * conversational one — the read-only tools plus Nightloom's own, the web,
 * no working folder (it runs in `~/.nightloom/chat/`), and the Chat
 * instructions layer (`~/.nightloom/CHAT.md`). Absent on the wire means
 * `build`.
 */
export type ChatKind = "build" | "chat";

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
  /** Absent for a normal chat; `incognito` marks the row. An ephemeral chat
   *  has no log and is never in a listing. */
  mode?: ChatMode;
  /** Absent for a build chat; `chat` marks the row (nightshift backlog 102). */
  kind?: ChatKind;
  /** The chat this one was forked from, when it was (nightshift backlog
   *  062): the parent's id and the position in the parent's log the fork
   *  was cut at. The row shows "from <parent>"; see `forkLine` in edit.ts. */
  forked_from?: ForkedFrom;
}

/** Where a fork came from — the parent's id and the cut, as the creation
 *  line carries them. */
export interface ForkedFrom {
  session: string;
  index: number;
  /** `"handoff"` for a chat that continues a full one from HANDOFF.md
   *  (nightshift backlog 086); absent on an edit-and-send fork. */
  reason?: string;
}

/** A session that matched a search. Flattened on the Rust side, so it is a
 *  `SessionMeta` with the two extra fields rather than a wrapper. */
export interface SessionHit extends SessionMeta {
  /** How many messages contain the query. */
  hits: number;
  /** Text around the first one, prefixed with who said it. */
  excerpt: string;
}

// ---- search everywhere (nightshift backlog 117, with 106's second half) ----
// Mirrors `store/search.rs`: the panel's answer, per message grouped by
// chat, and per line grouped by note.

/** Which chats and notes the panel looks through: the sidebar's directory,
 *  every project's chats plus the unfiled ones, or the open project's notes
 *  and the vault. */
export type SearchScope = "this" | "all" | "notes";

export interface ProjectRef {
  id: string;
  name: string;
}

/** One matching message. The passage arrives already split around the
 *  first hit, so the panel marks it with no offset arithmetic. */
export interface ChatRow {
  /** The message's position in its log — the transcript's `data-turn`. */
  index: number;
  /** `you`, the model's id, or `name` for a hit in the chat's title. */
  who: string;
  /** ISO8601 */
  at: string;
  before: string;
  matched: string;
  after: string;
  /** Hits in this message; the row says "3 matches" past one. */
  matches: number;
}

/** A chat with hits: its summary, flattened, plus the rows. */
export interface ChatGroup extends SessionMeta {
  /** Set under *all chats* for a chat from another project (blocker 154):
   *  the group carries its pill and a jump switches to it. */
  project?: ProjectRef;
  /** Hits across the chat. */
  hits: number;
  rows: ChatRow[];
}

export interface NoteRow {
  /** 1-based, the editor's numbering. */
  line: number;
  before: string;
  matched: string;
  after: string;
  matches: number;
}

export interface NoteGroup {
  scope: NoteScope;
  name: string;
  /** ISO8601 */
  modified: string;
  hits: number;
  rows: NoteRow[];
}

/** The answer, with the counts the count line reads —
 *  `14 matches in 9 messages · 4 chats · 0.2 s`. */
export interface SearchResult {
  /** Every hit, counted past the row limit. */
  matches: number;
  /** Matching messages and note lines. */
  messages: number;
  /** Matching chats and notes. */
  chats: number;
  /** Rows actually returned; under `messages` when capped. */
  shown: number;
  elapsed_ms: number;
  groups: ChatGroup[];
  notes: NoteGroup[];
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
  /** The folder the call reaches for outside every folder the chat may
   *  see (nightshift backlog 143, pass 2): the card offers to grant it,
   *  for this chat or the project. Only on a Claude Code deferred call. */
  outside?: string;
}

export type ApprovalDecision = "allow" | "always" | "deny";

/** The approval card's folder grant (backlog 143, pass 2): the folder and
 *  who keeps it — the chat's log, or the project's registry. */
export interface FolderGrant {
  dir: string;
  scope: "chat" | "project";
}

/**
 * One question of the CLI's `AskUserQuestion` tool, as its `input.questions`
 * carries it (verbatim shape measured 2026-09-16, nightshift backlog 084).
 */
export interface AskQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

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
  | { event: "session_created"; id: string; at: string; mode?: ChatMode; kind?: ChatKind; forked_from?: ForkedFrom }
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
      // When the request that produced this message was sent — the origin of
      // its cache's lifetime — and how long that cache lives (nightshift
      // backlog 063). Both absent on logs written before the fields; the
      // lifetime also absent when the request touched no cache.
      sent_at?: string;
      cache_ttl?: CacheTtl;
      at: string;
    }
  // Supersedes events `to..` up to this marker. The log keeps them, so the
  // UI can show what was dropped; see `liveFlags` in state.svelte.ts.
  | { event: "rewind"; to: number; at: string }
  // Lifts the `rewind` at `of` (nightshift backlog 064): what it superseded
  // counts again, markers in its range included. A marker rather than the
  // rewind line struck, since every later index-carrying marker would move.
  | { event: "unrewind"; of: number; at: string }
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
  // transcript skips it. See `promptLayersOff` in state.svelte.ts. `edits`
  // (2026-09-15) is the chat's own text per layer — the file's body as this
  // chat should read it — for the three editable kinds; absent in every
  // line written before it existed and when there is none. See
  // `promptLayerEdits`.
  | { event: "prompt_layers"; off: PromptLayer[]; edits?: PromptLayerEdits; at: string }
  // The chat is the other kind from here on (nightshift backlog 144):
  // latest live one wins, like a title, so a rewind past it restores the
  // kind before it; the creation line keeps what the chat was born as.
  // Not a turn: the backend reads it at connect time as the policy over a
  // declaration that does not change (`declaredKind`), and the next
  // message carries a note to the model. `workspace` is the folder a
  // switch to Claude Code named, when it named one. See `chatKind`.
  | { event: "kind"; kind: ChatKind; workspace?: string; at: string }
  // The extra folders this chat may see on top of its project's (nightshift
  // backlog 143): the whole list, latest live one wins like `prompt_layers`.
  // Not a turn: read at connect time and granted on the engine in use. See
  // `chatFolders`.
  | { event: "folders"; folders: string[]; at: string }
  // Content markers, not deletions: the listed events keep their place in the
  // conversation and project a stand-in instead of their payload. The log
  // still holds the content. ~~The transcript renders these turns in full
  // and only the context panel cares~~ — since 2026-09-15 (backlog 062) the
  // transcript draws a removed turn as its placeholder, greyed, with the
  // original a click away (`elideFlags` in edit.ts).
  // With `block` (nightshift backlog 066) the marker names one block of
  // the reply at `targets[0]` — an index into its `blocks` — rather than
  // the event: a text block, or a tool call with the result that answers
  // it (which follows the call by id and is never named on its own). See
  // `blockElisions` in edit.ts. Absent on every line written before.
  | { event: "elide"; targets: number[]; block?: number; at: string }
  | { event: "unelide"; targets: number[]; block?: number; at: string }
  // The event at `target` says `text` from here on (nightshift backlog
  // 062): a marker like `elide`, the original kept in the log for the
  // transcript to unfold. The latest live one on an index wins; a rewind
  // past it restores the original. See `editTexts` in edit.ts. `block`
  // (backlog 066) is which text block of a reply says it, as an index into
  // the reply's `blocks`; absent on a user message and on a reply edited
  // before the field existed, which reads as its first text block. See
  // `blockEdits`.
  | { event: "edit"; target: number; block?: number; text: string; at: string }
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
  | { type: "usage"; usage: Usage }
  /** What the Claude Code session has, from the CLI's `system/init` line —
   *  the first event of every turn on that engine (nightshift backlog 077). */
  | ({ type: "agent_init" } & AgentInit)
  /** The CLI's predicted next prompt, after the result (nightshift backlog
   *  083); the composer's ghost line. */
  | { type: "prompt_suggestion"; text: string }
  /** An event of a subagent's own turn on the Claude Code engine, carrying
   *  the id of the `Agent` call that spawned it (nightshift backlog 075);
   *  `event` is the child's text, thinking, call or result as the main
   *  thread's would be, and nests under that call's row. */
  | { type: "subagent"; parent_tool_use_id: string; event: TurnEvent }
  /** A subagent's standing, whole, each time it changes (nightshift
   *  backlog 152): the CLI's task lines and each new round of the child's,
   *  keyed by the spawning call. The Running-tasks panel's row. */
  | ({ type: "subagent_status" } & SubagentStatus);


/**
 * One row of Settings → Council's table (nightshift backlog 149): a
 * council turn as its `<council>` record and its chat name it.
 */
export interface CouncilTurnRow {
  session: string;
  title: string;
  at: string;
  mode: "answer" | "disproof";
  seats: string[];
  tokens: number;
  cost_usd: number | null;
  shared_by_all: number;
  fired: boolean;
}

/** A provider's remaining credit, where its API exposes one (backlog 149). */
export interface ProviderCredit {
  kind: string;
  /** `available`, `not exposed`, `no key`, or `error`. */
  status: string;
  /** Dollars left, when `available`. */
  remaining_usd?: number | null;
  /** Dollars used on the key, when the endpoint says. */
  used_usd?: number | null;
  detail?: string | null;
}

/** One subagent as the translator keeps it (backlog 152). `tokens` is the
 *  CLI's own figure — the latest round's whole request and response, the
 *  Claude app's number; `usage` the sum over the child's rounds. */
export interface SubagentStatus {
  tool_use_id: string;
  task_id: string;
  subagent_type: string;
  description: string;
  prompt: string;
  /** `running`, `completed`, `failed`, … as the CLI says. */
  status: string;
  background: boolean;
  model?: string;
  tokens: number;
  tool_uses: number;
  duration_ms: number;
  usage: Usage;
  rounds: number;
}

/** An aside's answer (nightshift backlog 081): the model's text, off the
 *  chat's warm cache, recorded nowhere. */
export interface AsideResult {
  answer: string;
  /** The CLI's estimate of the API cost — not a bill under a subscription. */
  cost_usd: number | null;
  /** Tokens of the chat's prefix the aside read back from cache. */
  cache_read: number;
  is_error: boolean;
  notices: string[];
}

/** A piece of an aside's answer as it streams (nightshift backlog 128),
 *  the `aside-delta` event: `seq` names the card it belongs to. */
export interface AsideDelta {
  seq: number;
  text: string;
}

/** One MCP server as the CLI's init line lists it: `connected`, `pending`,
 *  `needs-auth`, or `failed` with an error. */
export interface McpServer {
  name: string;
  status: string;
  error?: string;
}

/**
 * The CLI's `system/init` line, as the Context page's *This session* pane
 * shows it (nightshift backlog 077): MCP servers with status, the tool
 * names (built-in and `mcp__…`), the skills, the slash commands (the skills
 * first, then the built-ins), the agents, the CLI version and the
 * permission mode. Under safe mode the lists are honestly short.
 */
export interface AgentInit {
  session_id: string | null;
  model: string | null;
  version: string | null;
  permission_mode: string | null;
  tools: string[];
  mcp_servers: McpServer[];
  slash_commands: string[];
  skills: string[];
  agents: string[];
}

/** Claude Code's own system prompt, read from the CLI's session file
 *  (`prompt_snapshot`); null before the first turn or with no file. */
export interface CliPromptSnapshot {
  sections: string[];
  path: string;
}

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
  /** How a Chat talks — `~/.nightloom/CHAT.md`, read into a chat of the
   *  Chat kind and no other (nightshift backlog 102). Both engines. */
  | "chat_instructions"
  | "project_instructions"
  | "project_notes"
  | "knowledge"
  | "engine_note"
  /** Claude Code's own auto memory for the chat's folder (nightshift backlog
   *  088): a switch only — the CLI reads the file itself, and off is sent
   *  to it as a setting. Claude Code engine only. */
  | "cli_memory";

/** What `cli_memory_file` returns: the CLI's `MEMORY.md` for the built cwd,
 *  `text` null when there is none, and the topic files beside it by name. */
export interface CliMemoryFile {
  path: string;
  text: string | null;
  others: string[];
}

/**
 * The layers whose text a chat may replace with its own (nightshift backlog
 * 057): the three that are a file the user wrote. The indexes, the identity
 * and environment, and the engine note are not text a user edits.
 */
export type EditableLayer =
  | "user_memory"
  | "model_instructions"
  | "chat_instructions"
  | "project_instructions";
export const EDITABLE_LAYERS: readonly EditableLayer[] = [
  "user_memory",
  "model_instructions",
  "chat_instructions",
  "project_instructions",
];

/** A chat's own text per layer, by the backend's `SegmentKind` name. */
export type PromptLayerEdits = Partial<Record<EditableLayer, string>>;

/**
 * The open chat's switched-off layers and its own texts, beside the set and
 * the texts the live engine was built with; either pair differing is a
 * reconnect due.
 */
export interface PromptLayersInfo {
  off: PromptLayer[];
  built: PromptLayer[];
  edits: PromptLayerEdits;
  built_edits: PromptLayerEdits;
  /** The open chat's mode and the one the engine was built for — the third
   *  pair, compared like the other two (2026-09-15). */
  mode: ChatMode;
  built_mode: ChatMode;
  /** The fourth pair (nightshift backlog 102): a Chat's engine has the
   *  read-only tools, no folder and the Chat instructions; a Build chat
   *  opened after it needs its folder and tools back. */
  kind: ChatKind;
  built_kind: ChatKind;
}

/** What `editContext` changed: both projections, plus how many items moved. */
/**
 * What `edit_message`, `remove_message` and `fork_session` return: the
 * transcript of the chat now open and its id. `forked` says a fork was
 * made — the id is then the fork's, and the caller sends the edited text
 * as its next turn.
 */
export interface MessageEdit {
  events: SessionEvent[];
  session: string;
  forked: boolean;
}

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

/** The Settings → Remote card's read (nightshift backlog 091, Shape B):
 *  the phone page's listener — on or off, the tailnet address it binds
 *  (null when Tailscale is not up), the port, the keep-awake switch, and
 *  the bearer token as text, as the QR's URL and as the QR itself. */
export interface RemoteStatus {
  on: boolean;
  address: string | null;
  port: number;
  keep_awake: boolean;
  has_token: boolean;
  token: string | null;
  setup_url: string | null;
  qr_svg: string | null;
}
