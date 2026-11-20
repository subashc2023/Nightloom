<script lang="ts" module>
  // What he has picked and typed on a card not yet sent, by card (chat + reply): the card is redrawn on a
  // tab switch or a return to the chat, and half-typed words must still be there (practices §7).
  interface AskDraft {
    picks: Record<number, string[]>;
    others: Record<number, string>;
    notes: Record<number, Record<string, string>>;
  }
  const drafts = new Map<string, AskDraft>();
</script>

<script lang="ts">
  /**
   * The turn-end question card (nightshift item 753): one question, one or two answers, kept under the chat
   * until he answers. It is the model's question card (354) with 712's comment on each option — the same
   * `AskQuestions`, handed `onquick`: a click on an answer sends it at once; a comment typed on an option
   * goes with it (`Label (note: …)`); Other is typed and sent with Enter or Send. The host decides what
   * "send" does (the desktop: his next message + an answered blocker; the phone: his next message).
   */
  import AskQuestions from "./AskQuestions.svelte";
  import AskLock from "./AskLock.svelte";
  import { flyAnswer } from "./askMotion";
  import { answerText, isAnswered } from "./askQuestions";
  import type { Ask } from "./askTag";
  import type { AskQuestion } from "./types";

  let {
    ask,
    idBase,
    onsend,
    sending = false,
    note = "",
  }: {
    ask: Ask;
    /** Unique per card (chat + reply): element ids, and the key his unsent words are kept under. */
    idBase: string;
    onsend: (answer: string) => void;
    /** The answer is on its way: the card greys and takes no second click. */
    sending?: boolean;
    /** A line under the card: where the answer is filed. */
    note?: string;
  } = $props();

  // (Read once, at mount: a function, so the prop is not captured as a stale value.)
  const keptDraft = (): AskDraft | undefined => drafts.get(idBase);
  const kept = keptDraft();
  let picks = $state<Record<number, string[]>>(kept?.picks ?? {});
  let others = $state<Record<number, string>>(kept?.others ?? {});
  let notes = $state<Record<number, Record<string, string>>>(kept?.notes ?? {});
  $effect(() => {
    drafts.set(idBase, { picks: $state.snapshot(picks), others: $state.snapshot(others), notes: $state.snapshot(notes) });
  });

  const questions = $derived<AskQuestion[]>([
    { question: ask.question, header: "needs you", options: ask.options.map((label) => ({ label })), multiSelect: false },
  ]);
  const ready = $derived(isAnswered(picks[0], others[0]));

  function toggle(i: number, label: string) {
    picks[i] = picks[i]?.[0] === label ? [] : [label];
    if (picks[i].length) others[i] = "";
  }
  function other(i: number, value: string) {
    others[i] = value;
    if (value.trim()) picks[i] = [];
  }
  let shell = $state<HTMLDivElement | null>(null);

  /** The picked answer's row, by its label (the click that picked it has not redrawn the card yet). */
  function pickedRow(): HTMLElement | null {
    const label = picks[0]?.[0];
    if (!label || !shell) return null;
    return [...shell.querySelectorAll<HTMLElement>(".aq-opt")].find((o) => o.querySelector(".aq-ol")?.textContent === label) ?? null;
  }

  function onquick() {
    if (sending) return;
    const answer = answerText(picks[0], others[0], notes[0]);
    if (!answer) return;
    drafts.delete(idBase);
    // Wave K (his pick, blocker 2031): the answer is carried down a thread into the message box and the card
    // folds to a receipt — a copy over the page; the real card goes as it always did.
    flyAnswer(shell, pickedRow(), answer);
    onsend(answer);
  }
</script>

<div class="turn-ask lk-shell" class:sending data-turn-ask={idBase} aria-busy={sending} bind:this={shell}>
  <AskLock />
  <AskQuestions
    {questions}
    {idBase}
    {picks}
    {others}
    ontoggle={(i, label) => toggle(i, label)}
    onother={other}
    {notes}
    onnote={(i, label, value) => (notes[i] = { ...(notes[i] ?? {}), [label]: value })}
    {onquick}
  >
    {#snippet tail()}
      <button type="button" class="ta-send" disabled={!ready || sending} onclick={onquick}>{sending ? "Sending…" : "Send answer"}</button>
    {/snippet}
  </AskQuestions>
  {#if note}<div class="ta-note">{note}</div>{/if}
</div>

<style>
  .turn-ask {
    margin: 14px 0 6px;
    padding: 14px 16px;
    border: 1px solid var(--line2);
    border-radius: 12px;
    background: var(--sheet);
    container-type: inline-size;
  }
  /* A narrow column (390): Jarvis's tracked uppercase header clipped to "NEEDS YO" beside the button;
     tighter tracking keeps it whole on one line (Classic's header is sentence case and already fits). */
  @container (max-width: 400px) {
    :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-one) {
      letter-spacing: 0.04em;
    }
  }
  .turn-ask.sending {
    opacity: 0.6;
    pointer-events: none;
  }
  .ta-send {
    font: inherit;
    font-size: 12.5px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--accent-ink);
    background: var(--accent-soft);
    color: var(--accent-ink);
    cursor: pointer;
    white-space: nowrap;
    flex: none;
  }
  .ta-send:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .ta-note {
    margin-top: 8px;
    font-size: 12px;
    color: var(--dim);
  }
  /* Item 884 (option B, Console rows): in Jarvis the card is the question box's and the hand-off card's
     glass — the amber-tinted top and thin amber edge — and Send answer is the hand-off's Wrap up now (the
     terminal fill, the amber edge and glow), not a tan pill. Classic keeps the rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask {
    border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--line2));
    border-radius: var(--r2);
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 6%, var(--raised)), var(--raised) 64%);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, var(--accent) 24%, transparent),
      0 10px 28px -8px rgba(0, 0, 0, 0.5);
    /* The sticky header strip's fill: the glass's tinted top, so no band shows under it. */
    --aq-bg: color-mix(in srgb, var(--accent) 6%, var(--raised));
  }
  :global(:where(:root:not([data-layout="classic"]))) .ta-send {
    min-height: 28px;
    padding: 3px 12px;
    border-radius: var(--r1);
    border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--line2));
    background: var(--term);
    color: var(--accent-ink);
    font-weight: 500;
    box-shadow:
      inset 0 0 10px color-mix(in srgb, var(--accent) 14%, transparent),
      var(--glow-main, none);
  }
  :global(:where(:root:not([data-layout="classic"]))) .ta-send:hover:not(:disabled) {
    background: var(--well);
  }
  :global(:where(:root:not([data-layout="classic"]))) .ta-send:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .ta-send:disabled {
    box-shadow: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .ta-note {
    font: 11px var(--mono);
  }
</style>
