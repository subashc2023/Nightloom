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

/** What a Send now did (backlog 339; `not_hurried` and `taken_back`, 341). */
export type SendNowResult = "sent" | "delivered" | "not_hurried" | "taken_back" | "not_running";

/**
 * The toast for a Send now's answer, or `null` for none (`sent`: the row's
 * chip says it). Backlog 341: a cancel the CLI did not confirm leaves the
 * row queued for the next step, and a Take back that won the race took it
 * back — neither "already reached the turn".
 */
export function sendNowToast(r: SendNowResult): string | null {
  switch (r) {
    case "sent":
      return null;
    case "delivered":
      return "already reached the turn";
    case "not_hurried":
      return "Claude Code did not stop the current step — it goes at the next step";
    case "taken_back":
      return "it was taken back, so it was not sent";
    case "not_running":
      return "no turn is running to take it now — it goes as the next message";
  }
}

/**
 * A row's chip while it is sent into the running turn (backlog 328/339).
 * A Send now only asks Claude Code to stop the step it is in; whether it
 * did shows once the turn takes the message (`after`, "at once, stopping
 * Bash" only when the step was in fact aborted — backlog 341).
 */
export function injectChip(inj: { after?: string; now?: boolean }): { state: "delivered" | "now" | "sent"; label: string; tip: string } {
  if (inj.after !== undefined)
    return { state: "delivered", label: `delivered ${inj.after}`, tip: "The running turn took this message; it is in the chat when the turn ends." };
  if (inj.now)
    return {
      state: "now",
      label: "sending now · asked to stop the current step",
      tip: "Send now: Claude Code is asked to stop the step it is in and read this at once; if it does not, it goes at the next step. Take back works until then.",
    };
  return { state: "sent", label: "sent · at the next step", tip: "Sent into the running turn: Claude reads it at its next step. Take back works until then." };
}
