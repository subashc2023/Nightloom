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
  import { askStacks } from "./askSettled";
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
  // Item 884 (option A, the stack rule): any answer past 40 characters stacks every answer full width.
  const stack = $derived(askStacks(ask.options));

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

<div class="turn-ask lk-shell" class:sending data-turn-ask={idBase} data-stack={stack ? "1" : undefined} aria-busy={sending} bind:this={shell}>
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
  /* Item 884 (option A, Control row — his pick; the stack rule for long answers): in Jarvis the card is the
     question box's and the hand-off card's glass — the amber-tinted top and thin amber edge — and Send
     answer is the hand-off's Wrap up now (the terminal fill, the amber edge and glow), not a tan pill. The
     answers are the box's buttons (src/askLook.css): the number key first, no radio dot (a click sends),
     side by side while short; once any answer passes 40 characters (`data-stack`), all stack full width.
     Other and an option's comment field always take a full row. Classic keeps the rules above. */
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
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opts) {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px;
    margin-left: 0;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick) {
    align-items: flex-start;
    gap: 9px;
    max-width: 100%;
    min-height: 30px;
    box-sizing: border-box;
    margin: 0;
    padding: 5px 8px 5px 7px;
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    background: var(--well);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick .aq-mk) {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick .aq-ot) {
    flex: 0 1 auto;
    padding-right: 4px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick .aq-ol) {
    font-size: 13.5px;
    font-weight: 500;
    line-height: 18px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick .aq-k) {
    order: -1;
    display: inline-grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    box-sizing: border-box;
    margin: 0;
    padding: 0 4px;
    border: 1px solid var(--line2);
    border-radius: 3px;
    background: var(--term);
    line-height: 1;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick .aq-cb) {
    height: 18px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick:hover),
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick:has(.aq-in:focus-visible)) {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 70%, var(--line2));
    background: var(--well2);
    box-shadow:
      inset 0 0 10px color-mix(in srgb, var(--accent) 12%, transparent),
      var(--glow-main, none);
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick:hover .aq-ol),
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick:has(.aq-in:focus-visible) .aq-ol) {
    color: var(--accent-ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick:hover .aq-k) {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--line2));
    color: var(--accent-ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-opt.quick.on) {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent-soft) 70%, var(--well));
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-other),
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask :global(.aq-cm) {
    flex: 1 0 100%;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask[data-stack] :global(.aq-opts) {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask[data-stack] :global(.aq-opt.quick) {
    width: 100%;
    padding-top: 6px;
    padding-bottom: 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .turn-ask[data-stack] :global(.aq-opt.quick .aq-ot) {
    flex: 1 1 auto;
  }
</style>
