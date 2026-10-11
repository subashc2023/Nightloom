/**
 * Mid-turn messages with files (nightshift backlog 339): which queued
 * rows can go into the running turn, and their wire form. Pure, for the
 * suite.
 */
import type { Attachment, DocumentInput, ImageInput } from "./types";

/**
 * The images and documents a queued row carries into the running turn —
 * the same content blocks as a turn's opening line — or `null` when the
 * row must wait for the turn's end as before: a chip still converting or
 * read back without its bytes, or a `file` for Claude Code (saved in the
 * chat's folder by `send_agent`, a path the stdin line has no way to make).
 */
export function midTurnWire(chips: readonly Attachment[]): { images: ImageInput[]; documents: DocumentInput[] } | null {
  if (chips.some((c) => c.pending || !c.data || c.kind === "file")) return null;
  return {
    images: chips.filter((c) => c.kind === "image").map(({ media_type, data }) => ({ media_type, data })),
    documents: chips.filter((c) => c.kind === "document").map(({ media_type, name, data }) => ({ media_type, name, data })),
  };
}

/** The phone's files as queue chips (the Mac's queue holds `Attachment`s),
 *  so a phone message with photos can wait in it like a typed one. */
export function chipsFromInputs(
  images: readonly ImageInput[],
  documents: readonly DocumentInput[],
  nextId: () => number,
): Attachment[] {
  return [
    ...images.map((i, n) => ({
      id: nextId(),
      kind: "image" as const,
      media_type: i.media_type,
      name: `photo-${n + 1}.${i.media_type.split("/")[1] ?? "img"}`,
      data: i.data,
    })),
    ...documents.map((d) => ({ id: nextId(), kind: "document" as const, media_type: d.media_type, name: d.name, data: d.data })),
  ];
}
