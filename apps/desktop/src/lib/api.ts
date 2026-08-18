import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectArgs,
  ConnectResult,
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
  });
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

export function send(text: string): Promise<TurnResult> {
  return invoke("send", { text });
}

export function cancel(): Promise<null> {
  return invoke("cancel");
}
