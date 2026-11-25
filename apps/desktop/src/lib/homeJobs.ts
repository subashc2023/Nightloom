/**
 * Home's job rows on the Mac (nightshift item 2105, blocker 2105: "the Mac must have Run now too"):
 * the phone's Jobs list (`remote/JobsSheet.svelte`) has Run now; the Mac had none. These are the
 * words and states of the Mac's Run now, shared by the rows in Settings → Home (`HomeJobs.svelte`)
 * and the job's own chat (`remote/JobChatCard.svelte`). The press is the phone's (`job_run_now` →
 * `Jobs::press_run`, item 812): under Home's spend guard it starts the job at the next tick; past it
 * the job is skipped and carries the Run anyway card.
 */
import type { Job } from "../remote/jobs";

export interface RunNowButton {
  disabled: boolean;
  /** Two short lines (memory tooltips-two-short-lines). */
  tip: string;
}

/** The Run now button for `j`: why it is off, or what a press does. */
export function runNowButton(j: Job, busy: boolean): RunNowButton {
  if (busy) return { disabled: true, tip: "Asking the Mac…\nOne press is enough" };
  if (j.running) return { disabled: true, tip: "It is running now\nIts chat shows the run" };
  if (j.confirm) return { disabled: true, tip: j.confirm.scheduled ? "Skipped to save your limits\nAnswer the card below" : "Home's spend guard stopped it\nAnswer the card below" };
  if (j.run_now || j.force_once) return { disabled: true, tip: "Starting at the next tick\nWithin 30 s" };
  return { disabled: false, tip: "Runs it once, now\nPast Home's guard it asks first" };
}

/** The row's state line under its title: running, starting, paused, never run, or its last run. */
export function rowState(j: Job, last: string): string {
  if (j.running) return "Running now";
  if (j.run_now || j.force_once) return "Starting within 30 s";
  if (j.paused) return `Paused · ${last}`;
  return last;
}
