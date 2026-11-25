<script lang="ts">
  /**
   * The Run anyway card (nightshift item 812, blocker 2094): his Run now on
   * a Home job that Home's spend guard refused. The same structure as the
   * approval card (`JobApproval.svelte`): a title ("Run Morning scan
   * anyway?"), one line with Home's estimate of the run and where his
   * windows are, the guard's reason, and the buttons — Run anyway starts it
   * once (its row says it ran anyway), Cancel leaves it skipped. Shown
   * where the approval card is: the phone's Jobs list, Home's Needs you,
   * and the job's chat on the phone and the Mac. Variables only from both
   * pages' palettes, so it reads in Jarvis and Classic, light and dark.
   */
  import { tip } from "../lib/tip";
  import { confirmAsk, type Job } from "./jobs";

  interface Props {
    job: Job;
    busy?: boolean;
    onanswer: (run: boolean) => void;
  }
  let { job, busy = false, onanswer }: Props = $props();
  const ask = $derived(confirmAsk(job));
</script>

{#if ask}
  <div class="ja" role="group" aria-label={job.confirm?.scheduled ? "Run the skipped job now" : "Run the job anyway"} data-job-run-confirm={job.id} data-scheduled={job.confirm?.scheduled ? "" : undefined}>
    <p class="ja-title">{ask.title}</p>
    <p class="ja-body">{ask.body}</p>
    <p class="ja-body why">{ask.reason}</p>
    <div class="ja-row">
      <button class="ja-btn primary" data-act="job-run-anyway" disabled={busy} use:tip={ask.runTip} onclick={() => onanswer(true)}>{ask.run}</button>
      <button class="ja-btn quiet" data-act="job-run-cancel" disabled={busy} use:tip={ask.keepTip} onclick={() => onanswer(false)}>{ask.keep}</button>
    </div>
  </div>
{/if}

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
  .ja-body {
    font-size: 14px;
    line-height: 1.4;
    margin: 0 0 8px;
    color: var(--ink);
  }
  .ja-body.why {
    color: var(--dim);
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
