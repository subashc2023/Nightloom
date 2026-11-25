/**
 * An aside's Rewind with its Undo toast (backlog 283, item 724), moved here
 * from `AsideTranscript.svelte` by item 966 so the message menu's Rewind and
 * a `/rewind` typed in the aside's box run the one path.
 */
import { addToast, restoreAsideTurns, rewindAside, setAsideUnsent, type Aside } from "./state.svelte";
import { scheduleAsideSave } from "./asides.svelte";
import { asideDraftKey } from "./asides";
import { dismissRewoundOffer, rewoundOffer } from "./rewindDraft.svelte";

/** Exchange `i` and the later ones leave; its question goes back into the
 *  aside's box. Undo on the notice. False when nothing went. */
export function rewindAsideWithUndo(aside: Aside, i: number): boolean {
  const before = aside.unsent ?? "";
  const offered = rewoundOffer.seq;
  const gone = rewindAside(aside, i);
  if (gone.length === 0) return false;
  scheduleAsideSave();
  const after = aside.unsent ?? "";
  const n = gone.length;
  // Item 724: a draft in the box stayed; the question is in its drafts.
  const where = rewoundOffer.seq !== offered ? "your draft stayed; the question is in drafts, above the box" : "the question is back in the box";
  addToast(n === 1 ? `Rewound 1 exchange — ${where}` : `Rewound ${n} exchanges — ${where}`, {
    label: "Undo",
    run: () => {
      dismissRewoundOffer(asideDraftKey(aside));
      if (!restoreAsideTurns(aside, i, gone)) {
        addToast("Not undone — the aside has moved on since");
        return;
      }
      // The box back as it was, if he has not typed since.
      if ((aside.unsent ?? "") === after) setAsideUnsent(aside, before);
      scheduleAsideSave();
    },
  });
  return true;
}
