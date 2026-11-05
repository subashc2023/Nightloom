/** The app's tokens as an xterm theme, read once at mount so the grid matches
 *  the window (`--term` is the ground the boards draw). Shared by his shells
 *  and the Agent commands view (item 503). */
export function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--term", "#131110"),
    foreground: v("--ink", "#ece7dc"),
    cursor: v("--accent", "#e0a458"),
    cursorAccent: v("--term", "#131110"),
    selectionBackground: v("--accent-soft", "#3a2d1c"),
    black: "#1b1916",
    brightBlack: v("--dim", "#8d8676"),
    red: v("--failed", "#e57373"),
    brightRed: "#f2bcbc",
    green: v("--done", "#7cc48a"),
    brightGreen: "#bfe6c4",
    yellow: v("--accent", "#e0a458"),
    brightYellow: v("--accent-ink", "#f0c27a"),
    blue: v("--live", "#7fb3f0"),
    brightBlue: "#a9ccf5",
    magenta: "#c9a3d6",
    brightMagenta: "#dcbfe6",
    cyan: "#7fc7c0",
    brightCyan: "#a8ddd8",
    white: v("--ink2", "#c9c2b3"),
    brightWhite: v("--ink", "#ece7dc"),
  };
}
