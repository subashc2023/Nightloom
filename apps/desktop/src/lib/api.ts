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
