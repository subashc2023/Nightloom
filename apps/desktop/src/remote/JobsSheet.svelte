<script lang="ts">
  /**
   * Recurring jobs on the phone (nightshift item 746): the list — each
   * job's schedule, next run, last result and what it cost of the weekly
   * limit — and the form that makes one. Rendered inside the page's sheet.
   *
   * - A job is read-only until he approves it here (item 780): Approve
   *   once (its next run) or Approve always (every run, until its message
   *   changes), on the card a refused run raises or ahead of time from the
   *   job's row; Take back makes it read-only again. New words take the
   *   approval back on the host.
   * - Times are the job's zone's (item 780): the schedule line names it
   *   when the phone is elsewhere, and a job saved before zones were kept
   *   is sent the phone's zone (the host keeps it only when it fits).
   * - Pause and Run now act at once; Delete asks first, and the host moves
   *   the job to its trash file (its chat and past results stay).
   * - The form's half-typed words are kept (`jobs.ts`'s draft) until Save
   *   or Discard, whatever closes the sheet.
   */
  import { untrack } from "svelte";
  import JobApproval from "./JobApproval.svelte";
  import {
    EVERY_PRESETS,
    answerPatch,
    approvalBadge,
    everyText,
    phoneTz,
    type Answer,
    lastText,
    nextText,
    offsetMin,
    readJobDraft,
    weekText,
    writeJobDraft,
    type Job,
    type JobsApi,
  } from "./jobs";

  interface Props {
    api: JobsApi;
    /** "repeat every …" read from the composer: the form opens filled. */
    prefill?: { every: string; text: string } | null;
    /** Where a new job's chat is made: the project on the phone's screen. */
    project?: string | null;
    projectName?: string | null;
    fromChat?: string | null;
    where?: string;
    /** A job was made from the composer's words: the page clears them. */
    onmade?: () => void;
    onopen: (chat: string, project: string | null) => void;
  }
  let { api, prefill = null, project = null, projectName = null, fromChat = null, where = "the Mac", onmade, onopen }: Props = $props();

  let jobs = $state<Job[] | null>(null);
  let problem = $state<string | null>(null);
  let busy = $state<string | null>(null);
  /** The row open for its details, and the confirm showing in it. */
  let open = $state<string | null>(null);
  let confirm = $state<null | "delete" | "approve">(null);

  const kept = untrack(() => prefill) ? null : readJobDraft();
  let adding = $state(untrack(() => prefill !== null) || kept !== null);
  let every = $state(untrack(() => prefill?.every) ?? kept?.every ?? "");
  let text = $state(untrack(() => prefill?.text) ?? kept?.text ?? "");
  let title = $state(kept?.title ?? "");
  let formProblem = $state<string | null>(null);
  const fromComposer = untrack(() => prefill !== null);

  $effect(() => {
    // The draft follows every keystroke; the composer's own words are the
    // composer's draft, not this one's.
    if (!fromComposer) writeJobDraft(adding ? { every, text, title } : null);
  });

  function said(e: unknown): string {
    return String(e instanceof Error ? e.message : e);
  }

  /** Jobs already sent the phone's zone this time the sheet is open. */
  const zoned = new Set<string>();
  async function refresh() {
    try {
      jobs = (await api.jobs()).jobs;
      problem = null;
      const here = phoneTz();
      for (const j of jobs) {
        if (here && j.tz === null && !zoned.has(j.id)) {
          zoned.add(j.id);
          void api.jobPatch(j.id, { tz: here }).catch(() => {});
        }
      }
    } catch (e) {
      problem = said(e);
    }
  }
  $effect(() => {
    untrack(() => void refresh());
    const t = setInterval(() => void refresh(), 15000);
    return () => clearInterval(t);
  });

  async function save() {
    formProblem = null;
    if (!every.trim()) return void (formProblem = "Say how often — “every morning”, “every 2 hours”.");
    if (!text.trim()) return void (formProblem = "Write the message it repeats.");
    busy = "new";
    try {
      await api.jobNew({ every, text, title: title.trim() || undefined, project, from_chat: fromChat, offset_min: offsetMin(), tz: phoneTz() });
      adding = false;
      every = text = title = "";
      writeJobDraft(null);
      if (fromComposer) onmade?.();
      await refresh();
    } catch (e) {
      formProblem = said(e);
    } finally {
      busy = null;
    }
  }

  function discard() {
    adding = false;
    every = text = title = "";
    formProblem = null;
    writeJobDraft(null);
  }

  function answer(j: Job, how: Answer) {
    void act(j, () => api.jobPatch(j.id, answerPatch(how)));
  }

  async function act(j: Job, what: () => Promise<unknown>) {
    busy = j.id;
    try {
      await what();
      problem = null;
    } catch (e) {
      problem = said(e);
    } finally {
      busy = null;
      confirm = null;
      await refresh();
    }
  }
