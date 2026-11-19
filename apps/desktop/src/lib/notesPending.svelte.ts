/*
 * Item 855: the Notes panel's pending rows, held outside the panel so a
 * drop that is still converting when he switches the sidebar to Chats (the
 * panel unmounts) shows its row again when he comes back, and its error
 * row waits for his dismiss (practices §7: every view keeps its state).
 * The pure moves are in `notesPending.ts`.
 */
import { addRows, dismissRow, endRow, failRow, type DropRows, type PendingNote } from "./notesPending";

let seq = 0;
export const pendingNotes = $state<{ rows: PendingNote[] }>({ rows: [] });

/** The rows of one drop into `folder` of the project `project` (its id). */
export function dropRows(project: string, folder: string): DropRows {
  return {
    start(files) {
      const { list, ids } = addRows(pendingNotes.rows, project, folder, files, () => ++seq);
      pendingNotes.rows = list;
      return ids;
    },
    fail(id, why) {
      pendingNotes.rows = failRow(pendingNotes.rows, id, why);
    },
    end(id) {
      pendingNotes.rows = endRow(pendingNotes.rows, id);
    },
  };
}

export function dismissPending(id: number): void {
  pendingNotes.rows = dismissRow(pendingNotes.rows, id);
}
