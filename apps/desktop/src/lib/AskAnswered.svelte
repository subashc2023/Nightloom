<script lang="ts">
  // The answered question (backlog 354, his pick: "I like how the tabs view of the answered portion looks
  // visually"): look B's quiet card under the AskUserQuestion call — an "Answered" chip, then each question's
  // header beside its answer. The answers are the ones he gave here (recorded by call id); a call answered on
  // the phone, or before 354, reads them back out of the CLI's result. Nothing readable → nothing drawn.
  import { app, type ToolCallView } from "./state.svelte";
  import type { AskQuestion } from "./types";
  import { answeredRows, answerParts, answersFromResult } from "./askQuestions";
  import { recordedAnswers } from "./askAnswers.svelte";
  import { tip } from "./tip";

  import { askStacks, closedAskReason, closedPickText, numberKey, sendAskAnswer } from "./askSettled";
  // Item 859: `ended` — the reply this call is in is not streaming (its turn is over, or it is from the log).
  let { call, ended = false }: { call: ToolCallView; ended?: boolean } = $props();

  const questions = $derived.by<AskQuestion[]>(() => {
    const q = (call.input as { questions?: unknown } | null)?.questions;
    return Array.isArray(q) ? (q as AskQuestion[]) : [];
  });
  const labelsOf = (question: string): string[] =>
    questions.find((q) => q.question === question)?.options.map((o) => o.label) ?? [];
  const rows = $derived.by(() => {
    // Still waiting (its card may be drawn at the transcript's foot rather than under this row): no table yet.
    if (call.denied || app.pendingApprovals.some((a) => a.id === call.id)) return [];
    const mine = recordedAnswers(call.id)?.rows;
    if (mine && mine.length) return mine;
    return answeredRows(questions, answersFromResult(call.result?.content));
  });
  // Item 859: closed without his answer — the card says so and why, and its options still send.
  const waiting = $derived(app.pendingApprovals.some((a) => a.id === call.id));
  const closed = $derived(questions.length ? closedAskReason(call, rows.length > 0, waiting, ended) : null);
  let sent = $state(false);
  let card = $state<HTMLDivElement | null>(null);
  function pick(q: AskQuestion, label: string) {
    if (sent || !card) return;
    const answer = closedPickText(q.header || "Answer", label, questions.length > 1);
    if (sendAskAnswer(card, { answer, ask: { question: q.question, options: q.options.map((o) => o.label) } })) sent = true;
  }
</script>

