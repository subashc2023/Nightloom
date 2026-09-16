<script lang="ts">
  import { tick } from "svelte";
  import { app, resolveApproval } from "./state.svelte";
  import { draftKey, enqueueMessage } from "./drafts.svelte";
  import { routeNote } from "./askNote";
  import { renderMarkdown } from "./markdown";
  import { inputFields } from "./toolinput";
  import Icon from "./Icon.svelte";
  import type { ApprovalRequest, AskQuestion } from "./types";

  let { req }: { req: ApprovalRequest } = $props();

  const fields = $derived(inputFields(req.input));

  // On the Claude Code engine every prompt is a call the CLI *deferred*
  // (nightshift backlog 084): the process has exited on it, the answer is
  // written for the CLI's hook and the session resumed. Three shapes live
  // here for that engine — the permission prompt, the model's question
  // (`AskUserQuestion`), the plan card (`ExitPlanMode`) — with the control
  // set the design fixed: Allow · Allow for this chat · Deny, nothing arming
  // into a second click. Since pass 2 (2026-09-16, the approved boards 2a–2d)
  // each carries one optional note field above its buttons, a chevron that
  // folds it to one line, and — the question form and the plan card — a cap
  // on its height with a drag edge at the foot. The API engine's prompt
  // below them is left exactly as it was.
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

  // ---- the note (pass 2) ------------------------------------------------
  // One field, the same on all three cards, and one rule for where its text
  // goes (`routeNote`): with the refusing button it is the deny reason the
  // model reads before its next step; with the accepting button nothing the
  // model reads can ride with the call, so it is held as his next message
  // in the composer's queue (backlog 089) and goes when the turn ends. The
  // `?` beside the field says so on hover (blocker 031: hover text, no
  // prose). Nothing arms (blocker 041).
  let note = $state("");
  const NOTE_TIP = {
    call: "Deny — the note is the reason; the model reads it before its next step. Allow, Allow for this chat — the call runs, and the note is sent as your next message when this turn ends (it joins the queue).",
    question:
      "Skip — the note is the reason the model reads instead of answers. Answer — the answers go back now; the note is sent as your next message when this turn ends.",
    plan: "Keep planning — the note is why; the model reads it and plans again. Approve — the plan starts; the note is sent as your next message when that turn ends.",
  } as const;

  function decide(
    decision: "allow" | "always" | "deny",
    answer?: unknown,
    then?: "ask" | "auto",
    fallback?: string,
  ) {
    if (!deferred) {
      void resolveApproval(
        req.id,
        req.name,
        decision,
        decision === "deny" ? reason.trim() || undefined : undefined,
        answer,
        then,
      );
      return;
    }
    const route = routeNote(decision, note, fallback);
    if (route.enqueue) {
      // The composer's own key, so the held message shows in its queue
      // with a take-back, like one typed there.
      enqueueMessage(draftKey(app.activeSessionId, app.project?.id, app.pendingMode), route.enqueue, []);
    }
    void resolveApproval(req.id, req.name, decision, route.reason, answer, then);
  }

  // The permission card's strip says `⏎ allow · esc deny`; the other two
  // strips name no keys, so their fields take none — a plan should not be
  // approved by an Enter in a text box nothing on the board promised.
  function onNoteKey(e: KeyboardEvent) {
    if (kind !== "call") return;
    if (e.key === "Enter") {
      e.preventDefault();
      decide("allow");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      decide("deny");
    }
  }

  // ---- fold, cap, drag edge (pass 2) ------------------------------------
  // A chevron folds the card to its header row; it stays inline at the
  // foot of the paused turn (blocker 118's default). The question form is
  // capped at a third of the transcript viewport, the plan card at two
  // thirds — "takes up the space of the entire chat and then I can't even
  // see anything anymore" — and the body scrolls inside. The edge at the
  // foot drags a height for this chat, kept in localStorage; double-click
  // forgets it.
  let folded = $state(false);
  const CAP = { question: 1 / 3, plan: 2 / 3, call: 0 } as const;
  const MIN_HEIGHT = 160;
  let viewportH = $state(0);
  let dragged = $state<number | null>(null);

  const heightKey = $derived(`nightloom.ask.height.${app.activeSessionId ?? "pending"}.${kind}`);
  const capPx = $derived(CAP[kind] > 0 && viewportH > 0 ? Math.round(viewportH * CAP[kind]) : null);

  function loadHeight(key: string): number | null {
    try {
      const raw = localStorage.getItem(key);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) && n >= MIN_HEIGHT ? n : null;
    } catch {
      return null;
    }
  }
  function saveHeight(key: string, n: number | null): void {
    try {
      if (n === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(Math.round(n)));
    } catch {
      // Storage refused; the height holds for this card only.
    }
  }

  $effect(() => {
    dragged = loadHeight(heightKey);
  });

  // The transcript viewport is the scroll region the card sits in; its
  // height is the cap's base. Measured on mount and whenever it resizes.
  $effect(() => {
    if (!box || CAP[kind] === 0) return;
    const vp = box.closest(".transcript") as HTMLElement | null;
    const read = () => {
      viewportH = vp?.clientHeight || window.innerHeight;
    };
    read();
    if (vp && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(read);
      ro.observe(vp);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  });

  function clampHeight(n: number): number {
    const max = viewportH > 0 ? viewportH - 24 : Infinity;
    return Math.max(MIN_HEIGHT, Math.min(n, max));
  }

  function onGripDown(e: PointerEvent) {
    if (!box || e.button !== 0) return;
    const grip = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    const startH = box.getBoundingClientRect().height;
    let h = startH;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      h = clampHeight(startH + ev.clientY - startY);
      dragged = h;
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      saveHeight(heightKey, h);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
    e.preventDefault();
  }

  function resetHeight() {
    dragged = null;
    saveHeight(heightKey, null);
  }

  // ---- the model's reason (pass 2, round 2) -----------------------------
  // "Three kinds of text must read as three kinds": the command is code,
  // the note is the one input, and the model's reason — the `description`
  // the Bash tool's input carries — is plain model text in the transcript's
  // face, with room ("that's the important piece") and a "more" when it
  // still overflows.
  const REASON_KEY = "description";
  const codeFields = $derived(kind === "call" ? fields.filter((f) => f.key !== REASON_KEY) : fields);
  const why = $derived(kind === "call" ? (fields.find((f) => f.key === REASON_KEY)?.value ?? null) : null);
  let whyEl = $state<HTMLDivElement | null>(null);
  let whyLong = $state(false);
  let whyOpen = $state(false);
  $effect(() => {
    void why;
    if (whyEl && !whyOpen) whyLong = whyEl.scrollHeight > whyEl.clientHeight + 1;
  });

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

  const openCount = $derived(
    questions.filter((_, i) => (picks[i]?.length ?? 0) === 0 && (others[i] ?? "").trim() === "").length,
  );
  const answered = $derived(questions.length > 0 && openCount === 0);
  const questionStatus = $derived(
    openCount > 0 ? `${openCount} of ${questions.length} still open` : `all ${questions.length} answered`,
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
  // The Auto segment's title says "Manual on this account" (the
  // whole-project review of 2026-09-16, F6): every `auto` run of the night
  // came up as the CLI's `default` permission mode — `auto` is not
  // available to this account's headless sessions (blocker 079, open) —
  // and the position then has no hook and no prompt tool, so its first
  // write is refused. The label is honest until 079 answers; the position
  // itself is unchanged.
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

{#snippet foldButton()}
  <button
    class="fold"
    type="button"
    title={folded ? "expand" : "collapse to one line"}
    aria-label={folded ? "expand the card" : "collapse the card to one line"}
    aria-expanded={!folded}
    onclick={() => (folded = !folded)}
  >
    <span class="chev" class:up={folded}><Icon name="chev" size={14} /></span>
  </button>
{/snippet}

{#snippet noteField()}
  <div class="note-row">
    <input
      class="note"
      type="text"
      bind:value={note}
      onkeydown={onNoteKey}
      placeholder="Note for the model — optional"
      aria-label="note for the model, optional"
    />
    <span class="q" title={NOTE_TIP[kind]} aria-label={NOTE_TIP[kind]} role="img">?</span>
  </div>
{/snippet}

{#snippet grip()}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="grip"
    title="drag to resize · double-click resets to {kind === 'plan' ? 'two thirds' : 'a third'} of the transcript"
    onpointerdown={onGripDown}
    ondblclick={resetHeight}
  >
    <i></i>
  </div>
{/snippet}

{#if kind === "question"}
  <div
    class="ask"
    class:folded
    bind:this={box}
    tabindex="-1"
    role="group"
    aria-label="the model asks {questions.length} question{questions.length === 1 ? '' : 's'}"
    style:height={!folded && dragged !== null ? `${dragged}px` : null}
    style:max-height={!folded && dragged === null && capPx !== null ? `${capPx}px` : null}
  >
    <div class="head">
      <span class="mark" aria-hidden="true">?</span>
      <span>Claude asks</span>
      <span class="effect">{questions.length} question{questions.length === 1 ? "" : "s"}</span>
      {#if folded}<span class="st">{questionStatus} · waits until you answer</span>{/if}
      <span class="sp"></span>
      {@render foldButton()}
    </div>

    {#if !folded}
      <div class="scr">
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
              <input class="other" type="text" bind:value={others[i]} placeholder="type an answer…" />
            </label>
          </fieldset>
        {/each}
      </div>

      {@render noteField()}
      <div class="actions">
        <button class="ns-btn accent" disabled={!answered} onclick={answerQuestions}>Answer</button>
        <button
          class="ns-btn ghost"
          onclick={() => decide("deny", undefined, undefined, "the user skipped the question; decide yourself")}
        >
          Skip — let it decide
        </button>
        <span class="keys">{questionStatus} · answers go back as the tool's input</span>
      </div>
      {@render grip()}
    {/if}
  </div>
{:else if kind === "plan"}
  <div
    class="ask"
    class:folded
    bind:this={box}
    tabindex="-1"
    role="group"
    aria-label="plan approval"
    style:height={!folded && dragged !== null ? `${dragged}px` : null}
    style:max-height={!folded && dragged === null && capPx !== null ? `${capPx}px` : null}
  >
    <div class="head">
      <span class="mark" aria-hidden="true">⚑</span>
      <span>Plan — nothing has been edited yet</span>
      {#if planFile}
        <span class="effect mono" title="the CLI keeps the plan here">{planFile}</span>
      {:else}
        <span class="effect">ExitPlanMode</span>
      {/if}
      {#if folded}<span class="st">waits until you answer</span>{/if}
      <span class="sp"></span>
      {@render foldButton()}
    </div>

    {#if !folded}
      <div class="scr">
        {#if plan !== null}
          <!-- The plan is model text, in the transcript's face; the rule
               under it keeps it from reading as part of the form. -->
          <div class="planv">
            <div class="markdown">{@html renderMarkdown(plan)}</div>
          </div>
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
      </div>
      <div class="rule"></div>

      {@render noteField()}
      <div class="actions">
        <button class="ns-btn accent" onclick={() => decide("allow", req.input, then)}>Approve</button>
        <button
          class="ns-btn outline"
          onclick={() => decide("deny", undefined, undefined, "keep planning: the user wants changes to the plan")}
        >
          Keep planning
        </button>
        <span class="keys">the note goes with either · kept with this chat</span>
        <span
          class="then"
          role="radiogroup"
          aria-label="after approval"
          title="After approval: Ask keeps the permission cards; Auto lets the classifier decide (backlog 085)"
        >
          <span class="then-l">then</span>
          <span class="segs">
            <button
              type="button"
              class="seg"
              class:on={then === "ask"}
              role="radio"
              aria-checked={then === "ask"}
              onclick={() => (then = "ask")}>Ask</button
            >
            <button
              type="button"
              class="seg"
              class:on={then === "auto"}
              role="radio"
              aria-checked={then === "auto"}
              title="Claude Code's auto mode is not available to this account's headless sessions; the chat starts in Manual, with no prompts, so its first write is refused (blocker 079)"
              onclick={() => (then = "auto")}>Auto</button
            >
          </span>
        </span>
      </div>
      {@render grip()}
    {/if}
  </div>
{:else if deferred}
  <div
    class="ask"
    class:folded
    bind:this={box}
    tabindex="-1"
    role="group"
    aria-label="permission required to run {req.name}"
  >
    <div class="head">
      <span class="mark" aria-hidden="true">⚠</span>
      <span>Run <code>{req.name}</code>?</span>
      <span class="effect">paused · waiting for you</span>
      <span class="sp"></span>
      {@render foldButton()}
    </div>

    {#if !folded}
      <!-- Three kinds of text (round 2): the command as code, the model's
           reason as model text, the note as the one input. -->
      <div class="args">
        {#each codeFields as f, i (i)}
          <div class="arg">
            {#if f.key}<div class="key">{f.key}</div>{/if}
            <pre class="val">{f.value}</pre>
          </div>
        {/each}
      </div>
      {#if why !== null}
        <div class="arg">
          <div class="key">why the model wants it</div>
          <div class="why" class:open={whyOpen} bind:this={whyEl}>{why}</div>
          {#if whyLong || whyOpen}
            <button class="more" type="button" onclick={() => (whyOpen = !whyOpen)}>
              {whyOpen ? "less" : "more"}
            </button>
          {/if}
        </div>
      {/if}

      {@render noteField()}
      <div class="actions">
        <button class="ns-btn accent" onclick={() => decide("allow")}>Allow</button>
        <button
          class="ns-btn"
          title="every later {req.name} in this chat runs unasked"
          onclick={() => decide("always")}>Allow for this chat</button
        >
        <button class="ns-btn danger" bind:this={denyButton} onclick={() => decide("deny")}>Deny</button>
        <span class="keys">⏎ allow · esc deny · the note goes with either</span>
      </div>
    {/if}
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

  /* ---- the three cards of the Claude Code engine (backlog 084 pass 2,
     boards 2a–2d): the sheet with an accent border, a header row, a body
     that scrolls under the cap, the note, the buttons, the drag edge. ---- */
  .ask {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    min-height: 0;
    background: var(--sheet);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 10px 14px 14px;
  }
  .ask:focus {
    outline: none;
  }
  .ask.folded {
    padding: 8px 14px;
    gap: 0;
  }
  .ask .head {
    align-items: center;
    gap: 8px;
    font-size: 14px;
    min-height: 22px;
    flex: none;
  }
  .ask .effect {
    margin-left: 0;
    font-size: 11px;
    line-height: 1.5;
    padding: 0 8px;
    border-color: var(--line2);
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22rem;
  }
  .ask .effect.mono {
    font-family: var(--mono);
  }
  .ask .head .st {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ask .head .sp {
    flex: 1;
  }
  .fold {
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--dim);
    background: transparent;
    border: 1px solid transparent;
    padding: 0;
    cursor: pointer;
  }
  .fold:hover {
    border-color: var(--line2);
    color: var(--ink);
  }
  .fold:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .chev {
    display: inline-flex;
    transition: transform 0.12s;
  }
  .chev.up {
    transform: rotate(180deg);
  }
  /* The body: what scrolls when the card is capped or dragged shorter. */
  .scr {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 4px;
  }
  .ask .args,
  .ask .arg,
  .note-row,
  .ask .actions,
  .rule {
    flex: none;
  }
  /* The model's reason (round 2): the transcript's face, six lines by
     default, "more" when it still overflows. */
  .why {
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 16px);
    line-height: 1.55;
    color: var(--ink);
    max-height: 9.4em;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .why.open {
    max-height: none;
  }
  .more {
    background: transparent;
    border: none;
    padding: 2px 0;
    margin-top: 2px;
    font-family: var(--sans);
    font-size: 12px;
    color: var(--accent);
    cursor: pointer;
  }
  .more:hover {
    color: var(--accent-ink);
    text-decoration: underline;
  }
  /* The note: the composer's field — paper, the line, accent on focus. */
  .note-row {
    position: relative;
    display: flex;
    align-items: center;
  }
  .note {
    flex: 1;
    min-width: 0;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 5px 30px 5px 10px;
    min-height: 32px;
    box-sizing: border-box;
    transition: border-color 0.12s;
  }
  .note::placeholder {
    color: var(--dim);
  }
  .note:focus {
    outline: none;
    border-color: var(--accent);
  }
  .note-row .q {
    position: absolute;
    right: 10px;
    font-size: 12px;
    color: var(--dim);
    cursor: help;
    user-select: none;
  }
  .ask .actions {
    align-items: center;
    gap: 8px;
  }
  .ask .actions .keys {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
  }
  /* Keep planning: the outline variant the board draws; app.css has none. */
  .ns-btn.outline {
    background: transparent;
    color: var(--accent);
    border-color: var(--accent);
  }
  .ns-btn.outline:hover:not(:disabled) {
    color: var(--accent-ink);
    border-color: var(--accent-ink);
  }
  .ns-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* The drag edge at the foot. */
  .grip {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: ns-resize;
    touch-action: none;
  }
  .grip i {
    width: 36px;
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
  }
  .grip:hover i {
    background: var(--accent);
  }
  /* The question form: plain rows, the existing tokens. */
  .question {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex: none;
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
  .other {
    flex: 1;
    min-width: 0;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
    font-size: 0.8rem;
    font-family: inherit;
  }
  .other::placeholder {
    color: var(--dim);
  }
  .other:focus {
    outline: none;
    border-color: var(--accent);
  }
  .o-desc {
    font-size: 0.72rem;
    color: var(--dim);
  }
  /* The plan: model text in the transcript's face, then a rule before the
     form (round 2: "separate the plan from the note"). */
  .planv {
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 12px 16px;
  }
  .planv :global(.markdown) {
    font-family: var(--transcript-font, var(--sans));
    font-size: calc(var(--transcript-size, 16px) - 1px);
    line-height: 1.55;
    color: var(--ink);
  }
  .rule {
    height: 1px;
    background: var(--line);
    margin: 2px 0;
  }
  /* The "then Ask | Auto" pick (backlog 085), a small selector at the
     right of the actions — the rail's segment idiom at chip size. */
  .then {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--dim);
    margin-left: 8px;
  }
  .segs {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 7px;
  }
  .seg {
    padding: 1px 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    cursor: pointer;
  }
  .seg.on {
    background: var(--sheet);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .seg:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
