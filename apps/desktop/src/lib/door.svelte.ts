// Item 767: the door's state in the window — which chats were started
// from outside (the sidebars' mark) and the Settings card's switch.
import * as api from "./api";
import type { DoorCard } from "./door";

export const door = $state({
  /** Chat id → who started it from outside. */
  startedBy: {} as Record<string, string>,
  /** The Settings card; null before it is read (or on an older backend). */
  card: null as DoorCard | null,
  /** Why the switch's last change did not take, in words. */
  problem: null as string | null,
});

let reading = false;
/** Re-read who started which chat. An older backend leaves it empty, quietly. */
export async function refreshDoorStarted(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    door.startedBy = await api.doorStarted();
  } catch {
    // An older backend.
  } finally {
    reading = false;
  }
}

/** Read the Settings card. */
export async function loadDoorCard(): Promise<void> {
  try {
    door.card = await api.doorCard();
    door.problem = null;
  } catch (e) {
    door.problem = String(e);
  }
}

/** The switch: read only (false) or start and message (true). */
export async function setDoorWrites(writes: boolean): Promise<void> {
  try {
    door.card = await api.doorSetWrites(writes);
    door.problem = null;
  } catch (e) {
    door.problem = String(e);
    await loadDoorCard();
  }
}
