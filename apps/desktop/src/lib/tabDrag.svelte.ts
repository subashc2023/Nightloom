/**
 * The tab drag in progress (nightshift backlog 195), shared between the
 * strip that started it (`TabStrip.svelte`: the ghost and the slot marker)
 * and `App.svelte` (the pane half a split or a move would land in).
 * `app.draggingTab` is set alongside, so the web tab's child webview steps
 * aside while a tab is dragged, as it did for the native drag.
 */
import type { TabDropPlan, TabDropTarget } from "./tabDrag";

export const tabDrag = $state({
  /** The tab being dragged; null when none is. */
  id: null as string | null,
  /** The pointer, in the window. */
  x: 0,
  y: 0,
  target: null as TabDropTarget | null,
  plan: null as TabDropPlan | null,
});
