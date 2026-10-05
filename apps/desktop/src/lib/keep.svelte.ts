/**
 * "Keep in project" (nightshift item 306), the stateful half: each
 * attachment's keep state for this window, by `keepKey`, and the press.
 * Not persisted: after a restart the chip offers Keep again, and pressing
 * it answers "Kept" with the file already there (the backend finds the
 * same bytes and writes nothing).
 */
import { keepAttachment } from "./api";
import { addToast, projectFilesChanged } from "./state.svelte";
import type { KeepState } from "./keep";

export const keeps = $state<Record<string, KeepState>>({});

export function keepStateOf(key: string): KeepState {
  return keeps[key] ?? { phase: "idle" };
}

/** Press Keep: copy into the open project's files, say where on the chip. */
export async function keepNow(
  key: string,
  name: string,
  mediaType: string,
  from: { data: string } | { path: string },
): Promise<void> {
  const now = keepStateOf(key);
  if (now.phase !== "idle") return;
  keeps[key] = { phase: "keeping" };
  try {
    const kept = await keepAttachment(name, mediaType, from);
    keeps[key] = { phase: "kept", rel: kept.rel };
    if (!kept.already) projectFilesChanged();
    addToast(
      kept.already
        ? `${name} was already in this project's files, as ${kept.rel}`
        : `Kept ${name} in this project's files, as ${kept.rel} — new chats here can read it`,
    );
  } catch (e) {
    delete keeps[key];
    addToast(`Could not keep ${name}: ${String(e)}`);
  }
}
