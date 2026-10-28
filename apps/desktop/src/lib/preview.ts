/**
 * A chat's preview (nightshift item 430): the words the chip shows, pure
 * so the suite can pin them without a window.
 */
import type { PreviewSnapshot } from "./api";

/** The status as the chip says it. */
export function previewStatusText(p: PreviewSnapshot): string {
  switch (p.status) {
    case "listening":
      return "running";
    case "starting":
      return "starting";
    case "exited":
      return p.exit_code === null ? "stopped by a signal" : `exited (code ${p.exit_code})`;
  }
}

/** The URL without its scheme: `localhost:5173`. */
export function previewHost(p: PreviewSnapshot): string {
  return p.url.replace(/^https?:\/\//, "");
}

/** The command cut to one short line for the chip. */
export function previewCommandLine(command: string, max = 60): string {
  const one = command.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The chats' previews keyed by chat, after one change event. */
export function applyPreviewChange(
  map: Record<string, PreviewSnapshot>,
  chat: string,
  preview: PreviewSnapshot | null,
): Record<string, PreviewSnapshot> {
  const next = { ...map };
  if (preview) next[chat] = preview;
  else delete next[chat];
  return next;
}
