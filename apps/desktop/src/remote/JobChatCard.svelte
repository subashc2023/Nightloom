<script lang="ts">
  /**
   * The job's approval in its own chat (nightshift item 780): when the
   * chat open on the phone — or on the Mac (`lib/JobChatCardMac.svelte`
   * passes its own `load` and `send`) — is a recurring job's, its card
   * asks here when a read-only run was stopped from making changes, and an
   * approved job carries its mark ("Always may make changes") with Take
   * back. Nothing shows for any other chat. Read every 20 s and when the
   * chat changes; an answer reads again at once.
   *
   * Item 2105: on the Mac (`press` given) the job's line carries Run now —
   * the phone's press (`job_run_now` → `Jobs::press_run`, item 812), which
   * past Home's spend guard raises the Run anyway card above it. The phone
   * passes no `press`: its Run now is on the Jobs list.
   */
  import JobApproval from "./JobApproval.svelte";
  import JobRunConfirm from "./JobRunConfirm.svelte";
  import { confirmPatch, answerPatch, approvalBadge, lastText, type Answer, type Job, type JobPatch } from "./jobs";
  import { rowState, runNowButton } from "../lib/homeJobs";
  import { tip } from "../lib/tip";

  interface Props {
    chat: string | null;
    /** The job whose chat `chat` is, or null. */
    load: (chat: string) => Promise<Job | null>;
    send: (id: string, patch: JobPatch) => Promise<unknown>;
    where?: string;
    /** Item 2105: the Mac's Run now (none on the phone). */
    press?: (id: string) => Promise<unknown>;
  }
  let { chat, load, send, where = "its project", press }: Props = $props();

  let job = $state<Job | null>(null);
  let busy = $state(false);
  let problem = $state<string | null>(null);

  async function read(c: string | null) {
    if (!c) return void (job = null);
    try {
      const j = await load(c);
      if (c === chat) job = j;
    } catch {
      // A host with no jobs, or one that did not answer: no card.
      if (c === chat) job = null;
    }
  }

  $effect(() => {
    const c = chat;
    void read(c);
    const t = setInterval(() => void read(c), 20000);
    return () => clearInterval(t);
  });

  async function act(patch: JobPatch | "run") {
    const j = job;
    if (!j || busy) return;
    busy = true;
    try {
      if (patch === "run") await press?.(j.id);
      else await send(j.id, patch);
      problem = null;
    } catch (e) {
      problem = String(e instanceof Error ? e.message : e);
    } finally {
      busy = false;
      await read(chat);
    }
  }
</script>

{#if job?.confirm}
  <!-- Item 812: his Run now past Home's spend guard asks here too (the Mac's chat and the phone's). -->
  <div class="jc" data-job-chat-card>
    <JobRunConfirm {job} {busy} onanswer={(run) => void act(confirmPatch(run))} />
    {#if problem}<p class="jc-problem" role="alert">{problem}</p>{/if}
  </div>
{/if}
{#if job?.wanted}
  <div class="jc" data-job-chat-card>
    <JobApproval {job} {busy} {where} named onanswer={(how: Answer) => void act(answerPatch(how))} />
    {#if problem}<p class="jc-problem" role="alert">{problem}</p>{/if}
  </div>
{:else if job && (!job.read_only || press)}
  {@const b = runNowButton(job, busy)}
  <div class="jc-mark" data-job-chat-mark>
    {#if !job.read_only}<span class="jc-badge" class:always={job.approval === "always"}>{approvalBadge(job)}</span>{/if}
    <span class="jc-name">{job.title}{press ? ` · ${rowState(job, lastText(job))}` : ""}</span>
    {#if press}
      <span class="jc-tip" use:tip={b.tip}
        ><button class="jc-link" data-act="job-run" disabled={b.disabled} onclick={() => void act("run")}>Run now</button></span
      >
    {/if}
    {#if !job.read_only}
      <button class="jc-link" data-act="job-take-back" disabled={busy} onclick={() => void act({ approve: "ask" })}>Take back</button>
    {/if}
  </div>
  {#if press && problem}<p class="jc-problem" role="alert">{problem}</p>{/if}
{/if}

<style>
  .jc {
    margin: 0 0 6px;
  }
  .jc-problem {
    font-size: 13px;
    color: var(--failed);
    margin: 2px 4px 6px;
  }
  .jc-mark {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--dim);
    margin: 0 2px 6px;
    min-width: 0;
  }
  .jc-badge {
    flex: none;
    font-size: 11.5px;
    color: var(--accent-ink);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 1px 8px;
    white-space: nowrap;
  }
  .jc-badge.always {
    background: var(--accent);
    color: var(--on-accent);
  }
  .jc-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .jc-tip {
    flex: none;
    display: inline-flex;
  }
  .jc-link:disabled {
    color: var(--dim);
    cursor: default;
  }
  .jc-link {
    flex: none;
    font: inherit;
    font-size: 13px;
    background: none;
    border: 0;
    color: var(--accent-ink);
    padding: 6px 4px;
    cursor: pointer;
  }
</style>
