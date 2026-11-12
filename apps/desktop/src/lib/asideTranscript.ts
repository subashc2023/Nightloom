/**
 * An aside thread as the chat's events (item 674, 2026-11-12; his "I dont
 * get why we aren't jus using a common shared code base … for asides and
 * main"). `Transcript.svelte` draws a chat from its `SessionEvent`s; this
 * projects an aside's exchanges into the same shape, so the one transcript
 * draws both and a feature added to it reaches an aside with no port.
 *
 * Pure: no store, no clock. Per exchange, in order —
 *
 * - his question → a `user_message` (its attachments as the bubble's
 *   images and documents);
 * - a settled answer → an `assistant_message` whose blocks are the
 *   exchange's `segments` (thinking, text, calls — a call's result as the
 *   `tool_result` event after it, as the log holds one), or one text block
 *   from `partial` for a turn read back without segments;
 * - the exchange still being asked → its question only: the answer is the
 *   transcript's *live* turn (`asideLive`), as the chat's running reply is;
 * - `cancelled` / `error` → a note under the exchange's last drawn item.
 *
 * `turnOf` maps an event's index (what the transcript's controls name)
 * back to the exchange, and `seqOf` to its sequence number — the fold
 * scope's turn, the same for the live answer and the recorded one, so a
 * fold clicked while it streams holds when it settles.
 *
 * The events of the asking exchange read only its question, attachments
 * and start: a streamed delta never rebuilds them.
 */
import type { Aside, AsideTurn, Segment } from "./state.svelte";
import type { ContentBlock, DocumentInput, ImageInput, SessionEvent } from "./types";

export interface AsideNote {
  kind: "stopped" | "error";
  text: string;
}

export interface AsideEvents {
  events: SessionEvent[];
  /** Per event index, the exchange it belongs to. */
  turnOf: number[];
  /** Per event index, that exchange's `seq` (the fold scope's turn). */
  seqOf: number[];
  /** Notes drawn under the item at an event index. */
  notes: Map<number, AsideNote[]>;
  /** Replies whose tokens were not kept (a stored turn): a bare footer. */
  bare: Set<number>;
}

/** The exchange still being asked, or null (`asideAsking`, kept pure). */
export function askingOf(a: Pick<Aside, "turns"> | null): AsideTurn | null {
  const t = a?.turns[a.turns.length - 1] ?? null;
  return t && t.answer === null && t.error === null && !t.cancelled ? t : null;
}

/** An exchange's reply as segments: its own, or its text alone. */
export function segsOfTurn(t: AsideTurn): Segment[] {
  if (t.segments && t.segments.length > 0) return t.segments;
  return t.partial ? [{ kind: "text", text: t.partial }] : [];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** When the question was sent, as far as the exchange knows. */
function askedAt(t: AsideTurn): string {
  if (t.startedAt !== undefined) return iso(t.startedAt);
  if (t.at && t.tookMs !== undefined) {
    const end = new Date(t.at).getTime();
    if (!Number.isNaN(end)) return iso(end - t.tookMs);
  }
  return t.at ?? "";
}

export function asideEvents(aside: Pick<Aside, "turns">): AsideEvents {
  const events: SessionEvent[] = [];
  const turnOf: number[] = [];
  const seqOf: number[] = [];
  const notes = new Map<number, AsideNote[]>();
  const bare = new Set<number>();
  const asking = askingOf(aside);
  aside.turns.forEach((t, i) => {
    const put = (e: SessionEvent): number => {
      events.push(e);
      turnOf.push(i);
      seqOf.push(t.seq);
      return events.length - 1;
    };
    const images: ImageInput[] = [];
    const documents: DocumentInput[] = [];
    for (const a of t.attachments ?? []) {
      if (a.kind === "image" && a.data) images.push({ media_type: a.media_type, data: a.data });
      // Everything else as a chip: a document, a file, an image read back
      // without its bytes (the store keeps names only).
      else documents.push({ media_type: a.media_type, name: a.name, data: a.data } as DocumentInput);
    }
    let last = put({
      event: "user_message",
      text: t.question,
      ...(images.length ? { images } : {}),
      ...(documents.length ? { documents } : {}),
      at: askedAt(t),
    });
    if (t === asking) return;
    const segs = segsOfTurn(t);
    const blocks: ContentBlock[] = [];
    const results: SessionEvent[] = [];
    for (const s of segs) {
      if (s.kind === "thinking") blocks.push({ type: "thinking", text: s.text });
      else if (s.kind === "redacted") blocks.push({ type: "redacted_thinking", data: "" });
      else if (s.kind === "text") blocks.push({ type: "text", text: s.text });
      else if (s.kind === "tool") {
        blocks.push({ type: "tool_use", id: s.call.id, name: s.call.name, input: s.call.input });
        if (s.call.result)
          results.push({
            event: "tool_result",
            tool_use_id: s.call.id,
            name: s.call.name,
            content: s.call.result.content,
            is_error: s.call.result.is_error,
            at: t.at ?? "",
          });
      }
      // Notices, retry lines and the like are the live turn's alone.
    }
    if (blocks.length > 0) {
      last = put({
        event: "assistant_message",
        model: t.model ?? "aside",
        blocks,
        stop_reason: null,
        usage: {
          input_tokens: t.usage?.input_tokens ?? 0,
          output_tokens: t.usage?.output_tokens ?? 0,
          ...(t.usage?.cache_read_tokens !== undefined ? { cache_read_tokens: t.usage.cache_read_tokens } : {}),
        },
        at: t.at ?? "",
      });
      if (t.usage === undefined) bare.add(last);
      for (const r of results) put(r);
    }
    const ns: AsideNote[] = [];
    if (t.cancelled) ns.push({ kind: "stopped", text: "stopped here" });
    if (t.error) ns.push({ kind: "error", text: t.error });
    if (ns.length) notes.set(last, ns);
  });
  return { events, turnOf, seqOf, notes, bare };
}

/** The asking exchange as the transcript's live turn, or null. */
export function asideLive(aside: Pick<Aside, "turns">): { segments: Segment[]; since: number | null } | null {
  const t = askingOf(aside);
  return t ? { segments: segsOfTurn(t), since: t.startedAt ?? null } : null;
}
