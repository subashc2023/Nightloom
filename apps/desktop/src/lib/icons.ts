/**
 * The line icons the Nightshift screens draw, as the path data of a 20×20
 * viewBox. Inline SVG rather than a font or an image: they take the current
 * colour and the palette tokens with it. Rendered by `Icon.svelte`.
 */
export const ICONS = {
  chat: '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v6a2.5 2.5 0 0 1-2.5 2.5H8l-4 3v-3.2A2.5 2.5 0 0 1 3 11.5z"/>',
  note: '<path d="M5 3h7l4 4v10H5z"/><path d="M12 3v4h4M8 10h5M8 13h5"/>',
  moon: '<path d="M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5z"/>',
  search: '<circle cx="9" cy="9" r="5.5"/><path d="m13 13 4 4"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  chev: '<path d="m7 8 3 3 3-3"/>',
  chevl: '<path d="m12 6-4 4 4 4"/>',
  chevr: '<path d="m8 6 4 4-4 4"/>',
  ext: '<path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3M12 4h4v4M16 4l-7 7"/>',
  gear: '<circle cx="10" cy="10" r="2.5"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6 15 15M5 15l1.4-1.4M13.6 6.4 15 5"/>',
  play: '<path d="M6 4.5v11l9-5.5z"/>',
  revert: '<path d="M4 8h9a4 4 0 0 1 0 8H8M4 8l3-3M4 8l3 3"/>',
  check: '<path d="m4 10.5 4 4 8-9"/>',
  term: '<path d="M4 6l4 4-4 4M10 14h6"/>',
  cols: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M10 4v12"/>',
  // The chat-surface redesign (nightshift notes/runner-design/surface-redesign-2026-09-13).
  folder: '<path d="M3 6a1.5 1.5 0 0 1 1.5-1.5H8l2 2h5.5A1.5 1.5 0 0 1 17 8v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15z"/>',
  pencil: '<path d="m4 16 3.5-.7 8-8-2.8-2.8-8 8zM11.5 5.7l2.8 2.8"/>',
  key: '<circle cx="7" cy="12" r="3.5"/><path d="M9.5 9.5 16 3M13 6l2 2M11 8l2 2"/>',
  x: '<path d="M5 5l10 10M15 5 5 15"/>',
  /* Remove-from-context on a turn: a minus in a ring, not a bin — the
     message stays in the log (backlog 062, icons 2026-09-15). */
  minus: '<circle cx="10" cy="10" r="6.5"/><path d="M7 10h6"/>',
  lock: '<rect x="5" y="9" width="10" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
  refresh: '<path d="M16 10a6 6 0 0 1-10.4 4.1M4 10a6 6 0 0 1 10.4-4.1M14 3v3h-3M6 17v-3h3"/>',
  "eye-off": '<path d="M3 3l14 14M8.5 8.6A2 2 0 0 0 11.4 11.4M6.4 6.5C4.3 7.7 3 10 3 10s2.5 4.5 7 4.5c1.3 0 2.4-.3 3.4-.9M9 5.6c.3 0 .7-.1 1-.1 4.5 0 7 4.5 7 4.5s-.6 1.1-1.7 2.2"/>',
  download: '<path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M4 15h12"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6M8.5 9v4M11.5 9v4"/>',
  updown: '<path d="m7 8 3-3 3 3M7 12l3 3 3-3"/>',
} as const;

export type IconName = keyof typeof ICONS;
