/**
 * Item 700 (his words 2026-11-15: "the red should be reserved for like
 * serious errors or issues. yellow maybe for others?"): a tool error has a
 * weight. **Hard** (red, `--failed`) is a real failure — the tool ran and
 * failed. **Soft** (amber, `--partial`) is the harness's "not run, redo it"
 * notice: the call never ran, nothing is wrong with it, and the model is
 * told to issue it again (or to read the file first). Matched by text —
 * the CLI marks both kinds `is_error`.
 *
 * The notices, as Claude Code 2.1.325 words them (read from the binary's
 * strings, 2026-11-15):
 * - auto mode's classifier: "… gave no verdict …", "Auto mode classifier
 *   unavailable …", "… This is not a judgment that the action is unsafe …",
 *   "… a routine re-check, not an error and not a refusal …";
 * - "File has not been read yet. Read it first before writing to it.";
 * - "File has been modified since read, either by the user or by a linter.
 *   Read it again before attempting to write it.";
 * - the permission re-check: "… so this command was not run. Re-issue the
 *   command to have it checked afresh." / "… was not run: … Send the call
 *   again."
 *
 * A user's Deny is not an error weight at all: it keeps its own look (⊘,
 * "denied"), decided before this is asked.
 */

export type ErrorWeight = "soft" | "hard";

/** Which "not run" notice a soft error is, for its one folded line. */
export type SoftKind = "auto" | "unread" | "stale" | "recheck";

const SOFT: readonly [SoftKind, RegExp][] = [
  ["unread", /File has not been read yet/],
  ["stale", /File has been modified since read/],
  ["auto", /classifier (?:gave no verdict|unavailable)/i],
  ["auto", /(?:safety check|classifier)[^.]{0,80}gave no (?:verdict|result)/i],
  ["auto", /not a judgment that (?:the (?:action|call|message|task) |it )is unsafe/i],
  ["auto", /routine re-check, not an error/i],
  ["recheck", /was not run\b[\s\S]{0,400}?(?:Re-issue the command|Send the call again|checked afresh)/],
];

/** The notice a result is, or null when it is not one of the soft kind. */
export function softKind(content: string): SoftKind | null {
  for (const [kind, re] of SOFT) if (re.test(content)) return kind;
  return null;
}

/**
 * A result's weight: null when it is not an error (or there is no result
 * yet), else soft for a "not run, redo it" notice and hard for the rest.
 */
export function errorWeight(result: { content: string; is_error: boolean } | null | undefined): ErrorWeight | null {
  if (!result || !result.is_error) return null;
  return softKind(result.content) ? "soft" : "hard";
}

const LINE: Record<SoftKind, string> = {
  auto: "auto mode could not check this call — not run",
  unread: "the file was not read first — not run",
  stale: "the file changed since it was read — not run",
  recheck: "the permission check went stale — not run",
};

/** The soft box's folded line: what the notice said, in a few words, and
 *  whether the model issued the call again. */
export function softLine(content: string, retried: boolean): string {
  const k = softKind(content) ?? "auto";
  return retried ? `${LINE[k]}, retried` : LINE[k];
}

type CallLike = { name: string; input: unknown };
type SegLike = { kind: string; call?: CallLike };

/** Whether the model issued the same call again after the one at `i`
 *  (same tool, same input) — the soft notice's "retried". */
export function retriedAfter(segs: readonly SegLike[], i: number): boolean {
  const c = segs[i]?.call;
  if (!c) return false;
  const key = JSON.stringify(c.input ?? null);
  for (let j = i + 1; j < segs.length; j++) {
    const s = segs[j];
    if (s.kind === "tool" && s.call && s.call.name === c.name && JSON.stringify(s.call.input ?? null) === key) return true;
  }
  return false;
}
