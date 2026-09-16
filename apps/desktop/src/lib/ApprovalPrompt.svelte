<script lang="ts">
  import { tick } from "svelte";
  import { app, resolveApproval } from "./state.svelte";
  import { inputFields } from "./toolinput";
  import type { ApprovalRequest, AskQuestion } from "./types";

  let { req }: { req: ApprovalRequest } = $props();

  const fields = $derived(inputFields(req.input));

  // On the Claude Code engine every prompt is a call the CLI *deferred*
  // (nightshift backlog 084): the process has exited on it, the answer is
  // written for the CLI's hook and the session resumed. Three shapes live
  // here for that engine — the permission prompt, the model's question
  // (`AskUserQuestion`), the plan card (`ExitPlanMode`) — with the control
  // set the design fixed: Allow · Allow for this chat · Deny, nothing arming
  // into a second click, the reason always in reach. The API engine's
  // prompt below it is left exactly as it was.
  const deferred = $derived(app.connection?.engine === "claude-code");
  const kind = $derived<"question" | "plan" | "call">(
    !deferred ? "call"
    : req.name === "AskUserQuestion" ? "question"
    : req.name === "ExitPlanMode" ? "plan"
    : "call",
  );

  let denying = $state(false);
  let reason = $state("");
  let box = $state<HTMLDivElement | null>(null);
  let reasonInput = $state<HTMLInputElement | null>(null);
  let denyButton = $state<HTMLButtonElement | null>(null);

  // The turn is parked on this answer, so put keyboard focus on the prompt —
  // but on the box, not on a button: nothing here should be one stray Enter
  // away from granting permission.
  $effect(() => {
    box?.focus();
  });

  function decide(decision: "allow" | "always" | "deny", answer?: unknown, then?: "ask" | "auto") {
    void resolveApproval(
      req.id,
      req.name,
      decision,
      decision === "deny" ? reason.trim() || undefined : undefined,
      answer,
      then,
    );
  }

  // ---- the model's question -------------------------------------------
  // `input.questions` as the CLI sends it; the answer goes back as the same
  // input plus `answers`, question text → chosen label (several joined with
  // ", "; "Other" is whatever was typed), which is what the resumed tool
  // echoed on 2026-09-16 ("Your questions have been answered: …").
  const questions = $derived.by<AskQuestion[]>(() => {
    const q = (req.input as { questions?: unknown } | null)?.questions;
    return Array.isArray(q) ? (q as AskQuestion[]) : [];
  });
  let picks = $state<Record<number, string[]>>({});
  let others = $state<Record<number, string>>({});

  function toggle(i: number, label: string, multi: boolean) {
    const cur = picks[i] ?? [];
    if (multi) {
      picks[i] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    } else {
      picks[i] = [label];
    }
  }

  const answered = $derived(
    questions.length > 0 &&
      questions.every((_, i) => (picks[i]?.length ?? 0) > 0 || (others[i] ?? "").trim() !== ""),
  );

  function answerQuestions() {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const chosen = [...(picks[i] ?? [])];
      const other = (others[i] ?? "").trim();
      if (other) chosen.push(other);
      answers[q.question] = chosen.join(", ");
    });
    decide("allow", { ...(req.input as object), answers });
  }

  // ---- the plan ---------------------------------------------------------
  // `input.plan` is the markdown and `input.planFilePath` the CLI's own
  // copy under `~/.claude/plans/` (verbatim shape, 2026-09-16,
  // `m085-4-resume.jsonl`).
  const plan = $derived.by(() => {
    const p = (req.input as { plan?: unknown } | null)?.plan;
    return typeof p === "string" ? p : null;
  });
  const planFile = $derived.by(() => {
    const p = (req.input as { planFilePath?: unknown } | null)?.planFilePath;
    return typeof p === "string" ? p : null;
  });
  // Where the chat goes once the plan is approved (backlog 085, "his pick
  // on the card"): Ask keeps the prompts, Auto hands the rest to the CLI's
  // classifier. Ask first, since it is the position that keeps asking.
  // The Auto radio says "Manual on this account" (the whole-project review
  // of 2026-09-16, F6): every `auto` run of the night came up as the CLI's
  // `default` permission mode — `auto` is not available to this account's
  // headless sessions (blocker 079, open) — and the position then has no
  // hook and no prompt tool, so its first write is refused. The label is
  // honest until 079 answers; the position itself is unchanged.
  let then = $state<"ask" | "auto">("ask");

  function onDeny() {
    if (denying) {
      decide("deny");
      return;
    }
    denying = true;
    void tick().then(() => reasonInput?.focus());
  }

  function onReasonKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      decide("deny");
    } else if (e.key === "Escape") {
      // Back out of the reason, not out of the decision — the call is still
      // waiting either way, so leave the three buttons in reach.
      e.preventDefault();
      e.stopPropagation();
      denying = false;
      reason = "";
      denyButton?.focus();
    }
  }
