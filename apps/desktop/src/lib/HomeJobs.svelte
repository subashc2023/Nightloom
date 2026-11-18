<script lang="ts">
  /**
   * Home's jobs as rows on the Mac (nightshift item 2105): Settings → Home lists the morning scan and any
   * job in Home's project, each with its schedule, its state and Run now — the phone's press
   * (`job_run_now` → `Jobs::press_run`, item 812). Past Home's spend guard the row carries the same Run
   * anyway card as the phone (`JobRunConfirm`), answered through `job_answer`. A refusal ("it is running
   * now", "that job is gone") shows under the row. Read when shown, every 20 s, and after every press.
   */
  import { invoke } from "@tauri-apps/api/core";
  import { tip } from "./tip";
  import JobRunConfirm from "../remote/JobRunConfirm.svelte";
  import { confirmPatch, everyText, lastText, type Job, type JobPatch } from "../remote/jobs";
  import { rowState, runNowButton } from "./homeJobs";

  interface Props {
    /** Injected by the harness; the app uses the Tauri commands. */
    load?: () => Promise<Job[]>;
    press?: (id: string) => Promise<unknown>;
    send?: (id: string, patch: JobPatch) => Promise<unknown>;
  }
  let {
    load = () => invoke<Job[]>("job_home_list"),
    press = (id) => invoke("job_run_now", { id }),
    send = (id, patch) => invoke("job_answer", { id, patch }),
  }: Props = $props();

  let jobs = $state<Job[] | null>(null);
  let busy = $state<string | null>(null);
  let problem = $state<{ id: string; text: string } | null>(null);

  async function read() {
    try {
      jobs = await load();
    } catch {
      jobs = [];
    }
  }

  $effect(() => {
    void read();
    const t = setInterval(() => void read(), 20000);
    return () => clearInterval(t);
  });

  async function act(j: Job, what: () => Promise<unknown>) {
    if (busy) return;
    busy = j.id;
    try {
      await what();
      problem = null;
    } catch (e) {
      problem = { id: j.id, text: String(e instanceof Error ? e.message : e) };
    } finally {
      busy = null;
      await read();
    }
  }
</script>

{#if jobs && jobs.length > 0}
  <div class="hj" data-home-jobs-mac>
    {#each jobs as j (j.id)}
      {@const b = runNowButton(j, busy === j.id)}
      <div class="hj-job" class:paused={j.paused} data-job={j.id}>
        <div class="hj-row">
          <div class="hj-text">
            <span class="hj-name">{j.title}</span>
            <span class="hj-line">{everyText(j)}</span>
            <span class="hj-line" class:live={!!j.running}>{rowState(j, lastText(j))}</span>
          </div>
          <span class="hj-tip" use:tip={b.tip}>
            <button class="ns-btn ghost" data-act="job-run" disabled={b.disabled} onclick={() => void act(j, () => press(j.id))}>Run now</button>
          </span>
        </div>
        {#if j.confirm}
          <!-- Item 812's card, the phone's: Run anyway / Cancel past Home's spend guard. -->
          <div class="hj-card"><JobRunConfirm job={j} busy={busy === j.id} onanswer={(run) => void act(j, () => send(j.id, confirmPatch(run)))} /></div>
        {/if}
        {#if problem?.id === j.id}<p class="hj-problem" role="alert">{problem.text}</p>{/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .hj {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .hj-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .hj-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hj-name {
    font-size: 13.5px;
    color: var(--text);
  }
  .hj-line {
    font-size: 12.5px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hj-line.live {
    color: var(--accent-ink);
  }
  .hj-job.paused .hj-name {
    color: var(--dim);
  }
  .hj-tip {
    flex: none;
    display: inline-flex;
  }
  .hj-card {
    margin-top: 8px;
  }
  .hj-problem {
    font-size: 13px;
    color: var(--failed);
    margin: 4px 0 0;
  }
</style>
