<script lang="ts">
  // The answered question (backlog 354, his pick: "I like how the tabs view of the answered portion looks
  // visually"): look B's quiet card under the AskUserQuestion call — an "Answered" chip, then each question's
  // header beside its answer. The answers are the ones he gave here (recorded by call id); a call answered on
  // the phone, or before 354, reads them back out of the CLI's result. Nothing readable → nothing drawn.
  import { app, type ToolCallView } from "./state.svelte";
  import type { AskQuestion } from "./types";
  import { answeredRows, answersFromResult } from "./askQuestions";
  import { recordedAnswers } from "./askAnswers.svelte";
  import { tip } from "./tip";

  let { call }: { call: ToolCallView } = $props();

  const questions = $derived.by<AskQuestion[]>(() => {
    const q = (call.input as { questions?: unknown } | null)?.questions;
    return Array.isArray(q) ? (q as AskQuestion[]) : [];
  });
  const rows = $derived.by(() => {
    // Still waiting (its card may be drawn at the transcript's foot rather than under this row): no table yet.
    if (call.denied || app.pendingApprovals.some((a) => a.id === call.id)) return [];
    const mine = recordedAnswers(call.id)?.rows;
    if (mine && mine.length) return mine;
    return answeredRows(questions, answersFromResult(call.result?.content));
  });
</script>

{#if rows.length}
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
              >{#each r.answer.split(", ") as a, k (k)}<span class="aa-ans">{a}</span>{/each}</td
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
