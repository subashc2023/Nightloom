/*
 * A TeX log's first error, for a `.tex` tab's rendered side (nightshift
 * backlog 381). TeX writes an error as a line starting `! ` and, a few
 * lines on, the source line where it stopped as `l.<n> <the text so far>`.
 */
export type TexError = { message: string; line: number | null; context: string | null };

export function firstTexError(log: string): TexError | null {
  const lines = log.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith("! "));
  if (at < 0) return null;
  const message = lines[at].slice(2).trim();
  for (let i = at + 1; i < Math.min(lines.length, at + 40); i++) {
    if (lines[i].startsWith("! ")) break;
    const m = /^l\.(\d+)(?: (.*))?$/.exec(lines[i]);
    if (m) return { message, line: Number(m[1]), context: (m[2] ?? "").trimEnd() || null };
  }
  return { message, line: null, context: null };
}

/** Whether a file tab at `path` is LaTeX source that renders (`.tex`). */
export function isTexPath(path: string): boolean {
  return /\.tex$/i.test(path);
}
