/*
 * Item 801: how the Mac's window asks for Listen and Brief — the Tauri
 * commands (`listen.rs`): the host's Piper voice, and the Brief's one-shot
 * turn on the agent binary and safe mode every turn here runs with.
 */
import { invoke } from "@tauri-apps/api/core";
import { app } from "./state.svelte";

export function briefHere(text: string): Promise<string> {
  return invoke<string>("listen_brief", {
    text,
    binary: app.draft.agentBinary.trim() || undefined,
    safeMode: app.draft.agentSafeMode,
  });
}

export async function makeHere(text: string, brief: boolean): Promise<{ blob: Blob; words?: string }> {
  const words = brief ? await briefHere(text) : undefined;
  const bytes = await invoke<ArrayBuffer>("listen_audio", { text: words ?? text });
  return { blob: new Blob([bytes], { type: "audio/wav" }), words };
}
