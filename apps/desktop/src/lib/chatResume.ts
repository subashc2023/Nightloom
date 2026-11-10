/**
 * Every chat that is waiting to be continued by Nightloom, by chat id
 * (nightshift backlog 543, 2026-11-10; his words in backlog/543: "once that
 * entire thing is done, then I need it to schedule again for five hours
 * after that in case it runs out").
 *
 * Before: one slot (`app.limitPause`), set only by a turn that ended on
 * screen, erased by the next turn to end in any chat on screen, and resumed
 * only after a click on the card — so of two chats paused by the limit one
 * was lost, a chat paused off screen had no card at all, and a resumed turn
 * that ran into the next window's limit waited for another click.
 *
 * Now each paused chat has its own entry here, with the project it lives
 * in, the time it goes and the words it is sent. A limit pause is entered
 * with its time already set (the reset plus a margin; nightshift blocker
 * 1738), so it goes by itself and — because the resumed turn's own limit
 * pause makes the next entry — again at every reset until the turn ends
 * some other way. `at: null` is a pause he cancelled: the card's Resume is
 * the only thing that sends it then. The entries are kept in localStorage,
 * so a relaunch before the time does not forget them (535's "not done" 3).
 *
 * The time is kept by the backend's clock (`wake.rs`, the `limit` wake):
 * the earliest entry's. Pure over its inputs; `state.svelte.ts` holds the
 * store and does the sending.
 */
import { Marked } from "marked";
import { RESUME_MARGIN_MS, type LimitPause } from "./limit";
import { atTime, RESET_MARGIN_MS, resetTime, type ChatProject, type PlanReading } from "./schedule";

export const RESUMES_KEY = "nightloom.resumes";

/** After a resume that went straight back into the limit with no later
 *  reset named, the next try waits this long — never a loop of 429s. */
export const RETRY_AFTER_MS = 15 * 60_000;

export interface ChatResume {
  chat: string;
  /** Where the chat lives: the send goes there, whatever is open. */
  project: ChatProject;
  /** When it goes, ms since the epoch; null: only by his click. */
  at: number | null;
  /** `limit`: the usage limit stopped its turn. `asked`: the chat asked to
   *  be continued later (543b). */
  why: "limit" | "asked";
  /** What is sent. */
  text: string;
  /** What the transcript's card shows, or null. */
  pause: LimitPause | null;
  /** Why the last try did not go, in a row's words. */
  note?: string;
}

/** When a limit pause entered at `nowMs` goes by itself: the reset plus the
 *  margin; null when the CLI named no reset (the card's Resume is his).
 *  `lastWentMs` is when this chat's previous entry was sent: a pause that
 *  comes back within two minutes of it with no reset still ahead waits
 *  [`RETRY_AFTER_MS`] instead of going round at once. */
export function limitResumeTime(
  p: Pick<LimitPause, "resetsAtMs">,
  nowMs: number,
  lastWentMs: number | null = null,
): number | null {
  if (p.resetsAtMs == null) return null;
  const at = p.resetsAtMs + RESUME_MARGIN_MS;
  if (at > nowMs) return at;
  const looping = lastWentMs !== null && nowMs - lastWentMs < 120_000;
  return nowMs + (looping ? RETRY_AFTER_MS : RESUME_MARGIN_MS);
}

/** The earliest time any entry goes, or null. */
export function nextResumeAt(map: Record<string, ChatResume>): number | null {
  let next: number | null = null;
  for (const r of Object.values(map)) if (r.at !== null && (next === null || r.at < next)) next = r.at;
  return next;
}

/** The entries whose time has come at `nowMs` (a second's grace: the
 *  backend's clock and the page's are two), earliest first. */
export function dueResumes(map: Record<string, ChatResume>, nowMs: number): ChatResume[] {
  return Object.values(map)
    .filter((r) => r.at !== null && nowMs >= r.at - 1000)
    .sort((a, b) => (a.at as number) - (b.at as number));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function readPause(v: unknown, chat: string): LimitPause | null {
  if (!isObject(v) || typeof v.text !== "string") return null;
  return {
    session: chat,
    resetsAtMs: typeof v.resetsAtMs === "number" ? v.resetsAtMs : null,
    window: typeof v.window === "string" ? v.window : null,
    text: v.text,
    subagents: Array.isArray(v.subagents) ? v.subagents.filter((s): s is string => typeof s === "string") : [],
    agents: Array.isArray(v.agents)
      ? v.agents.filter(isObject).map((a) => ({
          tool_use_id: String(a.tool_use_id ?? ""),
          agent_id: String(a.agent_id ?? ""),
          description: String(a.description ?? ""),
          status: String(a.status ?? ""),
        }))
      : [],
    hitAtMs: typeof v.hitAtMs === "number" ? v.hitAtMs : 0,
  };
}

/** The stored entries read back; anything malformed is left out. */
export function readResumes(raw: string | null): Record<string, ChatResume> {
  const out: Record<string, ChatResume> = {};
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isObject(parsed)) return out;
  for (const [chat, v] of Object.entries(parsed)) {
    if (!isObject(v) || typeof v.text !== "string" || !v.text.trim()) continue;
    if (v.why !== "limit" && v.why !== "asked") continue;
    const p = isObject(v.project) ? v.project : {};
    const at = typeof v.at === "number" && Number.isFinite(v.at) ? v.at : null;
    out[chat] = {
      chat,
      project: { id: typeof p.id === "string" ? p.id : null, name: typeof p.name === "string" ? p.name : null },
      at,
      why: v.why,
      text: v.text,
      pause: readPause(v.pause, chat),
      ...(typeof v.note === "string" ? { note: v.note } : {}),
    };
  }
  return out;
}

