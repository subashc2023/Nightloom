/**
 * Item 839: the zoom level as state, so the top bar's chip ("90% · ⌘0")
 * follows every change. `zoom.ts` writes it on every apply; nothing else
 * does.
 */
export const zoomNow = $state({ level: 1 });
