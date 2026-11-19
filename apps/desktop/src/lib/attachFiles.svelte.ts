/**
 * Files into chips (item 336, 2026-10-11): what the composer's paperclip,
 * paste and drop do with a file — the routes of `attachKinds.ts`, the
 * engine's caps, an office file's conversion behind a chip that says so —
 * moved out of `Composer.svelte` unchanged so that a message's edit box
 * attaches exactly as the composer does. Chips land in the drafts store
 * under the key given (a chat's box, or `editDraftKey` for an edit box);
 * a conversion finishing finds its chip by its unique id wherever it now
 * sits (`updateAttachment`, the wave 5 review fix 51798f5).
 */
import { app, addToast as toastNow } from "./state.svelte";
import { officeConverter, pdfPages, prepareOfficeAttachment, pruneDraftFiles, readDraftFile, stashDraftFile } from "./api";
import {
  convertedLabel,
  convertingLabel,
  decide,
  extOf,
  imageType,
  isLongPdf,
  looksLikeText,
  MAX_OFFICE_BYTES,
  notebookText,
  OFFICE_EXTS,
  pdfFileName,
  pdfRoute,
  routeOf,
  type Engine,
} from "./attachKinds";
import {
  addAttachment,
  draftFileIds,
  nextAttachmentId,
  readDraft,
  removeAttachment,
  settleStashed,
  stashedChips,
  updateAttachment,
} from "./drafts.svelte";
import type { Attachment } from "./types";
import { chipStep, type ChipTag } from "./chipSteps";
import { scheduledFileIds } from "./scheduled.svelte";
import { FEEDBACK_DRAFT_KEY, feedbackFileIdsIn } from "./feedbackText";
import { pickDocuments } from "./pick";

// Anthropic rejects a base64 image over ~10 MB and a PDF over ~32 MB, and
// nothing checks either before the wire, so the refusal has to happen here.
// base64 inflates by 4/3, and the caps apply to the encoded payload.
export const MAX_IMAGE_BASE64 = 10 * 1024 * 1024;
export const MAX_DOCUMENT_BASE64 = 32 * 1024 * 1024;
// Lower on the Claude Code engine, and not because the CLI refuses: it
// accepts the whole document on stdin and then, somewhere between it and
// the model, drops one over ~23 MiB encoded — exit 0, no error line, and
// a reply that asks which document you meant. Measured on 2.1.263: 22.7 MiB
// reached the model, 24.0 MiB did not. 20 MiB leaves a margin under the
// last size that worked, and a named refusal here is the only place that
// failure can be made loud. Images near their own cap went through.
export const MAX_AGENT_DOCUMENT_BASE64 = 20 * 1024 * 1024;
export const encodedLimit = (n: number) => Math.floor((n / 4) * 3);
// The API's pages per PDF (item 868): a deck past it is split into parts.
// The Claude Code engine reads a long PDF by path (item 491), so no page
// limit there.
export const MAX_API_PDF_PAGES = 100;

/** Exported for a dropped zip (item 414). */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      // The backend stores raw base64 and builds its own data URLs.
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function describe(file: File): string {
  return file.name || (file.type.startsWith("image/") ? "pasted image" : "pasted file");
}

// The cap for one attachment on the engine the rail is on right now.
// Checked at attach rather than at send because that is when the file is
// in hand and the toast can name it; a chip that would fail later is a
// promise the send would have to break.
function capFor(kind: "image" | "document"): number {
  if (kind === "image") return MAX_IMAGE_BASE64;
  return app.connection?.engine === "claude-code" ? MAX_AGENT_DOCUMENT_BASE64 : MAX_DOCUMENT_BASE64;
}

const engineNow = (): "claude-code" | "api" => (app.connection?.engine === "claude-code" ? "claude-code" : "api");

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Whether LibreOffice is installed, asked once a window (item 277). */
let converter: Promise<boolean> | null = null;
const hasConverter = () => (converter ??= officeConverter().catch(() => false));

