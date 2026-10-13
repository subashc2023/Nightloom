// A word-level diff of two texts, for the transcript's edited messages
// (nightshift backlog 105): the message drawn once, what the edit removed
// struck through and what it added marked — Google Docs' suggesting look
// rather than the whole earlier text folded underneath.
//
// Tokens are words (letters, digits, and the apostrophes and hyphens inside
// a word), runs of whitespace, and single other characters — punctuation on
// its own, so "removed." → "removed, and" strikes the full stop rather than
// the word. Everything is kept, so the ops reassemble either text exactly
// and an edit to spacing alone shows as a change to the spacing, not to the
// words around it. The alignment is
// the longest common subsequence by dynamic programming — O(n·m) in the
// token counts, which is nothing for a chat message and is capped below so
// a pasted book cannot hang the transcript.

export type DiffOp = { kind: "same" | "del" | "add"; text: string };

/** Past this many token pairs the diff is one removal and one insertion —
 *  still a correct diff, just not a fine one. */
export const LCS_LIMIT = 4_000_000;

export function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu) ?? [];
}

export function wordDiff(before: string, after: string): DiffOp[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];
  const aAll = tokenize(before);
  const bAll = tokenize(after);
  // The common head and tail come off first: an edit is usually a few
  // words inside a long message, and the table below is only ever built
  // over the part that differs. Before this (2026-09-16), a reply past
  // ~2000 tokens hit the cap and a two-word deletion at its end showed
  // as the whole reply struck and added back.
  let head = 0;
  while (head < aAll.length && head < bAll.length && aAll[head] === bAll[head]) head++;
  let tail = 0;
  while (
    tail < aAll.length - head &&
    tail < bAll.length - head &&
    aAll[aAll.length - 1 - tail] === bAll[bAll.length - 1 - tail]
  )
    tail++;
  const a = aAll.slice(head, aAll.length - tail);
  const b = bAll.slice(head, bAll.length - tail);
  const same = (tokens: string[]): DiffOp[] => (tokens.length ? [{ kind: "same", text: tokens.join("") }] : []);
  const headOps = same(aAll.slice(0, head));
  const tailOps = same(aAll.slice(aAll.length - tail));
  if (a.length * b.length > LCS_LIMIT) {
    return merge([
      ...headOps,
      { kind: "del", text: a.join("") },
      { kind: "add", text: b.join("") },
      ...tailOps,
    ]);
  }
  // lcs[i][j]: the length of the longest common subsequence of a[i..] and
  // b[j..], filled from the end so the walk below reads forward.
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ kind: "del", text: a[i]! });
  for (; j < m; j++) ops.push({ kind: "add", text: b[j]! });
  return merge([...headOps, ...coalesce(ops), ...tailOps]);
}

/**
 * A run of changes with only whitespace in common is one change: "two
 * heads" → "six features" reads as the old phrase struck and the new one
 * added, not as two words swapped around a space that survived. Every
 * whitespace token that sits between two changed tokens joins both sides.
 */
function coalesce(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === "same") {
      out.push(ops[i]!);
      i++;
      continue;
    }
    let del = "";
    let add = "";
    let j = i;
    while (j < ops.length) {
      const op = ops[j]!;
      if (op.kind === "del") del += op.text;
      else if (op.kind === "add") add += op.text;
      else if (/^\s+$/.test(op.text) && j + 1 < ops.length && ops[j + 1]!.kind !== "same") {
        del += op.text;
        add += op.text;
      } else break;
      j++;
    }
    if (del) out.push({ kind: "del", text: del });
    if (add) out.push({ kind: "add", text: add });
    i = j;
  }
  return out;
}

/** Adjacent ops of one kind joined, empty ones dropped. */
function merge(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    if (!op.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === op.kind) last.text += op.text;
    else out.push({ ...op });
  }
  return out;
}

/** Whether any op is a change — false when the texts differ by nothing. */
export function hasChange(ops: readonly DiffOp[]): boolean {
  return ops.some((op) => op.kind !== "same");
}
