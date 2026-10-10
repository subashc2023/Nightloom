/**
 * How the transcript shows a reply's working: whether thinking blocks are
 * open and whether tool calls are the full block or one line each. Two
 * transcript-wide toggles (nightshift backlog 052, 2026-09-14), remembered
 * in localStorage the way the dream prefs are, and a per-block click that
 * still overrides either one — the toggle is a default, not a lock.
 *
 * Kept out of `state.svelte.ts` on purpose: nothing here reaches the
 * backend, and the components that draw a block are the only readers.
 *
 * The pure parts (`resolveOpen`, `flipOverride`, `segmentIds`,
 * `toolSummary`) are what the tests pin; `AssistantMessage.svelte` calls
 * them and holds nothing but the override map.
 */
import type { Segment, ToolCallView } from "./state.svelte";
import { compactJson } from "./toolinput";

const KEY = "nightloom.transcript";

export type BlockKind = "thinking" | "tool";

/**
 * The faces the transcript can be set in (nightshift backlog 051). Both are
 * already bundled — Plex Sans is the interface face, Newsreader the serif
 * the replies wore until 2026-09-14 — so the choice costs no bundle weight;
 * a third face is a decision about size, not code.
 */
export const TRANSCRIPT_FONTS = [
  { id: "plex", name: "IBM Plex Sans", css: "var(--sans)" },
  { id: "newsreader", name: "Newsreader", css: "var(--serif)" },
] as const;
export type TranscriptFont = (typeof TRANSCRIPT_FONTS)[number]["id"];
export const TRANSCRIPT_SIZES = [15, 16, 17] as const;
export type TranscriptSize = (typeof TRANSCRIPT_SIZES)[number];

export interface TranscriptPrefs {
  /** Every thinking block open, not just the one still streaming. */
  thinking: boolean;
  /** Every tool call as the full block, not one line each. */
  tools: boolean;
  /** The face replies and the user's bubbles are set in. */
  font: TranscriptFont;
  /** The replies' body size in px; the user's bubble is one less. */
  size: TranscriptSize;
}

/**
 * Thinking off and tools on is how the transcript read before the toggles
 * existed, so the first launch after the release changes nothing; Plex at
 * 16 px is his pick of 2026-09-14 and what `AssistantMessage` hard-coded
 * until the setting existed.
 */
export const DEFAULT_TRANSCRIPT_PREFS: TranscriptPrefs = {
  thinking: false,
  tools: true,
  font: "plex",
  size: 16,
};

function isFont(v: unknown): v is TranscriptFont {
  return TRANSCRIPT_FONTS.some((f) => f.id === v);
}
function isSize(v: unknown): v is TranscriptSize {
  return (TRANSCRIPT_SIZES as readonly number[]).includes(v as number);
}