/**
 * A long PDF's bytes on disk for its draft (item 491): the drafts store
 * keeps only small chips, so without this a relaunch would drop a deck of
 * 10+ pages. Best-effort, in the background: a chip whose stash failed
 * keeps today's rule (in memory only), and says nothing.
 */
function stashLong(chatKey: string, chip: Attachment): void {
  if (!isLongPdf(chip) || !chip.data) return;
  void stashDraftFile(chip.data)
    .then((stash) => {
      updateAttachment(chatKey, chip.id, { stash });
    })
    .catch(() => {});
}

/**
 * After a relaunch (item 491): the long PDFs the drafts store kept by their
 * copy on disk get their bytes back. Once a window; Send waits on each as
 * on a conversion. A copy gone from disk drops its chip and says so — the
 * text and his other chips stay.
 */
let restoring: Promise<void> | null = null;
export function restoreStashed(addToast: (text: string) => void = toastNow): Promise<void> {
  return (restoring ??= Promise.all(
    stashedChips().map(({ chip }) => {
      const job = readDraftFile(chip.stash!)
        .then((data) => settleStashed(chip, { data, pending: false }))
        .catch(() => {
          settleStashed(chip, null);
          addToast(`${chip.name} could not be brought back after the restart — attach it again`);
        });
      trackPending(chip.id, job);
      return job;
    }),
  ).then(() => {}));
}

/**
 * Item 491 follow-up: once a launch, after the restore, the copies in
 * `~/.nightloom/draft-files/` that no draft names and that are over 30 days
 * old are deleted (the backend's `prune_draft_files`, off the main thread).
 * A store that cannot be read prunes nothing.
 */
let pruned = false;
export async function pruneDraftCopies(): Promise<void> {
  if (pruned) return;
  pruned = true;
  await (restoring ?? Promise.resolve()).catch(() => {});
  const keep = draftFileIds();
  if (keep === null) return;
  // A scheduled message's files live in the same folder (backlog 531).
  keep.push(...scheduledFileIds());
  // And the feedback box's images (item 815), kept the same way.
  try {
    keep.push(...feedbackFileIdsIn(localStorage.getItem(FEEDBACK_DRAFT_KEY)));
  } catch {
    // no localStorage: no feedback draft
  }
  await pruneDraftFiles(keep).catch(() => {});
}