</script>

<div class="jb-head">
  <span class="jb-title">Jobs</span>
  {#if !adding}
    <button class="jb-link" data-act="job-new" onclick={() => (adding = true)}>New job</button>
  {/if}
</div>

{#if adding}
  <div class="jb-form" data-job-form>
    <label class="jb-label" for="jb-every">Repeat</label>
    <input id="jb-every" class="jb-input" bind:value={every} placeholder="every morning" autocapitalize="off" autocomplete="off" />
    <div class="jb-chips">
      {#each EVERY_PRESETS as p (p)}
        <button class="jb-chip" class:on={every.trim().toLowerCase() === p.toLowerCase()} onclick={() => (every = p)}>{p.replace(/^every /, "")}</button>
      {/each}
    </div>
    <label class="jb-label" for="jb-text">The message it sends each time</label>
    <textarea id="jb-text" class="jb-input" rows="3" bind:value={text} placeholder="Check CI on main and tell me what failed"></textarea>
    <label class="jb-label" for="jb-name">Name (optional)</label>
    <input id="jb-name" class="jb-input" bind:value={title} placeholder="From the message" />
    <p class="jb-note">
      It runs on {where} in its own chat{projectName ? ` in ${projectName}` : ""}, read-only: it can read, search and use the web, not edit files or run commands — until you approve it, once or always. Each run spends some of the weekly limit; the list shows how much.
    </p>
    {#if formProblem}<p class="jb-problem" role="alert">{formProblem}</p>{/if}
    <div class="jb-row">
      <button class="jb-btn primary" data-act="job-save" disabled={busy === "new"} onclick={save}>{busy === "new" ? "Saving…" : "Save job"}</button>
      <button class="jb-btn" data-act="job-discard" onclick={discard}>Discard</button>
    </div>
  </div>
{/if}

{#if problem}<p class="jb-problem" role="alert">{problem}</p>{/if}

{#if jobs === null && !problem}
  <p class="jb-note">Reading the jobs…</p>
{:else if jobs && jobs.length === 0 && !adding}
  <p class="jb-note">No jobs yet. Make one here, or type “repeat every morning: …” in any chat.</p>
{/if}

{#each jobs ?? [] as j (j.id)}
  <div class="jb-job" class:paused={j.paused} data-job={j.id}>
    <button class="jb-main" aria-expanded={open === j.id} onclick={() => ((open = open === j.id ? null : j.id), (confirm = null))}>
      <span class="jb-name">{j.title}</span>
      <span class="jb-badge" class:write={!j.read_only} class:always={j.approval === "always"}>{approvalBadge(j)}</span>
      <span class="jb-line">{everyText(j)}</span>
      <span class="jb-line" class:live={j.running !== null} class:warn={!j.running && !j.paused && j.note !== null}>{nextText(j)}</span>
      <span class="jb-line">{lastText(j)}</span>
      {#if weekText(j)}<span class="jb-line">{weekText(j)}</span>{/if}
    </button>
    {#if j.wanted}
      <div class="jb-card"><JobApproval job={j} busy={busy === j.id} onanswer={(how) => answer(j, how)} /></div>
    {/if}
    {#if open === j.id}
      <div class="jb-detail">
        {#if j.last}<p class="jb-summary">{j.last.summary}</p>{/if}
        <p class="jb-label">The message</p>
        <p class="jb-text">{j.text}</p>
        {#if confirm === "delete"}
          <p class="jb-ask">Delete this job? It stops running. Its chat and past results stay.</p>
          <div class="jb-row">
            <button class="jb-btn danger" data-act="job-delete-yes" disabled={busy === j.id} onclick={() => act(j, () => api.jobDelete(j.id))}>Delete</button>
            <button class="jb-btn" onclick={() => (confirm = null)}>Keep it</button>
          </div>
        {:else if confirm === "approve"}
          <JobApproval job={j} busy={busy === j.id} onanswer={(how) => (how === "keep" ? (confirm = null) : answer(j, how))} />
        {:else}
          <div class="jb-row wrap">
            <button class="jb-btn" data-act="job-pause" disabled={busy === j.id} onclick={() => act(j, () => api.jobPatch(j.id, { paused: !j.paused }))}>{j.paused ? "Resume" : "Pause"}</button>
            <button class="jb-btn" data-act="job-run" disabled={busy === j.id || j.running !== null} onclick={() => act(j, () => api.jobRun(j.id))}>Run now</button>
            {#if j.chat}
              <button class="jb-btn" data-act="job-open" onclick={() => onopen(j.chat ?? "", j.project)}>Open its chat</button>
            {/if}
            {#if j.read_only && !j.wanted}
              <button class="jb-btn" data-act="job-approve" onclick={() => (confirm = "approve")}>Approve…</button>
            {:else if !j.read_only}
              <button class="jb-btn" data-act="job-readonly" disabled={busy === j.id} onclick={() => act(j, () => api.jobPatch(j.id, { approve: "ask" }))}>Take back approval</button>
            {/if}
            <button class="jb-btn danger" data-act="job-delete" onclick={() => (confirm = "delete")}>Delete…</button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/each}

<style>
  .jb-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0 2px 8px;
  }
  .jb-title {
    font-weight: 600;
    font-size: 17px;
  }
  .jb-link {
    background: none;
    border: 0;
    color: var(--accent-ink);
    font-size: 15px;
    padding: 8px 4px;
  }
  .jb-form,
  .jb-job {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--raised);
    margin-bottom: 10px;
  }
  .jb-form {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .jb-label {
    font-size: 13px;
    color: var(--dim);
    margin: 4px 0 0;
  }
  .jb-input {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-size: 16px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 9px 10px;
  }
  .jb-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .jb-chip {
    font-size: 13px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 10px;
  }
  .jb-chip.on {
    border-color: var(--accent);
    color: var(--accent-ink);
  }
  .jb-note,
  .jb-ask {
    font-size: 14px;
    color: var(--dim);
    margin: 6px 2px;
    line-height: 1.4;
  }
  .jb-ask {
    color: var(--ink);
  }
  .jb-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 6px 2px;
  }
  .jb-row {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .jb-row.wrap {
    flex-wrap: wrap;
  }
  .jb-btn {
    font-size: 15px;
    min-height: 40px;
    padding: 8px 14px;
    color: var(--ink);
    background: var(--well);
    border: 1px solid var(--line);
    border-radius: 10px;
  }
  .jb-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .jb-btn.danger {
    color: var(--failed);
  }
  .jb-btn:disabled {
    opacity: 0.5;
  }
  .jb-main {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 3px 8px;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    color: var(--ink);
    padding: 12px;
  }
  .jb-name {
    font-weight: 600;
    font-size: 16px;
    overflow-wrap: anywhere;
  }
  .jb-badge {
    font-size: 11px;
    color: var(--dim);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 8px;
    align-self: start;
    white-space: nowrap;
  }
  .jb-badge.write {
    color: var(--accent-ink);
    border-color: var(--accent);
  }
  /* Approve always: the mark that stays on the job until he takes it back. */
  .jb-badge.always {
    background: var(--accent);
    color: var(--on-accent);
  }
  .jb-card {
    padding: 0 10px 10px;
  }
  .jb-line {
    grid-column: 1 / -1;
    font-size: 14px;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  .jb-line.live {
    color: var(--live);
  }
  .jb-line.warn {
    color: var(--failed);
  }
  .jb-job.paused .jb-name {
    color: var(--dim);
  }
  .jb-detail {
    border-top: 1px solid var(--line);
    padding: 10px 12px 12px;
  }
  .jb-summary,
  .jb-text {
    font-size: 14px;
    margin: 2px 0 8px;
    line-height: 1.4;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .jb-summary {
    background: var(--well);
    border-radius: 8px;
    padding: 8px 10px;
  }
</style>
