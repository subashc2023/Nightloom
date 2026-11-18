<script lang="ts">
  /**
   * The job's approval in its own chat (nightshift item 780): when the
   * chat open on the phone — or on the Mac (`lib/JobChatCardMac.svelte`
   * passes its own `load` and `send`) — is a recurring job's, its card
   * asks here when a read-only run was stopped from making changes, and an
   * approved job carries its mark ("Always may make changes") with Take
   * back. Nothing shows for any other chat. Read every 20 s and when the
   * chat changes; an answer reads again at once.
   */
  import JobApproval from "./JobApproval.svelte";
  import JobRunConfirm from "./JobRunConfirm.svelte";
  import { confirmPatch, answerPatch, approvalBadge, type Answer, type Job, type JobPatch } from "./jobs";

  interface Props {
    chat: string | null;
    /** The job whose chat `chat` is, or null. */
    load: (chat: string) => Promise<Job | null>;
    send: (id: string, patch: JobPatch) => Promise<unknown>;
    where?: string;
  }
  let { chat, load, send, where = "its project" }: Props = $props();

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

  async function act(patch: JobPatch) {
    const j = job;
    if (!j) return;
    busy = true;
    try {
      await send(j.id, patch);
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
{:else if job && !job.read_only}
  <div class="jc-mark" data-job-chat-mark>
    <span class="jc-badge" class:always={job.approval === "always"}>{approvalBadge(job)}</span>
    <span class="jc-name">{job.title}</span>
    <button class="jc-link" data-act="job-take-back" disabled={busy} onclick={() => void act({ approve: "ask" })}>Take back</button>
  </div>
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
