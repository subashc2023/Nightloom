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
import { app, addToast } from "./state.svelte";
import { officeConverter, prepareOfficeAttachment } from "./api";
import {
  convertedLabel,
  convertingLabel,
  decide,
  extOf,
  imageType,
  looksLikeText,
  MAX_OFFICE_BYTES,
  notebookText,
  OFFICE_EXTS,
  routeOf,
} from "./attachKinds";
import { addAttachment, nextAttachmentId, readDraft, removeAttachment, updateAttachment } from "./drafts.svelte";
import type { Attachment } from "./types";

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

function readBase64(file: File): Promise<string> {
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

/** Office conversions in flight, by chip id: Send waits on these. */
const converting = new Map<number, Promise<void>>();

/** The conversions still running for `key`'s pending chips. */
export function conversionJobs(key: string): Promise<void>[] {
  return readDraft(key)
    .attachments.filter((a) => a.pending)
    .map((a) => converting.get(a.id))
    .filter((j): j is Promise<void> => !!j);
}

/**
 * An office file: a chip at once, saying what is happening, and the
 * conversion behind it. A PDF over the engine's cap goes again as its
 * text, with a toast saying so; a chip removed meanwhile stays removed.
 */
async function attachOffice(chatKey: string, file: File): Promise<Attachment | null> {
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
  };
  addAttachment(chatKey, chip);
  const job = (async () => {
    try {
      const data = await readBase64(file);
      let out = await prepareOfficeAttachment(chip.name, data);
      if (out.note) addToast(`${chip.name}: ${out.note} — sending its text instead`);
      const cap = capFor("document");
      if (out.via === "pdf" && out.data.length > cap) {
        addToast(
          `${chip.name} became a ${Math.round(out.data.length / 1024 / 1024)} MB PDF once encoded — over the ${cap / 1024 / 1024} MB limit${cap === MAX_AGENT_DOCUMENT_BASE64 ? " on the subscription engine" : ""}; sending its text instead (no pictures)`,
        );
        out = await prepareOfficeAttachment(chip.name, data, true);
      }
      updateAttachment(chatKey, chip.id, {
        media_type: out.media_type,
        data: out.data,
        label: convertedLabel(chip.name, out.via, out.count),
        pending: false,
      });
    } catch (e) {
      removeAttachment(chatKey, chip.id);
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
export async function acceptFiles(chatKey: string, files: Iterable<File>): Promise<Attachment[]> {
  const added: Attachment[] = [];
  for (const file of files) {
    const route = routeOf(file.name, file.type);
    if (route === "office") {
      const chip = await attachOffice(chatKey, file);
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
        const chip: Attachment = {
          id: nextAttachmentId(),
          kind,
          name: describe(file),
          media_type: route === "image" ? imageType(file.name, file.type) : "application/pdf",
          data,
        };
        addAttachment(chatKey, chip);
        added.push(chip);
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
 *  nothing yet; the send paths wait for it first. */
export function splitChips(chips: Attachment[]) {
  return {
    images: chips.filter((a) => a.kind === "image").map(({ media_type, data }) => ({ media_type, data })),
    documents: chips
      .filter((a) => a.kind === "document" && !a.pending)
      .map(({ media_type, name, data }) => ({ media_type, name, data })),
    files: chips.filter((a) => a.kind === "file").map(({ name, data }) => ({ name, data })),
  };
}

/** A file for Claude Code among the chips while the rail is on the API
 *  engine (switched after it was attached): say so; `true` stops a send. */
export function filesBlocked(chips: Attachment[]): boolean {
  if (app.connection?.engine === "claude-code") return false;
  const files = chips.filter((a) => a.kind === "file");
  if (files.length === 0) return false;
  addToast(
    `${files.map((f) => f.name).join(", ")}: only the Claude Code engine can take ${files.length === 1 ? "a file" : "files"} it opens itself — switch engines, or remove ${files.length === 1 ? "it" : "them"}`,
  );
  return true;
}