</script>

{#if kind === "question"}
  <div
    class="approval"
    bind:this={box}
    tabindex="-1"
    role="group"
    aria-label="the model asks {questions.length} question{questions.length === 1 ? '' : 's'}"
  >
    <div class="head">
      <span class="mark" aria-hidden="true">?</span>
      <span>Claude asks</span>
      <span class="effect">{questions.length} question{questions.length === 1 ? "" : "s"}</span>
    </div>

    {#each questions as q, i (i)}
      <fieldset class="question">
        <legend class="q-title">
          <span class="key">{i + 1} / {questions.length}{q.header ? ` · ${q.header}` : ""}</span>
          {q.question}
          {#if q.multiSelect}<span class="effect">pick any</span>{/if}
        </legend>
        {#each q.options as o (o.label)}
          <label class="option">
            <input
              type={q.multiSelect ? "checkbox" : "radio"}
              name="q{i}"
              checked={(picks[i] ?? []).includes(o.label)}
              onchange={() => toggle(i, o.label, !!q.multiSelect)}
            />
            <span class="o-label">{o.label}</span>
            {#if o.description}<span class="o-desc">{o.description}</span>{/if}
          </label>
        {/each}
        <label class="option">
          <span class="o-label">Other</span>
          <input class="reason" type="text" bind:value={others[i]} placeholder="type an answer" />
        </label>
      </fieldset>
    {/each}

    <div class="actions">
      <button class="btn allow" disabled={!answered} onclick={answerQuestions}>Answer</button>
      <button
        class="btn deny"
        onclick={() => {
          reason = reason.trim() || "the user skipped the question; decide yourself";
          decide("deny");
        }}
      >
        Skip — let it decide
      </button>
    </div>
    <p class="hint">The answers go back as the tool's input; the turn continues from here.</p>
  </div>
{:else if kind === "plan"}
  <div class="approval" bind:this={box} tabindex="-1" role="group" aria-label="plan approval">
    <div class="head">
      <span class="mark" aria-hidden="true">⚑</span>
      <span>Plan — nothing has been edited yet</span>
      <span class="effect">ExitPlanMode</span>
    </div>

    {#if plan !== null}
      <pre class="val plan">{plan}</pre>
    {:else}
      <div class="args">
        {#each fields as f, i (i)}
          <div class="arg">
            {#if f.key}<div class="key">{f.key}</div>{/if}
            <pre class="val">{f.value}</pre>
          </div>
        {/each}
      </div>
    {/if}

    <div class="actions">
      <button class="btn allow" onclick={() => decide("allow", req.input, then)}>Approve</button>
      <span class="then" role="radiogroup" aria-label="after approval">
        <span class="then-l">then</span>
        <label class="then-o"><input type="radio" name="then-{req.id}" value="ask" bind:group={then} /> Ask</label>
        <label class="then-o" title="Claude Code's auto mode is not available to this account's headless sessions; the chat starts in Manual, with no prompts, so its first write is refused (blocker 079)"><input type="radio" name="then-{req.id}" value="auto" bind:group={then} /> Auto (Manual on this account)</label>
      </span>
      <button
        class="btn deny"
        onclick={() => {
          reason = reason.trim() || "keep planning: the user wants changes to the plan";
          decide("deny");
        }}
      >
        Keep planning
      </button>
    </div>
    <input
      class="reason"
      type="text"
      bind:value={reason}
      placeholder="what to change (optional, sent with Keep planning)"
    />
    <p class="hint">
      Nothing has been edited. Approve lets the model start on it, as Ask (each
      write still asks) or Auto (its classifier decides); the rail's Approval
      switch follows your pick.{#if planFile} The CLI keeps the plan at <code>{planFile}</code>.{/if}
    </p>
  </div>
{:else if deferred}
  <div
    class="approval"
    bind:this={box}
    tabindex="-1"
    role="group"
    aria-label="permission required to run {req.name}"
  >
    <div class="head">
      <span class="mark" aria-hidden="true">⚠</span>
      <span>Run <code>{req.name}</code>?</span>
      <span class="effect">paused · waiting for you</span>
    </div>

    <div class="args">
      {#each fields as f, i (i)}
        <div class="arg">
          {#if f.key}<div class="key">{f.key}</div>{/if}
          <pre class="val">{f.value}</pre>
        </div>
      {/each}
    </div>

    <div class="actions">
      <button class="btn allow" onclick={() => decide("allow")}>Allow</button>
      <button class="btn" onclick={() => decide("always")}>Allow for this chat</button>
      <button class="btn deny" bind:this={denyButton} onclick={() => decide("deny")}>Deny</button>
    </div>
    <input
      class="reason"
      type="text"
      bind:this={reasonInput}
      bind:value={reason}
      onkeydown={onReasonKey}
      placeholder="why not? (optional, sent with Deny)"
    />
    <p class="hint">
      Claude Code has paused on this call and waits until you answer. "Allow for
      this chat" lets every later <code>{req.name}</code> in this chat run
      unasked.
    </p>
  </div>
{:else}
<div
  class="approval"
  bind:this={box}
  tabindex="-1"
  role="group"
  aria-label="permission required to run {req.name}"
>
  <div class="head">
    <span class="mark" aria-hidden="true">⚠</span>
    <span>Run <code>{req.name}</code>?</span>
    <span class="effect">{req.effect.replace("_", " ")}</span>
  </div>

  <div class="args">
    {#each fields as f, i (i)}
      <div class="arg">
        {#if f.key}<div class="key">{f.key}</div>{/if}
        <pre class="val">{f.value}</pre>
      </div>
    {/each}
  </div>

  <div class="actions">
    <button class="btn allow" onclick={() => decide("allow")}>Allow once</button>
    <button class="btn" onclick={() => decide("always")}>
      Always allow {req.name}
    </button>
    <button class="btn deny" bind:this={denyButton} onclick={onDeny}>
      {denying ? "Deny" : "Deny…"}
    </button>
  </div>

  {#if denying}
    <input
      class="reason"
      type="text"
      bind:this={reasonInput}
      bind:value={reason}
      onkeydown={onReasonKey}
      placeholder="why not? (optional)"
    />
    <p class="hint">
      The model is told this verbatim, so it can try something else. Enter to
      deny · Esc to go back.
    </p>
  {/if}
</div>
{/if}

<style>
  .approval {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 0.7rem 0.8rem;
  }
  .approval:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    font-size: 0.88rem;
  }
  .mark {
    color: var(--accent);
  }
  .head code {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--accent);
  }
  .effect {
    margin-left: auto;
    font-size: 0.68rem;
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    white-space: nowrap;
  }
  .args {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .key {
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--dim);
    margin-bottom: 0.15rem;
  }
  /* Values wrap and scroll rather than being elided: a command you cannot
     read in full is not something you can agree to. */
  .val {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    margin: 0;
    max-height: 12rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }
  .btn {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.35rem 0.75rem;
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
  }
  .btn:hover {
    border-color: var(--accent);
  }
  .btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .btn.allow {
    background: var(--accent);
    color: var(--paper);
    border-color: var(--accent);
    font-weight: 600;
  }
  .btn.allow:hover {
    filter: brightness(1.1);
  }
  .btn.deny {
    color: var(--error);
    border-color: rgba(246, 109, 124, 0.4);
  }
  .btn.deny:hover {
    border-color: var(--error);
  }
  .reason {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.55rem;
    font-size: 0.8rem;
    font-family: inherit;
    width: 100%;
  }
  .reason:focus {
    outline: none;
    border-color: var(--accent);
  }
  .hint {
    margin: 0;
    font-size: 0.68rem;
    line-height: 1.35;
    color: var(--dim);
  }
  /* The question form and the plan card (backlog 084): the existing
     tokens, plain rows. */
  .question {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .q-title {
    font-size: 0.84rem;
    color: var(--text);
    padding: 0 0.25rem;
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
  }
  .option {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .option .reason {
    width: auto;
    flex: 1;
  }
  .o-desc {
    font-size: 0.72rem;
    color: var(--dim);
  }
  .val.plan {
    max-height: 22rem;
  }
  /* The plan card's "then Ask | Auto" pick (backlog 085): plain radios
     beside Approve. */
  .then {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
    color: var(--dim);
  }
  .then-o {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    color: var(--text);
    cursor: pointer;
  }
  .hint code {
    font-family: var(--mono);
    font-size: 0.95em;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
