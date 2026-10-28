/**
 * What a text paste becomes in a message box (item 399): one reading for
 * the composer and the edit box of one of his messages, so pasted code or
 * math lands the same in either. His bug: "When editing a message if i copy
 * in code it doesnt render it as code, neither in the edit screen or even
 * when i click send" — the edit box had only the math case (item 348).
 *
 * In order, as the composer has always read a paste:
 * - a clipboard holding files is not a text paste (`files`);
 * - math copied from a web page (KaTeX, MathJax) goes in as its LaTeX
 *   (item 348, `mathPasteText`);
 * - code goes in fenced with its language (item 315, `codePasteLanguage`:
 *   not a long paste, not inside a fence already there);
 * - anything else is the browser's own paste (`plain`).
 *
 * Text copied with images in it (item 382) is read before this, by the
 * caller, since its images need the caller's chips.
 */
import { codePasteLanguage, fenced } from "./codeDetect";
import { mathPasteText } from "./mathPaste";
import { normalizeNewlines } from "./pasteAttach";

export type TextPastePlan =
  | { kind: "files" }
  | { kind: "math"; text: string }
  | { kind: "code"; raw: string; lang: string }
  | { kind: "plain" };

export function textPastePlan(p: {
  plain: string;
  html: string;
  fileCount: number;
  /** The box's text and where the paste lands (the selection's start). */
  text: string;
  caret: number;
}): TextPastePlan {
  if (p.fileCount > 0) return { kind: "files" };
  const math = mathPasteText(p.html);
  if (math !== null) return { kind: "math", text: normalizeNewlines(math) };
  if (p.plain) {
    const lang = codePasteLanguage(p.plain, p.text, p.caret);
    if (lang) return { kind: "code", raw: normalizeNewlines(p.plain), lang };
  }
  return { kind: "plain" };
}

/** One undo step's result: the box's text and where the caret goes. */
export interface PasteStep {
  text: string;
  caret: number;
}

/**
 * A paste of `raw` in place of `[from, to)` of `text`, as the steps of the
 * box's own undo history (blocker 1210's `BoxHistory`): the paste as it
 * came, then — given `lang` — that stretch replaced by its fenced form, so
 * ⌘Z right after gives back the raw paste (item 315). WebKit's own undo
 * cannot keep these apart: it folds script inserts into the typing before
 * them (measured for item 399), so both boxes record these steps
 * themselves. The pasted characters are not touched; the fence adds lines
 * round them.
 */
export function pasteSteps(text: string, from: number, to: number, raw: string, lang: string | null = null): PasteStep[] {
  const before = text.slice(0, from);
  const after = text.slice(to);
  const steps: PasteStep[] = [{ text: before + raw + after, caret: from + raw.length }];
  if (lang) {
    const block = fenced(raw, lang, before, after);
    steps.push({ text: before + block + after, caret: from + block.length });
  }
  return steps;
}
