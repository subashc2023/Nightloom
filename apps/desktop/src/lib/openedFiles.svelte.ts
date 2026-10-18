/**
 * Finder's Open With → Nightloom (nightshift backlog 378): each file he
 * opens with Nightloom becomes a new tab — a note in the notes folder or
 * the vault in the note view (editable), anything else in a read-only file
 * tab. The backend keeps what arrived until the page takes it
 * (`opened_files.rs`), so a file that launched the app opens once the tabs
 * he left are back; one opened while it runs opens at once.
 *
 * Installed at the end of `init`, after `restoreTabs`, so a restored set of
 * tabs cannot land over the new one.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { openPathAsTab } from "./forYou.svelte";

let installed = false;

async function drain(): Promise<void> {
  let paths: string[];
  try {
    paths = await api.takeOpenedFiles();
  } catch {
    return;
  }
  for (const p of paths) await openPathAsTab(p, null, { finder: true });
}

export async function installOpenedFiles(): Promise<void> {
  if (installed) return;
  installed = true;
  // Listen first, then take: a file arriving between the two is taken by
  // one or the other, never lost.
  await listen("files-opened", () => void drain());
  await drain();
}
