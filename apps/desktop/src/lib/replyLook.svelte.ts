/**
 * Item 617: Settings → Animations → "Reply text" — how a streaming reply's
 * text arrives outside Classic. Line reveal (the default, his pick, blocker
 * 1854): whole lines show left to right as a soft fade a moment behind the
 * stream. Word rise (item 342, before 617): each new word rises from a blur.
 * Classic always keeps the word rise. Read by replyMotion when a stream starts.
 */
import { REPLY_LOOK_KEY, parseReplyLook, type ReplyLook } from "./replyMotion";

export const REPLY_LOOKS: { id: ReplyLook; name: string; note: string }[] = [
  { id: "line", name: "Line reveal", note: "The default. Each line shows left to right as a soft fade, a moment behind the text as it arrives; the shuttle rides the edge." },
  { id: "words", name: "Word rise — before", note: "Each new word rises from a soft blur as it arrives, under a fading underline; the shuttle rides the last word." },
];

function read(): string | null {
  try {
    return localStorage.getItem(REPLY_LOOK_KEY);
  } catch {
    return null;
  }
}

export const replyLook = $state<{ value: ReplyLook }>({ value: parseReplyLook(read()) });

export function setReplyLook(v: ReplyLook): void {
  replyLook.value = v;
  try {
    if (v === "line") localStorage.removeItem(REPLY_LOOK_KEY);
    else localStorage.setItem(REPLY_LOOK_KEY, v);
  } catch {
    // No storage (a harness, a private window): the choice holds for this run — replyMotion then reads the default.
  }
}
