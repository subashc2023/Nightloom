/**
 * Item 839: the zoom level as state, so the top bar's chip ("90% · ⌘0")
 * follows every change. `zoom.ts` writes it on every apply; nothing else
 * does.
 */
/** Item 876: `def` is his default level — what ⌘0 returns to and where the chip goes quiet. */
export const zoomNow = $state({ level: 1, def: 1 });
