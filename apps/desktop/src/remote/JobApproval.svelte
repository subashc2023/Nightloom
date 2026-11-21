<script lang="ts">
  /**
   * A recurring job's approval card (nightshift item 780, blocker 2020):
   * Approve once (the next run may make changes, then it asks again),
   * Approve always (every run may, until the job's message changes) or
   * Keep read-only. Shown where the job's approval appears — the phone's
   * Jobs list, the phone's chat page and the Mac's chat when the open chat
   * is the job's — with the same words in each. Variables only from both
   * pages' palettes (`--line`, `--well`, `--accent`, `--on-accent`), so it
   * reads in Jarvis and Classic, light and dark.
   */
  import { approvalAsk, type Answer, type Job } from "./jobs";

  interface Props {
    job: Job;
    /** Where its chat runs, for the words ("Nightloom", "its project"). */
    where?: string;
    busy?: boolean;
    /** Name the job in the title (the chat's card; the list row has its name above). */
    named?: boolean;
    onanswer: (how: Answer) => void;
  }
  let { job, where = "its project", busy = false, named = false, onanswer }: Props = $props();
  const ask = $derived(approvalAsk(job, where));
</script>

<div class="ja" role="group" aria-label="Approve the job" data-job-approval={job.id}>
  <p class="ja-title">{named ? `${job.title}: ` : ""}{ask.title}</p>
  <p class="ja-body">{ask.body}</p>
  <div class="ja-row">
    <button class="ja-btn primary" data-act="job-approve-once" disabled={busy} onclick={() => onanswer("once")}>Approve once</button>
    <button class="ja-btn" data-act="job-approve-always" disabled={busy} onclick={() => onanswer("always")}>Approve always</button>
    <button class="ja-btn quiet" data-act="job-keep-readonly" disabled={busy} onclick={() => onanswer("keep")}>Keep read-only</button>
  </div>
  <p class="ja-hint">Once: {job.wanted ? "this run" : "its next run"} only. Always: every run, until you change its message.</p>
</div>

<style>
  .ja {
    border: 1px solid var(--accent);
    border-radius: 12px;
    background: var(--raised);
    padding: 10px 12px;
    margin: 6px 0;
  }
  .ja-title {
    font-weight: 600;
    font-size: 15px;
    margin: 0 0 4px;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .ja-body,
  .ja-hint {
    font-size: 14px;
    line-height: 1.4;
    margin: 0 0 8px;
    color: var(--ink);
  }
  .ja-hint {
    font-size: 12.5px;
    color: var(--dim);
    margin: 8px 0 0;
  }
  .ja-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .ja-btn {
    font: inherit;
    font-size: 14px;
    min-height: 36px;
    padding: 6px 12px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 9px;
    cursor: pointer;
  }
  .ja-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .ja-btn.quiet {
    background: none;
    color: var(--dim);
  }
  .ja-btn:disabled {
    opacity: 0.5;
  }
</style>
