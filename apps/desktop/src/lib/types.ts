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
  system?: string;
  tools: boolean;
}

export interface ConnectResult {
  provider: string;
  model: string;
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

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      name: string;
      content: string;
      is_error?: boolean;
    };

export type SessionEvent =
  | { event: "session_created"; id: string; at: string }
  | { event: "user_message"; text: string; at: string }
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
  | { type: "round_limit"; rounds: number };
