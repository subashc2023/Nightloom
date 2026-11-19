/*
 * Item 801: how the Mac's window asks for Listen and Brief — the Tauri
 * commands (`listen.rs`): the host's Piper voice, and the Brief's one-shot
 * turn on the agent binary and safe mode every turn here runs with. Since
 * item 862 the audio comes a part at a time.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Source } from "./listen";
import { app } from "./state.svelte";

export function briefHere(text: string): Promise<string> {
  return invoke<string>("listen_brief", {
    text,
    binary: app.draft.agentBinary.trim() || undefined,
    safeMode: app.draft.agentSafeMode,
  });
}

export const here: Source = {
  brief: briefHere,
  async part(text, i) {
    const [bytes, parts] = await Promise.all([
      invoke<ArrayBuffer>("listen_audio", { text, part: i }),
      invoke<number>("listen_parts", { text }),
    ]);
    return { bytes, parts };
  },
};
