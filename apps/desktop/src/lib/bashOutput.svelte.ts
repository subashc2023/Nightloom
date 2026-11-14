// Item 633: a running Bash command's latest output lines, by call id — the
// trace's passing text (Combo and Reticle). Fed by the backend's live-only
// `tool_output` event (read from the CLI's own spool of the command's
// output, ~3 updates a second at most); dropped at the call's result, so
// nothing here outlives the command or is ever saved.

/** Lines a row keeps (the backend sends at most this many). */
export const PASSING_LINES = 6;

const live = $state<Record<string, string[]>>({});

/** The command's latest lines, or none. */
export function passingLines(toolUseId: string): string[] {
  return live[toolUseId] ?? [];
}

/** A `tool_output` event: the call's lines, whole. */
export function setPassing(toolUseId: string, lines: string[]): void {
  if (!toolUseId || ending[toolUseId]) return;
  live[toolUseId] = lines.slice(-PASSING_LINES);
}

/** ~~The call ended (its result or refusal): its passing text goes.~~
 *  Item 649 (2026-11-11, his "what happened to bash showing a remnant of
 *  like the command stuff it was doing"): most commands end before the
 *  backend's first look at their spool (300 ms), so the text never showed.
 *  Now a shell call's end leaves a **remnant** — its output's last lines
 *  (from the result, which holds all of it; else what passed live) — that
 *  fades over `LINGER_MS` and goes. A refusal, or a call with no output,
 *  leaves nothing. */
export const LINGER_MS = 2400;

const ending = $state<Record<string, true>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Whether the call has ended and its remnant is fading. */
export function passingEnded(toolUseId: string): boolean {
  return ending[toolUseId] === true;
}

/** Pure: a command's output as a terminal's last lines show it — the
 *  backend's `bash_tail::last_lines` rule: a carriage return keeps what
 *  follows it, escapes go, blank lines go, each line cut at 160. */
export function lastLines(text: string, n: number = PASSING_LINES): string[] {
  const out: string[] = [];
  const raw = text.split("\n");
  for (let i = raw.length - 1; i >= 0 && out.length < n; i--) {
    const shown = raw[i]!.replace(/\r+$/, "").split("\r").pop() ?? "";
    // eslint-disable-next-line no-control-regex
    const clean = shown.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]/g, "").trimEnd();
    if (!clean.trim()) continue;
    out.push([...clean].slice(0, 160).join(""));
  }
  return out.reverse();
}

/** The call ended. `result`: a shell call's output, for its remnant; omit
 *  it (a refusal, a non-shell call) and the passing text goes at once. */
export function endPassing(toolUseId: string, result?: string): void {
  if (!toolUseId) return;
  const prior = timers.get(toolUseId);
  if (prior) clearTimeout(prior);
  timers.delete(toolUseId);
  const tail = result != null ? lastLines(result) : [];
  const lines = tail.length ? tail : result != null ? (live[toolUseId] ?? []) : [];
  if (!lines.length) {
    if (toolUseId in live) delete live[toolUseId];
    if (toolUseId in ending) delete ending[toolUseId];
    return;
  }
  live[toolUseId] = lines;
  ending[toolUseId] = true;
  timers.set(
    toolUseId,
    setTimeout(() => {
      timers.delete(toolUseId);
      delete live[toolUseId];
      delete ending[toolUseId];
    }, LINGER_MS),
  );
}

/**
 * Item 649: a turn event's part in the passing text, for every stream that
 * draws a trace (the chat's and an aside's): `tool_output` sets it (true:
 * nothing else to do with the event); a result or refusal ends it.
 */
export function passingEvent(ev: { type: string; tool_use_id?: string; lines?: string[]; name?: string; content?: string }, isShell: (name: string) => boolean): boolean {
  if (ev.type === "tool_output") {
    setPassing(ev.tool_use_id ?? "", ev.lines ?? []);
    return true;
  }
  if (ev.type === "tool_result") endPassing(ev.tool_use_id ?? "", ev.name && isShell(ev.name) ? (ev.content ?? "") : undefined);
  else if (ev.type === "tool_denied") endPassing(ev.tool_use_id ?? "");
  return false;
}