{#if closed}
  <div class="aa aa-closed" role="group" aria-label="a question that closed without your answer" bind:this={card}>
    <div class="aa-head">
      <span class="aa-chip aa-chip-closed">Closed — not answered</span>
      <span class="aa-sub">{questions.length === 1 ? "1 question" : `${questions.length} questions`}</span>
    </div>
    {#each questions as q, i (i)}
      <div class="aa-q">
        <div class="aa-qt">{q.question}</div>
        <!-- Item 884: 1–9 on a focused answer sends that numbered answer (each shows its key). -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="aa-opts"
          data-stack={askStacks(q.options.map((o) => o.label)) ? "1" : undefined}
          onkeydown={(e) => {
            const n = numberKey(e);
            const o = n ? q.options[n - 1] : undefined;
            if (!o) return;
            e.preventDefault();
            pick(q, o.label);
          }}
        >
          {#each q.options as o (o.label)}
            <button type="button" class="aa-pick" disabled={sent} onclick={() => pick(q, o.label)}>{o.label}</button>
          {/each}
        </div>
      </div>
    {/each}
    <div class="aa-why">{closed} {sent ? "Your pick was sent." : "Pick one to send it as your next message."}</div>
  </div>
{:else if rows.length}
  <div class="aa" role="group" aria-label="your answers">
    <div class="aa-head">
      <span class="aa-chip"
        ><svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"
          ><path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          /></svg
        > Answered</span
      >
      <span class="aa-sub">{rows.length === 1 ? "1 question" : `${rows.length} questions`}</span>
    </div>
    <table class="aa-table">
      <tbody>
        {#each rows as r, i (i)}
          <tr>
            <th scope="row" use:tip={r.question}>{r.header}</th>
            <td
              >{#each answerParts(r.answer, labelsOf(r.question)) as a, k (k)}<span class="aa-ans">{a}</span>{/each}</td
            >
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .aa {
    margin: 6px 0 4px;
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
    max-width: 100%;
    /* Item 859: settled cards are 851's filled look — no dot ground through them. */
    background: var(--raised);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.16),
      0 8px 22px -12px rgba(0, 0, 0, 0.45);
  }
  /* Item 884: two classes, so it beats `.aa-chip` below (the closed chip drew in the answered green). */
  .aa-chip.aa-chip-closed {
    background: var(--well);
    color: var(--dim);
  }
  .aa-q {
    padding: 8px 12px 2px;
    font-family: var(--sans);
    font-size: 13px;
  }
  .aa-qt {
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .aa-opts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .aa-pick {
    font: inherit;
    font-size: 12.5px;
    /* Item 884: a long answer that wraps reads left-aligned, not centred. */
    text-align: left;
    padding: 3px 12px;
    border-radius: 999px;
    border: 1px solid var(--accent-ink);
    background: var(--accent-soft);
    color: var(--accent-ink);
    cursor: pointer;
  }
  .aa-pick:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Item 884 (option A, Control row — his pick; the stack rule): in Jarvis a closed card's answers are the
     question box's buttons (src/askLook.css) — a number key first, side by side while short; once any
     answer of a question passes 40 characters (`data-stack`), that question's answers stack full width.
     Hover or focus lights the edge amber; 1–9 on a focused answer sends that one. Classic keeps the pills. */
  :global(:where(:root:not([data-layout="classic"]))) .aa-closed .aa-opts {
    align-items: flex-start;
    gap: 8px;
    margin-top: 10px;
    counter-reset: aa-pick;
  }
  :global(:where(:root:not([data-layout="classic"]))) .aa-closed .aa-opts[data-stack] {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .aa-pick {
    counter-increment: aa-pick;
    display: inline-flex;
    align-items: flex-start;
    gap: 9px;
    max-width: 100%;
    min-height: 30px;
    box-sizing: border-box;
    margin: 0;
    padding: 5px 12px 5px 7px;
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    background: var(--well);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    color: var(--ink);
    font: 500 13.5px/18px var(--sans);
    text-align: left;
    overflow-wrap: anywhere;
  }
  :global(:where(:root:not([data-layout="classic"]))) .aa-opts[data-stack] .aa-pick {
    display: flex;
    width: 100%;
    padding-top: 6px;
    padding-bottom: 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .aa-pick::before {
    content: counter(aa-pick);
    flex: none;
    display: inline-grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    box-sizing: border-box;
    padding: 0 4px;
    border: 1px solid var(--line2);
    border-radius: 3px;
    background: var(--term);
    font: 10.5px/1 var(--mono);
    color: var(--dim);
  }
  :global(:where(:root:not([data-layout="classic"]))) .aa-pick:is(:hover, :focus-visible):not(:disabled) {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 70%, var(--line2));
    background: var(--well2);
    box-shadow:
      inset 0 0 10px color-mix(in srgb, var(--accent) 12%, transparent),
      var(--glow-main, none);
    color: var(--accent-ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .aa-pick:is(:hover, :focus-visible):not(:disabled)::before {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--line2));
    color: var(--accent-ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .aa-closed .aa-why {
    font: 11px var(--mono);
  }
  .aa-why {
    padding: 8px 12px 10px;
    font-family: var(--sans);
    font-size: 12px;
    color: var(--dim);
  }
  .aa-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  .aa-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--sans);
    font-size: 12px;
    border-radius: 999px;
    padding: 2px 9px;
    background: var(--done-soft);
    color: var(--done);
  }
  .aa-sub {
    font-family: var(--sans);
    font-size: 12px;
    color: var(--dim);
  }
  .aa-table {
    border-collapse: collapse;
    width: 100%;
    font-family: var(--sans);
    font-size: 13px;
  }
  .aa-table th {
    text-align: left;
    font-weight: 400;
    color: var(--dim);
    padding: 7px 12px;
    width: 1%;
    white-space: nowrap;
    vertical-align: top;
    font-size: 12.5px;
  }
  .aa-table td {
    padding: 4px 12px 4px 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .aa-ans {
    display: inline-block;
    background: var(--well);
    border-radius: 6px;
    padding: 1px 8px;
    margin: 2px 5px 2px 0;
  }
</style>