/** A PDF's pages, or nothing when they cannot be counted (item 491). */
async function countPages(data: string): Promise<number | undefined> {
  try {
    return (await pdfPages(data)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Office conversions in flight, by chip id: Send waits on these. */
const converting = new Map<number, Promise<void>>();

/**
 * Review fix (item 458 meeting 277): a conversion that ends while its chip
 * is out of the box — ⌘Z took back the attach, or × removed it, and ⌘Z may
 * yet put it back — keeps its result here (null: it failed, and said so),
 * so a chip put back is the converted one, not a pending chip with no job
 * behind it that Send would no longer wait for and would send empty.
 */
const settledWhileOut = new Map<number, Partial<Attachment> | null>();

/** A chip coming back into a box by undo or redo: the conversion's result
 *  if it finished while the chip was out, null if it failed (the chip
 *  stays out), the chip itself otherwise. */
export function settleRestored(chip: Attachment): Attachment | null {
  if (!chip.pending || converting.has(chip.id) || !settledWhileOut.has(chip.id)) return chip;
  const done = settledWhileOut.get(chip.id) ?? null;
  settledWhileOut.delete(chip.id);
  return done === null ? null : { ...chip, ...done };
}

/** Item 382: a pasted image being fetched is waited on as a conversion is —
 *  Send holds until it settles. */
export function trackPending(id: number, job: Promise<void>): void {
  const done = job.finally(() => converting.delete(id));
  converting.set(id, done);
}

/** The conversions still running for `key`'s pending chips. */
export function conversionJobs(key: string): Promise<void>[] {
  return readDraft(key)
    .attachments.filter((a) => a.pending)
    .map((a) => converting.get(a.id))
    .filter((j): j is Promise<void> => !!j);
}

/** Item 868: a split deck's parts 2..n, by its first chip's id; and each
 *  part as it last left a box, to put back when part 1 comes back. */
const partsOf = new Map<number, number[]>();
const partStore = new Map<number, Attachment>();
/** Parts that left a box with part 1 (or settled while it was out): only
 *  these come back with it — one he removed by its own × stays out. */
const followedOut = new Set<number>();

/**
 * Item 868: a split deck's parts move with part 1. After a chip step on
 * `firstId` (an undo or redo of its attach or its removal): part 1 out →
 * its parts out too, remembered as they were; part 1 in → its parts back
 * right after it. One ⌘Z takes the whole deck, one ⌘⇧Z brings it back.
 * A part he removed by its own × is his own step, not touched here.
 */
export function followParts(firstId: number, chips: readonly Attachment[]): Attachment[] {
  const ids = partsOf.get(firstId);
  if (!ids) return [...chips];
  const at = chips.findIndex((c) => c.id === firstId);
  if (at < 0) {
    for (const c of chips)
      if (ids.includes(c.id)) {
        partStore.set(c.id, c);
        followedOut.add(c.id);
      }
    return chips.filter((c) => !ids.includes(c.id));
  }
  const back = ids
    .filter((id) => followedOut.has(id) && !chips.some((c) => c.id === id))
    .map((id) => partStore.get(id))
    .filter((c): c is Attachment => !!c);
  for (const id of ids) followedOut.delete(id);
  return [...chips.slice(0, at + 1), ...back, ...chips.slice(at + 1)];
}

/** One undo/redo of a chip step on the box's chips (item 458), with what
 *  ended while a chip was out landing on it (`settleRestored`) and a split
 *  deck's parts moving with part 1 (`followParts`, item 868). */
export function stepChips(tag: ChipTag, dir: "undo" | "redo", chips: readonly Attachment[]): Attachment[] {
  const stepped = chipStep(tag, dir, [...chips]).chips.flatMap((c) => {
    const back = settleRestored(c);
    return back ? [back] : [];
  });
  return followParts(tag.chip.id, stepped);
}

/** The chips of a split deck's parts 2..n in `key`'s box — what Keep keeps
 *  beside part 1 (item 868). Empty for a file that was not split. */
export function partChips(key: string, id: number): Attachment[] {
  const ids = partsOf.get(id);
  if (!ids) return [];
  return readDraft(key).attachments.filter((a) => ids.includes(a.id) && !a.pending && !!a.data);
}

/**
 * An office file: a chip at once, saying what is happening, and the
 * conversion behind it. A PDF over the engine's cap goes again as its
 * text, with a toast saying so; a chip removed meanwhile stays removed.
 */
async function attachOffice(chatKey: string, file: File, addToast: (text: string) => void): Promise<Attachment | null> {
  if (file.size > MAX_OFFICE_BYTES) {
    addToast(`${describe(file)} is too large to convert — the limit is ${MAX_OFFICE_BYTES / 1024 / 1024} MB`);
    return null;
  }
  const canPdf = await hasConverter();
  if (!canPdf && !OFFICE_EXTS[extOf(file.name)]) {
    addToast(
      `${describe(file)}: a .${extOf(file.name)} file needs LibreOffice to read — install it (brew install --cask libreoffice), or save it as .pptx/.docx/.xlsx or PDF`,
    );
    return null;
  }
  const chip: Attachment = {
    id: nextAttachmentId(),
    kind: "document",
    name: describe(file),
    media_type: "application/pdf",
    data: "",
    label: convertingLabel(file.name, canPdf),
    pending: true,
    converting: { since: Date.now(), to: canPdf ? "pdf" : "text" },
  };
  addAttachment(chatKey, chip);
  const job = (async () => {
    try {
      const data = await readBase64(file);
      const cap = capFor("document");
      // Item 868: over the cap or the API's pages, the backend shrinks the
      // pictures, then splits a deck into parts; text is its last resort.
      let out = await prepareOfficeAttachment(chip.name, data, false, {
        maxBase64: cap,
        ...(engineNow() === "api" ? { maxPages: MAX_API_PDF_PAGES } : {}),
      });
      if (out.note) addToast(`${chip.name}: ${out.note}${out.via === "text" ? " — sending its text instead (no slides)" : ""}`);
      if (out.via === "pdf" && out.data.length > cap) {
        addToast(
          `${chip.name} became a ${Math.round(out.data.length / 1024 / 1024)} MB PDF once encoded — over the ${cap / 1024 / 1024} MB limit${cap === MAX_AGENT_DOCUMENT_BASE64 ? " on the subscription engine" : ""}; sending its text instead (no pictures)`,
        );
        out = await prepareOfficeAttachment(chip.name, data, true);
      }
      const done: Partial<Attachment> = {
        // A split deck's part 1 takes its part name (item 868).
        ...(out.name && out.name !== chip.name ? { name: out.name } : {}),
        media_type: out.media_type,
        data: out.data,
        label: convertedLabel(out.name || chip.name, out.via, out.count),
        pending: false,
        converting: undefined,
        ...(out.source_sha256 ? { source_sha256: out.source_sha256 } : {}),
        // Its pages route it (item 491): a deck that became a long PDF goes
        // by path on the Claude Code engine, as a dropped one does.
        ...(out.via === "pdf" && out.count ? { pages: out.count } : {}),
      };
      // Parts 2..n of a split deck: chips of their own beside part 1.
      const parts: Attachment[] = (out.more ?? []).map((m) => ({
        id: nextAttachmentId(),
        kind: "document",
        name: m.name,
        media_type: m.media_type,
        data: m.data,
        label: convertedLabel(m.name, m.via, m.count),
        ...(m.source_sha256 ? { source_sha256: m.source_sha256 } : {}),
        ...(m.via === "pdf" && m.count ? { pages: m.count } : {}),
      }));
      if (parts.length) {
        partsOf.set(
          chip.id,
          parts.map((p) => p.id),
        );
        for (const p of parts) partStore.set(p.id, p);
      }
      if (!updateAttachment(chatKey, chip.id, done)) {
        // Out of the box (undone, or ×): the parts wait with part 1 and
        // come back with it (`followParts`).
        settledWhileOut.set(chip.id, done);
        for (const p of parts) followedOut.add(p.id);
      } else {
        stashLong(chatKey, { ...chip, ...done });
        for (const p of parts) {
          addAttachment(chatKey, p);
          stashLong(chatKey, p);
        }
      }
    } catch (e) {
      removeAttachment(chatKey, chip.id);
      settledWhileOut.set(chip.id, null);
      addToast(`${chip.name}: ${String(e)}`);
    } finally {
      converting.delete(chip.id);
    }
  })();
  converting.set(chip.id, job);
  return chip;
}

/** Attach what can be attached, as chips under `chatKey` — the key of the
 *  moment the file was dropped: a read can outlive a chat switch, and the
 *  chip belongs where it was pasted. The chips made, for a paste to record. */
export async function acceptFiles(
  chatKey: string,
  files: Iterable<File>,
  // Item 414: a zip's entries collect their refusals for one toast.
  addToast: (text: string) => void = toastNow,
): Promise<Attachment[]> {
  const added: Attachment[] = [];
  for (const file of files) {
    const route = routeOf(file.name, file.type);
    if (route === "office") {
      const chip = await attachOffice(chatKey, file, addToast);
      if (chip) added.push(chip);
      continue;
    }
    if (route === "image" || route === "pdf") {
      const kind = route === "image" ? "image" : "document";
      const cap = capFor(kind);
      if (file.size > encodedLimit(cap)) {
        // Named engine when the cap is the engine's, so a file that was
        // fine on the API path yesterday reads as a different limit and
        // not a broken one.
        const where = cap === MAX_AGENT_DOCUMENT_BASE64 ? " on the subscription engine" : "";
        addToast(
          `${describe(file)} is too large — the limit${where} is ${cap / 1024 / 1024} MB once base64-encoded (about ${Math.round(encodedLimit(cap) / 1024 / 1024)} MB of file)`,
        );
        continue;
      }
      try {
        const data = await readBase64(file);
        // A PDF's pages, counted before the chip shows (item 491), so its
        // route is on the chip before Send can be pressed.
        const pages = route === "pdf" ? await countPages(data) : undefined;
        const chip: Attachment = {
          id: nextAttachmentId(),
          kind,
          name: describe(file),
          media_type: route === "image" ? imageType(file.name, file.type) : "application/pdf",
          data,
          ...(pages ? { pages } : {}),
        };
        addAttachment(chatKey, chip);
        added.push(chip);
        stashLong(chatKey, chip);
      } catch (e) {
        addToast(`${describe(file)}: ${String(e)}`);
      }
      continue;
    }
    // Text, or bytes that may be: read them and look.
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isText = looksLikeText(bytes);
      const d = decide(describe(file), file.size, isText, engineNow());
      if (d.as === "refuse") {
        addToast(d.why);
        continue;
      }
      let chip: Attachment;
      if (d.as === "text") {
        const notebook = extOf(file.name) === "ipynb";
        const data = notebook
          ? bytesToBase64(new TextEncoder().encode(notebookText(new TextDecoder().decode(bytes))))
          : bytesToBase64(bytes);
        chip = {
          id: nextAttachmentId(),
          kind: "document",
          name: describe(file),
          media_type: "text/plain",
          data,
          label: notebook ? "notebook → text" : "text",
        };
      } else {
        chip = {
          id: nextAttachmentId(),
          kind: "file",
          name: describe(file),
          media_type: file.type || "application/octet-stream",
          data: bytesToBase64(bytes),
          label: "file for Claude Code",
        };
      }
      addAttachment(chatKey, chip);
      added.push(chip);
    } catch (e) {
      addToast(`${describe(file)}: ${String(e)}`);
    }
  }
  return added;
}

/** The wire shape of a set of chips. A chip still converting carries
 *  nothing yet; the send paths wait for it first. A long PDF on the Claude
 *  Code engine goes as a file with its pages (item 491, `pdfRoute`) unless
 *  he chose "Send whole"; `engine` is the rail's unless the caller knows
 *  better (an aside is always Claude Code). */
export function splitChips(chips: Attachment[], engine: Engine = engineNow()) {
  const byPath = (a: Attachment) => !a.pending && pdfRoute(a, engine) === "path";
  return {
    images: chips.filter((a) => a.kind === "image").map(({ media_type, data }) => ({ media_type, data })),
    documents: chips
      .filter((a) => a.kind === "document" && !a.pending && !byPath(a))
      .map(({ media_type, name, data }) => ({ media_type, name, data }))
      .concat(pickDocuments(chips)),
    files: [
      ...chips.filter((a) => a.kind === "file").map(({ name, data }) => ({ name, data })),
      ...chips.filter(byPath).map(({ name, data, pages }) => ({ name: pdfFileName(name), data, pages })),
    ],
  };
}

/** A file for Claude Code among the chips while the rail is on the API
 *  engine (switched after it was attached): say so; `true` stops a send. */
export function filesBlocked(chips: Attachment[]): boolean {
  if (app.connection?.engine === "claude-code") return false;
  const files = chips.filter((a) => a.kind === "file");
  if (files.length === 0) return false;
  toastNow(
    `${files.map((f) => f.name).join(", ")}: only the Claude Code engine can take ${files.length === 1 ? "a file" : "files"} it opens itself — switch engines, or remove ${files.length === 1 ? "it" : "them"}`,
  );
  return true;
}
