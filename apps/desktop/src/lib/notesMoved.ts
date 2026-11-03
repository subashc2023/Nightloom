/**
 * Item 483: the moves a chat's `move_notes` (item 472) made, read from the
 * tool's own answer, so the window can carry an open tab, the open note and
 * an unsaved draft of each moved note to its new name (`followNoteMove`).
 *
 * The tool answers `moved N:` and one `<from> → <landed>` line per move;
 * when a move fails part-way it answers `stopped at …` and, after
 * `moved before it:`, the moves that did land — those are followed too, so
 * a part-way failure leaves nothing behind under an old name. A batch the
 * tool refused whole (`nothing was moved:`) moved nothing; its problem lines
 * also hold arrows and are never read as moves.
 */

/** Whether a call's name is the notes tool's: `move_notes` on the API
 *  engine, `mcp__nightloom__move_notes` on the Claude Code engine. */
export function isMoveNotesTool(name: string | undefined | null): boolean {
  return name === "move_notes" || (typeof name === "string" && name.endsWith("__move_notes"));
}

const ARROW = " → ";

/** The `[from, landed]` pairs a `move_notes` answer reports, in order. */
export function movesInAnswer(content: string): [string, string][] {
  const text = content.replace(/\r\n/g, "\n");
  let body: string | null = null;
  const done = /^\s*moved \d+:\n/.exec(text);
  if (done) body = text.slice(done[0].length);
  else {
    const at = text.indexOf("\nmoved before it:\n");
    if (at >= 0) body = text.slice(at + "\nmoved before it:\n".length);
  }
  if (body === null) return [];
  const out: [string, string][] = [];
  for (const raw of body.split("\n")) {
    // The Claude Code CLI may wrap an error's text in a tag.
    const line = raw.replace(/<\/?tool_use_error>/g, "").trim();
    const parts = line.split(ARROW);
    // A name holding the arrow itself is ambiguous: left alone rather
    // than guessed (the panel re-reads at the turn's end either way).
    if (parts.length !== 2) continue;
    const [from, to] = [parts[0].trim(), parts[1].trim()];
    if (from && to && from !== to) out.push([from, to]);
  }
  return out;
}
