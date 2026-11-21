// Item 856 (2026-11-19): the behaviour of UserBubble, once. `UserBubble.svelte` (Jarvis) and
// `UserBubbleClassic.svelte` mount this and keep only their markup and CSS; `logic.test.ts` beside it fails when
// one look binds to something the other does not. Moved verbatim from UserBubble.svelte's script.
import { type Snippet } from "svelte";
import { splitAttachNote } from "../keep";
import { extOf } from "../attachKinds";
import { keptGet, keptSet } from "../keptFolds.svelte";
import { parseRan } from "../shellRun";
import { parseHandoffMessage } from "../handoffBubble";

export type UserBubbleLogicProps = {
    images?: readonly Img[];
    documents?: readonly Doc[];
    text?: string;
    /** Draw `body` instead of the words. */
    custom?: boolean;
    body?: Snippet;
    extra?: Snippet;
    /** A click on a thumbnail: its index, the button's rect, the image's
     *  decoded size. Null: the thumbnail is a picture, not a button. */
    onopenimage?: ((j: number, rect: DOMRect, size: { width: number; height: number } | null) => void) | null;
    /** A click on a file chip: its index and rect. Null: a plain chip. */
    onopendoc?: ((j: number, rect: DOMRect) => void) | null;
    /** Where a text attachment's fold is kept past a chat switch (item 495
     *  part 2: the chat + turn); null, the bubble's own. */
    keep?: string | null;
    /** Item 515: the names of files for Claude Code this message carries
     *  while the backend saves them — the optimistic message has no note
     *  yet, and without these a file-only send drew an empty pill. */
    sending?: readonly string[];
    /** Item 706: a wrap-up he edited — his plain message, not the hand-off card. */
    plain?: boolean;
  };

/**
 * His message's bubble (nightshift backlog 283, 2026-10-02): the chat's
 * user turn — its images, its files (a text one unfolds in place, item
 * 284), his words with the `> ` quotes he placed drawn as quotes (215) —
 * moved out of `Transcript.svelte` so an aside's questions are drawn by
 * the same piece, and a change to how the chat draws his message reaches
 * the asides with no second edit. The class names are the transcript's
 * (`.user-bubble`, `.user-text` …): the selection pill and the find bar
 * look for them.
 *
 * The transcript passes `custom` with a `body` snippet where it draws
 * the words its own way (an edit's diff, an adopted agent's run); `extra`
 * is drawn under the words (the council chip).
 */
export interface Img {
  media_type: string;
  data: string;
}
export interface Doc {
  media_type: string;
  name: string;
  data: string;
}

export function userBubbleLogic(props: () => UserBubbleLogicProps) {
  const images = $derived(props().images ?? []);
  const documents = $derived(props().documents ?? []);
  const text = $derived(props().text ?? "");
  const custom = $derived(props().custom ?? false);
  const body = $derived(props().body);
  const extra = $derived(props().extra);
  const onopenimage = $derived(props().onopenimage ?? null);
  const onopendoc = $derived(props().onopendoc ?? null);
  const keep = $derived(props().keep ?? null);
  const sending = $derived(props().sending ?? []);
  const plain = $derived(props().plain ?? false);
  /** Item 515: the note the CLI reads (`[Attached a file — saved for you
   *  …]`) is drawn as cards, never as his words; the text stays as sent. */
  const split = $derived(splitAttachNote(text));
  const said = $derived(split.said);
  const ran = $derived(parseRan(said));
  /** Item 706: the wrap-up Nightloom sent, drawn as its hand-off card until he edits it. */
  const handoff = $derived(plain || ran ? null : parseHandoffMessage(said));

  let localOpen = $state<Record<number, boolean>>({});
  /** A text attachment unfolded (284), kept under `keep` when there is one. */
  const textOpen = $derived.by<Record<number, boolean>>(() => {
    if (keep === null) return localOpen;
    const out: Record<number, boolean> = {};
    documents.forEach((_, j) => {
      if (keptGet(`${keep}|text:${j}`, false)) out[j] = true;
    });
    return out;
  });
  function flipText(j: number): void {
    if (keep === null) localOpen[j] = !localOpen[j];
    else keptSet(`${keep}|text:${j}`, !textOpen[j], false);
  }
  /** A document with bytes to show: a text one unfolds (284). */
  const isText = (d: Doc) => d.media_type.startsWith("text/") && d.data !== "";
  /** Files the Claude Code engine saved for this message (item 277), by
   *  the paths the note names: each a card (515), with Keep (306) where
   *  the chat can keep. */
  const saved = $derived(split.files);
  /** A sending file the note does not name yet. */
  const pendingNames = $derived(sending.filter((n) => !saved.some((f) => f.name === n)));
  /** A file's kind in words: `HTML file`, `PDF`. */
  function kindOf(name: string, mediaType = ""): string {
    if (mediaType === "application/pdf" || extOf(name) === "pdf") return "PDF";
    if (mediaType.startsWith("text/")) return "Text";
    const ext = extOf(name).slice(0, 8).toUpperCase();
    return ext && ext !== name.toUpperCase() ? `${ext} file` : "File";
  }
  /** A card's badge: the chip's own (`badgeOf`). */
  const fileBadge = (name: string) => extOf(name).slice(0, 5).toUpperCase() || "FILE";

  return {
    get body() {
      return body;
    },
    get custom() {
      return custom;
    },
    get documents() {
      return documents;
    },
    get extra() {
      return extra;
    },
    get fileBadge() {
      return fileBadge;
    },
    flipText,
    get handoff() {
      return handoff;
    },
    get images() {
      return images;
    },
    get isText() {
      return isText;
    },
    get keep() {
      return keep;
    },
    kindOf,
    get onopendoc() {
      return onopendoc;
    },
    get onopenimage() {
      return onopenimage;
    },
    get pendingNames() {
      return pendingNames;
    },
    get ran() {
      return ran;
    },
    get said() {
      return said;
    },
    get saved() {
      return saved;
    },
    get split() {
      return split;
    },
    get textOpen() {
      return textOpen;
    },
  };
}
