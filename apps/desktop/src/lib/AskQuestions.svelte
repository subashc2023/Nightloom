<script lang="ts">
  // The model's questions (`AskUserQuestion`), backlog 354 — his pick of 2026-10-13: "have the tabs at the top
  // and after each question there should be a next button, but then you can also just scroll and once you scroll
  // to like the next question, then it just goes to the next tab. I like the structure of inline in terms of how
  // the questions are asked." So: a tab strip on top (one tab per question, a check once answered), every
  // question inline below it in one scroll (look A's rows), a Next under each but the last, and the lit tab
  // follows the scroll. Drawn by the desktop card (ApprovalPrompt) and the phone's card (Remote); each host
  // keeps its own note, Answer and Skip, and owns `picks`/`others`.
  import type { Snippet } from "svelte";
  import type { AskQuestion } from "./types";
  import { hasPreviews, isAnswered, keyPick, previewOption, spyIndex } from "./askQuestions";

  let {
    questions,
    idBase,
    picks,
    others,
    ontoggle,
    onother,
    folded = false,
    tail,
  }: {
    questions: AskQuestion[];
    idBase: string;
    picks: Record<number, string[]>;
    others: Record<number, string>;
    ontoggle: (i: number, label: string, multi: boolean) => void;
    onother: (i: number, value: string) => void;
    folded?: boolean;
    tail?: Snippet;
  } = $props();

  const many = $derived(questions.length > 1);
  let active = $state(0);
  let hover = $state<Record<number, string | null>>({});
  let root = $state<HTMLDivElement | null>(null);
  let strip = $state<HTMLDivElement | null>(null);
  const secs: (HTMLElement | null)[] = $state([]);
  const otherEls: (HTMLInputElement | null)[] = $state([]);

  // The box that scrolls the questions: the desktop card once it reaches its cap, else the transcript (or
  // the phone's page) — the nearest ancestor that scrolls.
  function scroller(): HTMLElement | null {
    let el = root?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    return (document.scrollingElement as HTMLElement | null) ?? null;
  }

  const LINE = 28; // px under the strip at which a question counts as reached

  function spy() {
    const box = scroller();
    if (!box || !many) return;
    const top = box === document.scrollingElement ? 0 : box.getBoundingClientRect().top;
    const sh = strip?.getBoundingClientRect().height ?? 0;
    const tops = secs.slice(0, questions.length).map((s) => (s ? s.getBoundingClientRect().top - top - sh : 0));
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    active = spyIndex(tops, LINE, atEnd);
  }

  $effect(() => {
    if (!root || folded) return;
    // Scroll events do not bubble; listen in the capture phase on the document, which every scroller reaches.
    const on = () => spy();
    document.addEventListener("scroll", on, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", on, { capture: true });
  });

  function reduced(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Bring question `j` up under the strip and put the keyboard on it. */
  function go(j: number) {
    if (j < 0 || j >= questions.length) return;
    active = j;
    const sec = secs[j];
    const box = scroller();
    if (sec && box) {
      const top = box === document.scrollingElement ? 0 : box.getBoundingClientRect().top;
      const sh = strip?.getBoundingClientRect().height ?? 0;
      const y = box.scrollTop + sec.getBoundingClientRect().top - top - sh - 6;
      box.scrollTo({ top: Math.max(0, y), behavior: reduced() ? "auto" : "smooth" });
    }
    const first = sec?.querySelector<HTMLInputElement>("input.aq-in, input.aq-otherin");
    first?.focus({ preventScroll: true });
  }

  function onKey(e: KeyboardEvent, i: number) {
    const q = questions[i];
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLInputElement && t.type === "text";
    if (typing) {
      // Enter in Other moves on, as Next does; it never answers (the card's Answer is a deliberate click).
      if (e.key === "Enter" && !e.isComposing && many && i < questions.length - 1) {
        e.preventDefault();
        go(i + 1);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const p = keyPick(e.key, q.options.length);
    if (!p) return;
    e.preventDefault();
    if ("option" in p) {
      const o = q.options[p.option];
      ontoggle(i, o.label, !!q.multiSelect);
      secs[i]?.querySelectorAll<HTMLInputElement>("input.aq-in")[p.option]?.focus();
    } else {
      otherEls[i]?.focus();
    }
  }
</script>

{#snippet tick()}
  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"
    ><path
      d="M3.5 8.5l3 3 6-7"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    /></svg
  >
{/snippet}

<div class="aq" class:folded bind:this={root}>
  <div class="aq-strip" bind:this={strip}>
    {#if many}
      <div class="aq-tabs" role="tablist" aria-label="the model's questions">
        {#each questions as q, i (i)}
          {@const ok = isAnswered(picks[i], others[i])}
          <button
            type="button"
            role="tab"
            class="aq-tab"
            class:on={!folded && i === active}
            class:ok
            aria-selected={!folded && i === active}
            aria-controls="{idBase}-q{i}"
            onclick={() => go(i)}
            ><span class="aq-tm">{#if ok}{@render tick()}{:else}{i + 1}{/if}</span>{q.header || `Question ${i + 1}`}</button
          >
        {/each}
      </div>
    {:else}
      <span class="aq-one"
        ><span class="aq-qm" aria-hidden="true">?</span>Claude asks{questions[0]?.header
          ? ` · ${questions[0].header}`
          : ""}</span
      >
    {/if}
    <span class="aq-sp"></span>
    {@render tail?.()}
  </div>

  {#if !folded}
    {#each questions as q, i (i)}
      {@const multi = !!q.multiSelect}
      {@const prev = hasPreviews(q)}
      {@const typed = (others[i] ?? "").trim() !== ""}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <section
        class="aq-q"
        id="{idBase}-q{i}"
        role="group"
        aria-labelledby="{idBase}-q{i}-t"
        bind:this={secs[i]}
        onfocusin={() => (active = i)}
        onkeydown={(e) => onKey(e, i)}
      >
        {#if many || multi}
          <div class="aq-h">
            {#if many}{i + 1} · {q.header || `Question ${i + 1}`}{/if}{#if multi}<span class="aq-any">pick any</span>{/if}
          </div>
        {/if}
        <div class="aq-text" id="{idBase}-q{i}-t">{q.question}</div>
        <div class="aq-body" class:split={prev}>
          <div class="aq-opts" role={multi ? "group" : "radiogroup"} aria-labelledby="{idBase}-q{i}-t">
            {#each q.options as o, k (o.label)}
              {@const on = (picks[i] ?? []).includes(o.label)}
              <label
                class="aq-opt"
                class:on
                onmouseenter={() => (hover[i] = o.label)}
                onmouseleave={() => (hover[i] = null)}
              >
                <input
                  class="aq-in"
                  type={multi ? "checkbox" : "radio"}
                  name="{idBase}-q{i}"
                  checked={on}
                  onchange={() => ontoggle(i, o.label, multi)}
                  onfocus={() => (hover[i] = o.label)}
                  onblur={() => (hover[i] = null)}
                />
                <span class="aq-mk" class:sq={multi} aria-hidden="true"
                  >{#if on}{#if multi}{@render tick()}{:else}<i></i>{/if}{/if}</span
                >
                <span class="aq-ot">
                  <span class="aq-ol">{o.label}</span>
                  {#if o.description}<span class="aq-od">{o.description}</span>{/if}
                </span>
                <kbd class="aq-k" aria-hidden="true">{k + 1}</kbd>
              </label>
            {/each}
            <label class="aq-opt aq-other" class:on={typed}>
              <span class="aq-mk" class:sq={multi} aria-hidden="true"
                >{#if typed}{#if multi}{@render tick()}{:else}<i></i>{/if}{/if}</span
              >
              <span class="aq-ot">
                {#if typed}<span class="aq-od">Other</span>{/if}
                <input
                  class="aq-otherin"
                  type="text"
                  value={others[i] ?? ""}
                  oninput={(e) => onother(i, e.currentTarget.value)}
                  bind:this={otherEls[i]}
                  placeholder="Other — type an answer"
                  aria-label="other answer"
                  autocomplete="off"
                />
              </span>
              <kbd class="aq-k" aria-hidden="true">{q.options.length + 1}</kbd>
            </label>
          </div>
          {#if prev}
            {@const p = previewOption(q, picks[i] ?? [], hover[i] ?? null)}
            <div class="aq-prev" aria-label="preview of {p.label}">
              <div class="aq-prev-h">Preview · {p.label}</div>
              <pre>{p.preview ?? ""}</pre>
            </div>
          {/if}
        </div>
        {#if many && i < questions.length - 1}
          <div class="aq-nextrow">
            <button type="button" class="aq-next" onclick={() => go(i + 1)}
              >Next · {questions[i + 1].header || `question ${i + 2}`} <span aria-hidden="true">↓</span></button
            >
          </div>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<style>
  .aq {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-width: 0;
  }
  .aq.folded {
    gap: 0;
  }
  /* The strip: B's tabs, held at the top of whatever scrolls the questions. */
  .aq-strip {
    position: sticky;
    top: var(--aq-stick, 0px);
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    background: var(--aq-bg, var(--sheet));
    border-bottom: 1px solid var(--line);
    margin: var(--aq-strip-margin, 0);
    padding: var(--aq-strip-pad, 0);
  }
  .aq.folded .aq-strip {
    border-bottom-color: transparent;
  }
  .aq-tabs {
    display: flex;
    gap: 2px;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .aq-tabs::-webkit-scrollbar {
    display: none;
  }
  .aq-tab {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--dim);
    font-family: var(--sans);
    font-size: 13px;
    padding: 7px 9px 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .aq-tab:hover {
    color: var(--ink2);
  }
  .aq-tab.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .aq-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
    border-radius: 4px;
  }
  .aq-tm {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    display: inline-grid;
    place-items: center;
    font-size: 10.5px;
    font-weight: 600;
    background: var(--well);
    color: var(--ink2);
    flex: none;
  }
  .aq-tab.ok .aq-tm {
    background: var(--done-soft);
    color: var(--done);
  }
  .aq-tab.on .aq-tm {
    background: var(--accent);
    color: var(--paper);
  }
  .aq-one {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--ink2);
    padding: 5px 0 7px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .aq-qm {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--paper);
    display: inline-grid;
    place-items: center;
    font-size: 11px;
    font-weight: 700;
    flex: none;
  }
  .aq-sp {
    flex: 1;
  }

  /* A question: A's inline layout — a small header, the question in the transcript's face, light rows. */
  .aq-q {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    scroll-margin-top: 48px;
  }
  .aq-h {
    font-family: var(--sans);
    font-size: 11px;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--dim);
    font-weight: 500;
  }
  .aq-any {
    text-transform: none;
    letter-spacing: 0;
    color: var(--accent-ink);
    margin-left: 6px;
  }
  .aq-text {
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 16px);
    line-height: 1.5;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .aq-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  @container (min-width: 560px) {
    .aq-body.split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
      align-items: start;
      gap: 12px;
    }
  }
  .aq-opts {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-left: -8px;
    min-width: 0;
  }
  .aq-opt {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 11px;
    padding: 7px 8px;
    border-radius: 8px;
    cursor: pointer;
    min-width: 0;
    transition: background 0.12s;
  }
  .aq-opt:hover {
    background: var(--well);
  }
  .aq-opt.on {
    background: color-mix(in srgb, var(--accent-soft) 70%, transparent);
  }
  .aq-opt:has(.aq-in:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  /* The real radio/checkbox stays for the keyboard and screen readers; the mark draws it. */
  .aq-in {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    pointer-events: none;
  }
  .aq-mk {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    border: 1.5px solid var(--line2);
    border-radius: 50%;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    color: var(--paper);
  }
  .aq-mk.sq {
    border-radius: 4px;
  }
  .aq-opt.on .aq-mk {
    border-color: var(--accent);
    background: var(--accent);
  }
  .aq-mk i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--paper);
  }
  .aq-ot {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .aq-ol {
    font-family: var(--sans);
    font-size: 14.5px;
    line-height: 1.4;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .aq-opt.on .aq-ol {
    color: var(--accent-ink);
  }
  .aq-od {
    font-family: var(--sans);
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  .aq-k {
    flex: none;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 5px;
    margin-top: 2px;
  }
  .aq-other {
    cursor: text;
  }
  .aq-otherin {
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--line2);
    border-radius: 0;
    padding: 0 0 2px;
    font-family: var(--sans);
    font-size: 14.5px;
    line-height: 1.4;
    color: var(--ink);
  }
  .aq-otherin::placeholder {
    color: var(--dim);
  }
  .aq-otherin:focus {
    outline: none;
    border-bottom-color: var(--accent);
  }
  .aq-prev {
    background: var(--term, var(--paper));
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    min-width: 0;
  }
  .aq-prev-h {
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    padding: 6px 11px;
    border-bottom: 1px solid var(--line);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .aq-prev pre {
    margin: 0;
    padding: 9px 12px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--ink2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 22em;
    overflow: auto;
  }
  .aq-nextrow {
    display: flex;
    margin-top: 2px;
  }
  .aq-next {
    background: none;
    border: 1px solid var(--line2);
    border-radius: 999px;
    color: var(--ink2);
    font-family: var(--sans);
    font-size: 12.5px;
    padding: 4px 12px;
    cursor: pointer;
  }
  .aq-next:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .aq-next:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  /* A phone: no number keys worth showing, and rows tall enough for a thumb (44 px). */
  @media (pointer: coarse) {
    .aq-k {
      display: none;
    }
    .aq-opt {
      min-height: 44px;
      box-sizing: border-box;
      align-items: center;
    }
    .aq-mk {
      margin-top: 0;
    }
  }
</style>
