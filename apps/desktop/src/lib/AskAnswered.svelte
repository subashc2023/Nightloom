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

  import { closedAskReason, closedPickText, sendAskAnswer } from "./askSettled";
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
        <div class="aa-opts">
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
  .aa-chip-closed {
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
