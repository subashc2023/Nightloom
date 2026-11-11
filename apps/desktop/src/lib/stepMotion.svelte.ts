/**
 * Item 589: the turn trace's running step comes alive. One family of motion
 * on the row's own parts — the thread under the row (the weft), the timing
 * bar's head and the status mark — with a slight variant per kind of step:
 *
 * - think: comets flowing one way along the thread; the mark beats like a
 *   heart; a light passes through the word "Thinking".
 * - shell: today's shuttle, back and forth (his "bar thing that goes
 *   across when a terminal command is going"); the mark blinks like a cursor.
 * - agent: three threads, three shuttles at their own speeds (helpers in
 *   parallel); the mark turns a quarter at a time.
 * - file: a writing stroke drawn left to right with a bright nib; the mark
 *   bobs like a pen.
 * - web: a quick scanning band, then a rest; the mark sends out a ping.
 * - other: one slow soft comet; the mark breathes.
 *
 * The setting ("Thinking motion", Settings → Animations) applies to the
 * whole family. Item 616 (his pick, 2026-11-11): three choices —
 * - Combo (the default): Sweep, plus Reticle's per-kind marks, its [ ]
 *   brackets and faint tint on the running row, a faint light running round
 *   the row's edge, and on a helper's row the bar filled to its context out
 *   of 300k ("context 125k / 300k · 42%").
 * - Sweep — today's: the family above, as 589 built it.
 * - Reticle: a HUD lock-on — brackets, a per-kind instrument as the mark, a
 *   data bus with packets for the thread (616-demo/combo.html, card A).
 * Weave and Quiet left the picker; a saved one reads as Combo. Stamped on
 * <html> as `data-step-motion` (none for Combo); remembered in localStorage. Item 610:
 * the trace's CSS reads its own `data-motion` (AssistantMessage stamps the
 * setting, or a preview's own choice), so Settings → Animations → Thinking
 * block can run all three side by side. While the
 * window is hidden `data-hidden` is stamped and the motion pauses. Reduced
 * motion: nothing new moves (the CSS sits under `no-preference`).
 */
import { shortToolName } from "./activity";
import { isShellCall } from "./agentCommands";
import { isAgentCall } from "./subagentRows";

export type StepKind = "think" | "shell" | "agent" | "file" | "web" | "other";
export type StepMotion = "combo" | "sweep" | "reticle";

export const STEP_MOTIONS: { id: StepMotion; name: string; note: string }[] = [
  { id: "combo", name: "Combo", note: "The default. Sweep, plus a live mark for each kind, [ ] brackets, a faint tint, drifting threads and a light round the running step, and a helper's bar showing its context out of 300k." },
  { id: "sweep", name: "Sweep — today's", note: "A light runs along the running step's thread, a little different for thinking, a command, a helper, a file and the web." },
  { id: "reticle", name: "Reticle", note: "A lock-on: brackets close on the running step, its mark is a small live instrument, and packets run along its thread." },
];

/** A helper's context window for its bar under Combo (his figure, 616). */
export const HELPER_WINDOW = 300_000;

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "NotebookRead", "Glob", "Grep", "LS"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** The kind of a tool call by its name, for its running motion. */
export function toolKind(name: string): StepKind {
  if (isShellCall(name)) return "shell";
  if (isAgentCall(name)) return "agent";
  const n = shortToolName(name);
  if (FILE_TOOLS.has(n) || FILE_TOOLS.has(name)) return "file";
  if (WEB_TOOLS.has(n) || WEB_TOOLS.has(name) || /browser|navigate|web_?(fetch|search)|fetch_url/i.test(name)) return "web";
  return "other";
}

const KEY = "nightloom.stepMotion";

/** A stored value read back; anything unknown is the default (Combo) —
 *  a saved Weave or Quiet (gone since 616) included. */
export function parseStepMotion(v: string | null): StepMotion {
  return v === "sweep" || v === "reticle" ? v : "combo";
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const stepMotion = $state<{ value: StepMotion }>({ value: parseStepMotion(read()) });

/** Stamp the choice on <html> (none for Sweep). Safe where there is no document. */
export function applyStepMotion(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (stepMotion.value === "combo") delete root.dataset.stepMotion;
  else root.dataset.stepMotion = stepMotion.value;
}

export function setStepMotion(m: StepMotion): void {
  stepMotion.value = m;
  try {
    if (m === "combo") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, m);
  } catch {
    // No storage (a harness, a private window): the choice holds for this run.
  }
  applyStepMotion();
}

/** Hidden window: stamp `data-hidden` so the trace's motion pauses. */
function watchHidden(): void {
  if (typeof document === "undefined") return;
  const stamp = () => {
    if (document.hidden) document.documentElement.dataset.hidden = "";
    else delete document.documentElement.dataset.hidden;
  };
  stamp();
  document.addEventListener("visibilitychange", stamp);
}

applyStepMotion();
watchHidden();
