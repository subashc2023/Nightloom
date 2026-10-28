/**
 * Pasted text as an attachment (item 284), shared by the composer and the
 * edit box of one of his messages (item 399b, his answer to blocker 1508:
 * "Yes to offer make this an attachment"): the "Pasted text" chip, ⌥⌘V's
 * mark on the next paste, and the long paste's conversion into a chip.
 * The pure rules (`longPasteOffer`, `followOffer`, `withoutSpan`,
 * `canUndo`) stay in `pasteAttach.ts`; this holds what touches the drafts
 * store, under whichever key the box keeps its chips.
 */
import { pasteIntoFocus } from "./api";
import { acceptFiles } from "./attachFiles.svelte";
import { readDraft, removeAttachment, updateAttachment } from "./drafts.svelte";
import { normalizeNewlines, pastedFile, pastedLabel, pastedName, withoutSpan, type LongPaste } from "./pasteAttach";
import { addToast } from "./state.svelte";
import type { Attachment } from "./types";

/** Pasted text as a chip under `key`, by item 277's text route: named
 *  "Pasted text", its words on the chip. `named` hears the name first
 *  (the composer's fade-in mark), `failed` if no chip came of it. */
export async function attachPastedText(
  key: string,
  raw: string,
  hooks: { named?: (name: string) => void; failed?: (name: string) => void } = {},
): Promise<Attachment | null> {
  const body = normalizeNewlines(raw);
  const name = pastedName(readDraft(key).attachments.map((a) => a.name));
  hooks.named?.(name);
  const [chip] = await acceptFiles(key, [pastedFile(body, name)]);
  if (!chip) {
    hooks.failed?.(name);
    return null;
  }
  updateAttachment(key, chip.id, {
    pasted: true,
    ...(chip.kind === "document" ? { label: pastedLabel(body) } : {}),
  });
  return chip;
}

/*
 * ⌥⌘V (blocker 941's default, 942's key): mark the next paste and ask the
 * backend for one — Edit ▸ Paste's own `paste:` — so the box's paste
 * handler gets the clipboard as a ⌘V would and makes its text a chip. Off
 * the Mac the clipboard is read here instead.
 */
export class AttachMark {
  private at = 0;
  constructor(private readonly ms = 1500) {}
  arm(): void {
    this.at = performance.now();
  }
  clear(): void {
    this.at = 0;
  }
  /** Whether the paste now landing was ⌥⌘V's; the mark is spent either way. */
  take(): boolean {
    const on = this.at > 0 && performance.now() - this.at < this.ms;
    this.at = 0;
    return on;
  }
}

export async function pasteAsAttachment(mark: AttachMark, attach: (text: string) => Promise<unknown>): Promise<void> {
  mark.arm();
  let asked = false;
  try {
    asked = await pasteIntoFocus();
  } catch {
    asked = false;
  }
  if (asked) return;
  mark.clear();
  try {
    const t = await navigator.clipboard.readText();
    if (t) await attach(t);
    else addToast("The clipboard holds no text to attach");
  } catch (e) {
    addToast(`Could not read the clipboard: ${String(e)}`);
  }
}

/** A history step that is a conversion, carrying its chip (blocker 1210):
 *  ⌘Z takes the chip away with the text, ⌘⇧Z brings both back. */
export interface ConvertTag {
  convert: true;
  chip: Attachment;
  before: string;
  after: string;
  caret: number;
}
export function isConvertTag(t: unknown): t is ConvertTag {
  return typeof t === "object" && t !== null && (t as { convert?: unknown }).convert === true;
}

/**
 * "Make this an attachment": the offer's span into a chip under `key`.
 * `read` is the box's text now (read again once the chip is made, since
 * the read can outlive his typing). Null when nothing changed: the span
 * was gone, the chip was refused (the toast said why), or he typed into
 * the span meanwhile (the chip is taken back, the text stays).
 */
export async function convertOffer(
  o: LongPaste,
  key: string,
  read: () => string | null,
  attach: (text: string) => Promise<Attachment | null>,
): Promise<{ chip: Attachment; before: string; after: string } | null> {
  const first = read();
  if (first === null || withoutSpan(first, o) === null) return null;
  const chip = await attach(o.pasted);
  if (!chip) return null;
  const now = read();
  const after = now === null ? null : withoutSpan(now, o);
  if (now === null || after === null) {
    removeAttachment(key, chip.id);
    return null;
  }
  return { chip, before: now, after };
}
