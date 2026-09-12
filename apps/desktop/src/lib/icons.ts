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
} as const;

export type IconName = keyof typeof ICONS;
