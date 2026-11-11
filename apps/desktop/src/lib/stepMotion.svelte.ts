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
 * whole family: Sweep (the default, above), Weave (Sweep plus faint threads
 * drifting behind the running row) or Quiet (the mark and the bar's head
 * only; tool rows keep today's shuttle). Stamped on <html> as
 * `data-step-motion` (none for Sweep); remembered in localStorage. While the
 * window is hidden `data-hidden` is stamped and the motion pauses. Reduced
 * motion: nothing new moves (the CSS sits under `no-preference`).
 */
import { shortToolName } from "./activity";
import { isShellCall } from "./agentCommands";
import { isAgentCall } from "./subagentRows";

export type StepKind = "think" | "shell" | "agent" | "file" | "web" | "other";
export type StepMotion = "sweep" | "weave" | "quiet";

export const STEP_MOTIONS: { id: StepMotion; name: string; note: string }[] = [
  { id: "sweep", name: "Sweep", note: "The default. A light runs along the running step's thread, a little different for thinking, a command, a helper, a file and the web." },
  { id: "weave", name: "Weave", note: "Sweep, plus faint threads drifting behind the running step." },
  { id: "quiet", name: "Quiet", note: "Only the step's mark and the bar's head move; commands keep today's sweep." },
];

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

/** A stored value read back; anything unknown is the default. */
export function parseStepMotion(v: string | null): StepMotion {
  return v === "weave" || v === "quiet" ? v : "sweep";
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
  if (stepMotion.value === "sweep") delete root.dataset.stepMotion;
  else root.dataset.stepMotion = stepMotion.value;
}

export function setStepMotion(m: StepMotion): void {
  stepMotion.value = m;
  try {
    if (m === "sweep") localStorage.removeItem(KEY);
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
