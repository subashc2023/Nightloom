/**
 * Items 1005 + 1007 (verify sweep 2, 2026-11-26): every memory pass says that it started, shows that it is
 * working, and says what it saved — or that it saved nothing, or failed. Before, /remember ran a Haiku
 * capture for ~2.5 min with no word until an 8-second toast at the end, and a hand-off started a capture
 * that nothing in the chat mentioned.
 *
 * The words, pure, so the suite pins them; `state/passes.svelte.ts` raises them as one toast that runs
 * (`progressToast`, its clock in `ToastClock.svelte`) and then holds the result (`settleToast`).
 *
 * The class (practices §4), each start covered: /remember and the sidebar row's *Save memory from this
 * chat* (one path, `saveMemoryFromChat`; /remember typed in an aside's box runs it too), the Notes panel's
 * Capture and Dream buttons and the phone's (`runCapture`, `runDream`), the daily pass on its clock and
 * Settings' / the bell's *Run now* (`runDailyPass`), and the automatic pass at a hand-off or after a
 * compaction (`maybeAutoDream`). Not covered: the backfill of older outside sessions (item 779), which is
 * by design silent and gives way to any of the above.
 */
import type { CaptureReport } from "./types";

/** "0:07", "2:31", "1:02:05" — the running toast's clock. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** What a model alias reads as in a sentence: "haiku" → "Haiku"; none → null. */
export function passModelName(model: string | undefined | null): string | null {
  const m = (model ?? "").trim();
  if (!m) return null;
  const fam = /(haiku|sonnet|opus|fable)/i.exec(m)?.[1];
  return fam ? fam[0].toUpperCase() + fam.slice(1).toLowerCase() : m;
}

const on = (model: string | null) => (model ? ` on ${model}` : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** /remember and *Save memory from this chat*, while it runs. */
export function rememberStartText(model: string | null): string {
  return `saving memory from this chat — reading it${on(model)} for what is worth keeping`;
}

/**
 * /remember's result. Found something: how many, and that Dream files them. Found nothing: says so in
 * words ("nothing new to keep"), not only as a zero. The report's other counts as before (backlog 371).
 */
export function rememberResultText(r: CaptureReport): string {
  const lead = r.interrupted ? "save interrupted — " : "";
  const body =
    r.observations > 0
      ? `saved ${plural(r.observations, "observation")} from this chat`
      : r.interrupted
        ? "saved 0 observations from this chat"
        : "nothing new to keep from this chat — saved 0 observations";
  return (
    lead +
    body +
    (r.refused > 0 ? ` (${r.refused} refused)` : "") +
    (r.remaining > 0 ? "; the rest of it is left for the next save" : "") +
    (r.observations > 0 ? " — Dream files them into memory" : "")
  );
}

/** The Capture button (and the phone's), while it runs. */
export function captureStartText(pending: number, model: string | null): string {
  return pending > 0
    ? `capture: reading ${plural(pending, "chat")} into the memory inbox${on(model)}`
    : `capture: reading the chats into the memory inbox${on(model)}`;
}

/** The Dream button (and the phone's), while it runs; `activity` is the dream's last tool. */
export function dreamStartText(pending: number, model: string | null, activity = ""): string {
  const what = pending > 0 ? `sorting ${plural(pending, "observation")} into memory` : "sorting the memory inbox into memory";
  return `dream: ${what}${on(model)}${activity ? ` — ${activity}` : ""}`;
}

/**
 * Item 1014 (740 audit): a Dream's error line. An empty memory inbox is not a failure — the backend's
 * "nothing left to consolidate" (the inbox emptied, or nothing was captured yet) reads as what it is.
 */
export function dreamErrorText(e: unknown): string {
  const why = String(e).replace(/^Error: /, "");
  if (/nothing left to consolidate/i.test(why)) return "dream: nothing to consolidate — the memory inbox is empty (Capture fills it)";
  return `dream failed: ${why}`;
}

/** The kinds of pass that run capture → dream under one toast. */
export type OuterPass = "daily" | "hand-off" | "compaction" | "nightly" | "reset";

/** The lead of an outer pass's toast. */
export function outerLead(kind: OuterPass): string {
  switch (kind) {
    case "daily":
    case "nightly":
      return "daily memory pass";
    case "hand-off":
      return "saving memory from the chat you handed off";
    case "compaction":
      return "saving memory after the compaction";
    case "reset":
      return "saving memory (the pass held for usage)";
  }
}

/** Its step now: "capturing", "dreaming", "tidying". */
export function outerText(kind: OuterPass, step: string): string {
  return `${outerLead(kind)} — ${step}`;
}

/** The automatic pass's result: what each step did, in words. */
export function autoResultText(kind: OuterPass, captured: number | null, dreamed: number | null, failed: string | null): string {
  if (failed) return `${outerLead(kind)} failed: ${failed}`;
  const parts: string[] = [];
  parts.push(
    captured === null
      ? "no chat to read"
      : captured > 0
        ? `captured ${plural(captured, "observation")}`
        : "nothing new to keep",
  );
  if (dreamed !== null) parts.push(dreamed > 0 ? `dreamed ${plural(dreamed, "observation")} into memory` : "nothing to dream");
  const done = kind === "hand-off" ? "memory from the chat you handed off" : kind === "compaction" ? "memory after the compaction" : "memory pass";
  return `${done}: ${parts.join(", ")}`;
}
