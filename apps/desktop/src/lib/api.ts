import { invoke } from "@tauri-apps/api/core";
import type {
  ApprovalDecision,
  CompactResult,
  ConnectArgs,
  ConnectResult,
  ImageInput,
  ProviderInfo,
  SessionEvent,
  SessionMeta,
  TurnResult,
} from "./types";

// All backend errors reject with a plain string.

export function providers(): Promise<ProviderInfo[]> {
  return invoke("providers");
}

/** Store an API key in the OS credential store (empty key clears it). */
export function setApiKey(provider: string, key: string): Promise<null> {
  return invoke("set_api_key", { provider, key });
}

export function clearApiKey(provider: string): Promise<null> {
  return invoke("clear_api_key", { provider });
}

/** Model ids the provider's API currently offers. */
export function listModels(
  provider: string,
  baseUrl?: string,
): Promise<string[]> {
  return invoke("list_models", { provider, baseUrl });
}

export function connect(args: ConnectArgs): Promise<ConnectResult> {
  return invoke("connect", {
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    thinking: args.thinking,
    system: args.system,
    tools: args.tools,
    preamble: args.preamble,
    sidecar: args.sidecar,
    approval: args.approval,
    workspace: args.workspace,
  });
}

/**
 * Answer one `tool-approval` prompt. `reason` is handed to the model
 * verbatim on a denial, which is what lets it try something else instead of
 * repeating the call; it is ignored for the other decisions.
 */
export function approveCall(
  id: string,
  name: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<null> {
  return invoke("approve_call", { id, name, decision, reason });
}

export function listSessions(): Promise<SessionMeta[]> {
  return invoke("list_sessions");
}

export function newSession(): Promise<{ id: string }> {
  return invoke("new_session");
}

export function openSession(id: string): Promise<SessionEvent[]> {
  return invoke("open_session", { id });
}

export function transcript(): Promise<SessionEvent[]> {
  return invoke("transcript");
}

export function send(text: string, images?: ImageInput[]): Promise<TurnResult> {
  return invoke("send", { text, images });
}

export function cancel(): Promise<null> {
  return invoke("cancel");
}

/** Compact the active session (earlier turns superseded by a summary). */
export function compact(): Promise<CompactResult> {
  return invoke("compact");
}

/** Delete a session log; returns the deleted session's full id. */
export function deleteSession(id: string): Promise<string> {
  return invoke("delete_session", { id });
}