export function loadTranscriptPrefs(storage: Pick<Storage, "getItem"> = localStorage): TranscriptPrefs {
  try {
    const raw = storage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<TranscriptPrefs>;
      return {
        thinking:
          typeof p.thinking === "boolean" ? p.thinking : DEFAULT_TRANSCRIPT_PREFS.thinking,
        tools: typeof p.tools === "boolean" ? p.tools : DEFAULT_TRANSCRIPT_PREFS.tools,
        font: isFont(p.font) ? p.font : DEFAULT_TRANSCRIPT_PREFS.font,
        size: isSize(p.size) ? p.size : DEFAULT_TRANSCRIPT_PREFS.size,
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return { ...DEFAULT_TRANSCRIPT_PREFS };
}

export function saveTranscriptPrefs(
  prefs: TranscriptPrefs,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(
      KEY,
      JSON.stringify({
        thinking: prefs.thinking,
        tools: prefs.tools,
        font: prefs.font,
        size: prefs.size,
      }),
    );
  } catch {
    // best-effort
  }
}

/**
 * The live view of the two prefs plus a revision per kind. A toggle bumps
 * its kind's revision, and an override recorded under an older revision no
 * longer counts — that is how flipping a toggle clears the per-block clicks
 * of its kind, so the toggle always visibly does something.
 */
export interface TranscriptView extends TranscriptPrefs {
  rev: Record<BlockKind, number>;
}

function readInitial(): TranscriptPrefs {
  // The suite runs in node with an in-memory stand-in; a real absence of
  // the global (nothing today) falls to the defaults rather than throwing
  // at module load.
  return typeof localStorage === "undefined"
    ? { ...DEFAULT_TRANSCRIPT_PREFS }
    : loadTranscriptPrefs();
}

export const transcript: TranscriptView = $state({
  ...readInitial(),
  rev: { thinking: 0, tool: 0 },
});

/** The pref field a block kind reads. */
function fieldOf(kind: BlockKind): "thinking" | "tools" {
  return kind === "thinking" ? "thinking" : "tools";
}

export function setTranscriptPref(kind: BlockKind, on: boolean): void {
  transcript[fieldOf(kind)] = on;
  transcript.rev[kind]++;
  saveTranscriptPrefs(transcript);
}

export function toggleTranscriptPref(kind: BlockKind): void {
  setTranscriptPref(kind, !transcript[fieldOf(kind)]);
}

/**
 * The face and size reach the transcript as two custom properties on the
 * root — `--transcript-font`, `--transcript-size` — which `AssistantMessage`
 * and the user bubble read and nothing else does. Set on the root rather
 * than passed down so a change in Settings is a live preview in the open
 * transcript, which is where a font is judged (he found a sample page "too
 * big" at the transcript's own size).
 */
export function applyTranscriptType(
  prefs: Pick<TranscriptPrefs, "font" | "size"> = transcript,
  root: { style: { setProperty(name: string, value: string): void } } | null = typeof document ===
  "undefined"
    ? null
    : document.documentElement,
): void {
  if (!root) return;
  const face = TRANSCRIPT_FONTS.find((f) => f.id === prefs.font) ?? TRANSCRIPT_FONTS[0];
  root.style.setProperty("--transcript-font", face.css);
  root.style.setProperty("--transcript-size", `${prefs.size}px`);
}

export function setTranscriptFont(font: TranscriptFont): void {
  transcript.font = font;
  saveTranscriptPrefs(transcript);
  applyTranscriptType();
}

export function setTranscriptSize(size: TranscriptSize): void {
  transcript.size = size;
  saveTranscriptPrefs(transcript);
  applyTranscriptType();
}

// The remembered face is on the root before the first transcript paints.
applyTranscriptType();

/** A per-block click, and the toggle revision it was made under. */
export interface Override {
  open: boolean;
  rev: number;
}

/**
 * Whether a block is open.
 *
 * An explicit click on the block always wins — that is the whole of the
 * mid-stream fix: the streaming rule is consulted only when there is no
 * override, so a click on a thinking block that is still arriving closes it
 * and it stays closed through the deltas that follow. With no override:
 * thinking is open when the toggle says so, or while this block is the one
 * still streaming (how the pill behaved before the toggles); a tool call is
 * open when its toggle says so.
 */
export function resolveOpen(
  kind: BlockKind,
  id: string,
  streaming: boolean,
  done: boolean,
  overrides: Record<string, Override>,
  prefs: TranscriptView,
): boolean {
  const o = overrides[id];
  if (o !== undefined && o.rev === prefs.rev[kind]) return o.open;
  if (kind === "thinking") return prefs.thinking || (streaming && !done);
  return prefs.tools;
}

/** The override a click on the block records: the opposite of what shows. */
export function flipOverride(
  kind: BlockKind,
  id: string,
  streaming: boolean,
  done: boolean,
  overrides: Record<string, Override>,
  prefs: TranscriptView,
): Override {
  return {
    open: !resolveOpen(kind, id, streaming, done, overrides, prefs),
    rev: prefs.rev[kind],
  };
}

/**
 * A stable id per segment, in the segment's position, for keying overrides.
 *
 * The old override map was keyed by index. Within one turn the index is in
 * fact stable — the streaming builder only appends — but nothing said so,
 * and a key that survives a re-projection has to name the block rather than
 * its slot. A tool call has the API's own id; a thinking block has none, so
 * it is numbered among the thinking blocks of its message, which appending
 * later segments cannot move. Segments with nothing to open get "".
 */
export function segmentIds(segs: readonly Segment[]): string[] {
  let thinking = 0;
  return segs.map((s) => {
    if (s.kind === "thinking") return `thinking:${thinking++}`;
    if (s.kind === "tool") return `tool:${s.call.id}`;
    return "";
  });
}

/** Argument names in the order they best say what a call is doing. */
const TELLING_FIELDS = [
  "description",
  "command",
  "pattern",
  "query",
  "file_path",
  "path",
  "url",
  "prompt",
  "text",
  "content",
];

const SUMMARY_CHARS = 60;

/**
 * The input's most informative field, cut to one line: the first of the
 * telling names that holds a string, else the longest string argument, else
 * the compact JSON. `description` leads because that is the human line
 * Claude Code's tools carry ("Print second post's text" for a `bash` call),
 * and the command itself is what the expanded block is for.
 */
export function toolInputSummary(input: unknown): string {
  let s: string | null = null;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    for (const k of TELLING_FIELDS) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) {
        s = v;
        break;
      }
    }
    if (s === null) {
      for (const v of Object.values(rec)) {
        if (typeof v === "string" && v.trim() && (s === null || v.length > s.length)) s = v;
      }
    }
  }
  if (s === null) s = compactJson(input);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > SUMMARY_CHARS ? `${s.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : s;
}

/**
 * The size of what came back, for the one-line form. Characters rather
 * than tokens: the log holds the text and nothing counted it. A call still
 * waiting reads "running" while the turn is live and "no result" after it.
 */
export function toolResultSummary(call: ToolCallView, streaming: boolean): string {
  if (call.denied) return "denied";
  if (!call.result) return streaming ? "running" : "no result";
  const size = `${call.result.content.length.toLocaleString()} chars`;
  return call.result.is_error ? `error · ${size}` : size;
}

/** The whole one-line form: `name · summary · result`. */
export function toolSummary(call: ToolCallView, streaming: boolean): string {
  return `${call.name} · ${toolInputSummary(call.input)} · ${toolResultSummary(call, streaming)}`;
}