export function writeResumes(map: Record<string, ChatResume>): string {
  return JSON.stringify(map);
}

// ---- 543b: a chat asks to be continued later ----
//
// His case (backlog/543, ~1:00 AM): "oftentimes these models are gonna run
// to like 95% and then stop working then because they don't want to hit the
// limit." Such a turn ends normally — no limit pause, nothing to resume —
// and a timer tool (CronCreate, ScheduleWakeup) needs an approval nobody is
// there to give and dies with the turn's process anyway. So the chat says it
// in its reply (nightshift blocker 1739): a line
//
//   <continue-later at="reset">what to do next</continue-later>
//
// which Nightloom reads at the turn's end and enters here as an `asked`
// entry — no tool, no permission prompt, visible in the transcript, kept
// across a relaunch, sent by the same clock into the same chat. The engine
// note tells every Claude Code chat about it (`prompt.rs`).

export const CONTINUE_TAG = "continue-later";
/** The soonest an asked continuation goes: a chat cannot spin itself. */
export const CONTINUE_MIN_MS = 5 * 60_000;
/** With no reset time known, "reset" means this long from now — the
 *  longest a 5-hour window can still have to run. */
export const WINDOW_MS = 5 * 3600_000;

export interface ContinueAsk {
  /** `reset` (the 5-hour window's), `weekly`, `+90m`, `+2h`, or `HH:MM`. */
  at: string;
  /** What the chat said to do next; may be blank. */
  text: string;
}

const ASK = /^ {0,3}<continue-later(?:\s+at\s*=\s*"([^"]*)")?\s*>([\s\S]*?)<\/continue-later>/m;
const lexer = new Marked();

/** The last `<continue-later>` of the reply that starts a line outside a
 *  code block (a reply that only shows the tag as an example asks nothing). */
export function extractContinue(reply: string): ContinueAsk | null {
  if (!reply.includes(`<${CONTINUE_TAG}`)) return null;
  let last: ContinueAsk | null = null;
  for (const t of lexer.lexer(reply)) {
    if (t.type === "code") continue;
    const m = ASK.exec(t.raw);
    if (m) last = { at: (m[1] ?? "reset").trim().toLowerCase() || "reset", text: m[2].trim() };
  }
  return last;
}

/** When the ask goes: the named time, never sooner than [`CONTINUE_MIN_MS`].
 *  A reset is the plan reading's, plus Send later's margin; unknown, the
 *  longest it could be. An `at` Nightloom cannot read is taken as `reset`. */
export function continueTime(ask: Pick<ContinueAsk, "at">, plan: PlanReading | null | undefined, nowMs: number): number {
  const floor = nowMs + CONTINUE_MIN_MS;
  const rel = /^\+(\d+(?:\.\d+)?)\s*(m|min|h)$/.exec(ask.at);
  if (rel) return Math.max(floor, nowMs + Number(rel[1]) * (rel[2] === "h" ? 3600_000 : 60_000));
  if (/^\d{1,2}:\d{2}$/.test(ask.at)) {
    const t = atTime(ask.at, nowMs);
    if (t) return Math.max(floor, t.at);
  }
  const iso = ask.at === "weekly" ? plan?.seven_day_resets_at : plan?.five_hour_resets_at;
  const reset = resetTime(iso, nowMs);
  return Math.max(floor, reset !== null ? reset + RESET_MARGIN_MS : nowMs + WINDOW_MS);
}

/** What the chat is sent at its time: Nightloom's words, and it says so. */
export function continueMessage(ask: Pick<ContinueAsk, "text">): string {
  const what = ask.text ? ` You said what to do next: ${ask.text}` : "";
  return (
    "[Nightloom, not from Swaraag: you asked to be continued at this time, and it has come — the usage window you were " +
    `waiting on has reset if that was the reason.${what} Continue the work from where you stopped. If you stop again ` +
    `with work left, end your reply with another <${CONTINUE_TAG}> line.]`
  );
}

/** The entry for an ask made at `nowMs` in `chat`. Its `pause` is what the
 *  transcript's card shows (`limit.ts` `pauseLabel` reads `window: "asked"`). */
export function askedResume(
  chat: string,
  project: ChatProject,
  ask: ContinueAsk,
  plan: PlanReading | null | undefined,
  nowMs: number,
): ChatResume {
  const at = continueTime(ask, plan, nowMs);
  return {
    chat,
    project,
    at,
    why: "asked",
    text: continueMessage(ask),
    pause: {
      session: chat,
      resetsAtMs: at - RESUME_MARGIN_MS,
      window: "asked",
      text: ask.text
        ? `This chat asked Nightloom to continue it then: ${ask.text}`
        : "This chat asked Nightloom to continue it then.",
      subagents: [],
      agents: [],
      hitAtMs: nowMs,
    },
  };
}
