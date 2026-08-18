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
  /** Root for the file tools and project-instruction discovery. */
  workspace?: string;
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
  /** Where the backend actually rooted the tools, after falling back. */
  workspace: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
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
 * A composer attachment: an `ImageInput` plus what the thumbnail strip needs
 * to identify it. Only the `ImageInput` half crosses the IPC boundary.
 */
export interface Attachment extends ImageInput {
  id: number;
  name: string;
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
  // `images` is absent, not empty, on messages logged without any — including
  // every message logged before images existed.
  | { event: "user_message"; text: string; images?: ImageInput[]; at: string }
  | {
      event: "assistant_message";
      model: string;
      blocks: ContentBlock[];
      stop_reason: string | null;
      usage: Usage;
      at: string;
    }
  | {
      event: "tool_result";
      tool_use_id: string;
      name: string;
      content: string;
      is_error?: boolean;
      at: string;
    }
  | { event: "todo_state"; todos: TodoItem[]; at: string }
  | { event: "compaction"; summary: string; at: string };

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
