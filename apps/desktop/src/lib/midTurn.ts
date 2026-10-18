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
  // Backlog 366: future tense until the turn takes it — "sent" read as
  // done beside a box that said it had not gone yet.
  if (inj.now)
    return {
      state: "now",
      label: "going now · asked to stop the current step",
      tip: "Send now: Claude Code is asked to stop the step it is in and read this at once; if it does not, it goes at the next step. Take back works until then.",
    };
  return { state: "sent", label: "goes at Claude's next step", tip: "Handed to the running turn: Claude reads it at its next step. Take back works until then." };
}

/**
 * The transcript line when the running turn takes his message (backlog
 * 366): past tense, since it is sent, and plain about what happens now.
 * `after` is the backend's "after Bash", "at once, stopping Bash", "at the
 * start" or "after the reply" (`delivered_after`).
 */
export function deliveredNotice(after: string, text: string): string {
  const first = text.split("\n")[0] ?? "";
  const quoted = `“${first.length > 120 ? first.slice(0, 119) + "…" : first}”`;
  const when = after === "after the reply" ? "after the reply" : `mid-reply, ${after}`;
  return `Delivered ${when} — Claude is reading it now: ${quoted}`;
}

/** What the queue's head says (backlog 366 + 374), one state at a time. */
export interface QueueHeadState {
  /** A turn runs in this chat. */
  busy: boolean;
  /** Why an idle queue waits (`queueHold`), if it does. */
  hold: "stopped" | "wrapped" | null;
  /** The rows: `inject` set once handed to the running turn. Taken rows
   *  have already left the queue (`markDelivered`). */
  rows: readonly { inject?: { after?: string } }[];
  /** This chat's subagents still running. */
  subagents: number;
}

/**
 * The queue's head label. While a turn runs: rows handed to it go at
 * Claude's next step — including when the reply has ended and only
 * subagents run, which is when Claude Code itself takes a message at once
 * (measured, 374) — and a row the turn could not take (no process with a
 * stdin: a slash command's turn, or a question waiting on his answer)
 * says it waits for the turn's end, and for the subagents that hold it
 * open when there are any.
 */
export function queueHeadLabel(s: QueueHeadState): string {
  if (s.busy) {
    if (s.rows.length > 0 && s.rows.every((r) => r.inject)) return "waiting for Claude's next step";
    if (s.subagents > 0) {
      const n = s.subagents === 1 ? "its subagent finishes" : `its ${s.subagents} subagents finish`;
      return `queued · sent when this turn ends — after ${n}`;
    }
    return "queued · sent when this turn ends";
  }
  if (s.hold === "stopped") return "waiting — the turn was stopped";
  if (s.hold === "wrapped") return "waiting — HANDOFF.md is written; continue in a new chat, or Send next here";
  return "waiting";
}
