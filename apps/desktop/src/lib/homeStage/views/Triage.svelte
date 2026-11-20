<script lang="ts">
  // Triage (item 845; 809 round 6) — sorting what arrived, on live data: the cards Home put in the task
  // (`update_task` data: `cards`, each in a pile). The piles are Nightloom labels only: a move never touches Gmail.
  //   Move (drag, or the pile buttons on an opened card), Undo move — kind B: his move is sticky (Home's next data
  //   does not move it back here) and told to Home for its next look (`tell`).
  //   Answer on a Needs-you card — kind C: his pick or his own words, told to Home. A half-typed answer is kept
  //   (in the stage's storage) through closing the card, leaving Home and a restart; only Send or Clear drops it.
  //   Opening a card — kind A.
  // Gmail's own actions (archive, mark read) are gated writers — 846's contract, batch 4; none is drawn here yet.
  import { flip } from "svelte/animate";
  import { crossfade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import Icon from "../../Icon.svelte";
  import { tip } from "../../tip";
  import type { IconName } from "../../icons";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Btn from "../Btn.svelte";
  import Detail from "../Detail.svelte";
  import Loading from "../Loading.svelte";
  import { bag } from "../stageState.svelte";
  import { tell, type HomeTask } from "../tasks.svelte";
  import { triageOf, PILES, pileName, type Card, type Pile, type Rows } from "../taskData";
  import MathText from "../../MathText.svelte";

  let { task }: { task: HomeTask } = $props();
  const cards = $derived(triageOf(task.data));
  // svelte-ignore state_referenced_locally
  const ui = bag(`task:${task.id}`, { moved: {} as Record<string, Pile>, was: {} as Record<string, Pile>, open: null as string | null, ans: {} as Record<string, string>, drafts: {} as Record<string, string>, asking: null as string | null });
  let drag = $state<string | null>(null);
  let over = $state<Pile | null>(null);

  const ICON: Record<string, IconName> = { gmail: "read", mail: "read", messages: "chat", calendar: "updown", reminders: "checklist", ci: "branch", github: "branch", nightshift: "lock" };
  const iconOf = (cd: Card): IconName => ICON[cd.source] ?? (cd.question ? "chat" : "read");
  const pileOf = (cd: Card): Pile => ui.moved[cd.id] ?? cd.pile;
  // His hand wins: a card he moved or holds is never shown as Home reading it.
  const reading = (cd: Card) => cd.reading && !ui.moved[cd.id] && drag !== cd.id;
  const [send, receive] = crossfade({ duration: 420, easing: cubicOut, fallback: () => ({ duration: 260, css: (t) => `opacity:${t};transform:translateY(${(1 - t) * -10}px)` }) });

  function move(id: string, p: Pile) {
    const cd = cards.find((c) => c.id === id);
    if (!cd || pileOf(cd) === p) return;
    if (!ui.moved[id]) ui.was[id] = cd.pile;
    if (p === ui.was[id]) {
      delete ui.moved[id];
      delete ui.was[id];
    } else ui.moved[id] = p;
    void tell(task, `you moved “${cd.from}: ${cd.title}” to ${pileName(p)} — leave it there`);
  }
  function drop(p: Pile) {
    if (drag) move(drag, p);
    drag = null;
    over = null;
  }
  function undo(cd: Card) {
    delete ui.moved[cd.id];
    delete ui.was[cd.id];
    void tell(task, `you undid your move of “${cd.from}: ${cd.title}” — back in ${pileName(cd.pile)}`);
  }
  function answer(cd: Card, text: string) {
    const t = text.trim();
    if (!t) return;
    ui.ans[cd.id] = t;
    // Only sending his own words drops them; picking an option keeps a half-typed answer (845 review, (c)).
    if ((ui.drafts[cd.id] ?? "").trim() === t) delete ui.drafts[cd.id];
    ui.asking = null;
    void tell(task, `you answered “${cd.from}: ${cd.title}”: ${t}`);
  }
  function unanswer(cd: Card) {
    const was = ui.ans[cd.id];
    delete ui.ans[cd.id];
    // His words come back to the box, never lost to an Undo (845 review, (c)).
    if (was && !(ui.drafts[cd.id] ?? "").trim() && !cd.options.includes(was)) ui.drafts[cd.id] = was;
    void tell(task, `you took back your answer (“${was}”) to “${cd.from}: ${cd.title}” — wait for a new one`);
  }
  const needsN = $derived(cards.filter((cd) => pileOf(cd) === "needs" && !ui.ans[cd.id]).length);
  const flown = $derived(cards.filter((cd) => cd.todo && pileOf(cd) === "needs"));
  const rowsOf = (cd: Card): Rows => [
    ["From", `${cd.from}${cd.source ? ` · ${cd.source}` : ""}`],
    ...(cd.verdict ? ([["Home read", cd.verdict]] as Rows) : []),
    ["Label", `${pileName(pileOf(cd))}${ui.moved[cd.id] ? " — moved by you; Home will not move it back" : " — set by Home"}`],
    ...cd.detail,
    ...(cd.source === "gmail" ? ([["In Gmail", "Untouched: unread state, inbox and labels are as they were"]] as Rows) : []),
  ];
  const focus = (n: HTMLInputElement) => n.focus({ preventScroll: true });
</script>

<div class="h9-grid">
  <div class="g-col">
    {#if task.why}<div class="h9-why"><b>YOU ASKED</b><span>{task.why}</span></div>{/if}
    <div class="g-safe"><Icon name="lock" size={11} /><span>Piles are Nightloom labels. A move never archives, deletes, marks read or replies in Gmail.</span></div>
    <div class="g-piles">
      {#each PILES as p (p.id)}
        {@const here = cards.filter((cd) => pileOf(cd) === p.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="g-pile" class:over={over === p.id && drag !== null} ondragover={(e) => (e.preventDefault(), (over = p.id))} ondragleave={() => over === p.id && (over = null)} ondrop={(e) => (e.preventDefault(), drop(p.id))}>
          <Panel title={p.name} sub={String(p.id === "needs" ? needsN : here.length)} live={p.id === "inbox" && task.state === "live"} lock={p.id === "needs" && needsN > 0}>
            <div class="g-list">
              {#each here as cd (cd.id)}
                {@const open = ui.open === cd.id}
                {@const ans = ui.ans[cd.id]}
                <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                <div class="g-card h9-open" data-reveal class:reading={reading(cd)} class:h9-brk={reading(cd)} class:dragging={drag === cd.id} class:mine={!!ui.moved[cd.id]} class:isopen={open} draggable="true"
                  ondragstart={(e) => ((drag = cd.id), e.dataTransfer?.setData("text/plain", cd.id))} ondragend={() => ((drag = null), (over = null))}
                  onclick={() => (ui.open = open ? null : cd.id)} in:receive={{ key: cd.id }} out:send={{ key: cd.id }} animate:flip={{ duration: 320 }}>
                  {#if reading(cd)}<i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i><i class="g-read"></i>{/if}
                  <span class="g-top"><Icon name={iconOf(cd)} size={12} /><span class="g-from">{cd.from}</span><span class="h9-chev">▸</span></span>
                  <span class="g-title">{cd.title}</span>
                  {#if reading(cd)}<span class="g-verdict live h9-caret">reading</span>
                  {:else if cd.verdict && !(p.id === "needs" && cd.question)}<span class="g-verdict">{cd.verdict}</span>{/if}
                  {#if drag === cd.id}<span class="g-hand">You are holding this</span>{/if}
                  {#if ui.moved[cd.id]}<span class="g-mine"><span class="g-you" use:tip={"You put this here\nHome will not move it back"}>moved by you</span>{#if !open}<Btn small icon="revert" tip={`Put it back in ${pileName(cd.pile)}`} onclick={() => undo(cd)}>Undo move</Btn>{/if}</span>{/if}
                  {#if p.id === "needs" && cd.question}
                    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                    <div class="nd" class:isopen={ui.asking === cd.id} class:ans={!!ans} onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === "Escape" && ui.asking === cd.id && (e.stopPropagation(), (ui.asking = null))}>
                      <p class="nd-q"><MathText text={cd.question} /></p>
                      {#if ans}
                        <span class="nd-ans">You: {ans}</span>
                        <span class="h9-acts"><Btn small icon="revert" onclick={() => unanswer(cd)}>Undo</Btn></span>
                      {:else if ui.asking !== cd.id}
                        <span class="h9-acts"><Btn kind="send" icon="reply" small onclick={() => (ui.asking = cd.id)}>Answer</Btn><Btn small onclick={() => move(cd.id, "later")}>Later</Btn>{#if ui.drafts[cd.id]}<span class="nd-hint kept">draft kept — “{ui.drafts[cd.id]}”</span>{/if}</span>
                      {:else}
                        {#if cd.options.length}<span class="nd-opts">{#each cd.options as o (o)}<Btn small onclick={() => answer(cd, o)}>{o}</Btn>{/each}</span>{/if}
                        <span class="nd-reply"><input placeholder="Or say it your way…" bind:value={ui.drafts[cd.id]} use:focus onkeydown={(e) => e.key === "Enter" && answer(cd, ui.drafts[cd.id] ?? "")} /><Btn kind="send" small disabled={!(ui.drafts[cd.id] ?? "").trim()} onclick={() => answer(cd, ui.drafts[cd.id] ?? "")}>Send</Btn></span>
                        <span class="nd-hint">Nothing is answered until you pick or send · Esc closes, your words stay</span>
                      {/if}
                    </div>
                  {/if}
                  {#if open}
                    <span class="g-gm h9-acts">{#each PILES.filter((x) => x.id !== p.id) as to (to.id)}<Btn small tip={`Move it to ${to.name}\nA Nightloom label; Gmail is untouched`} onclick={() => move(cd.id, to.id)}>→ {to.name}</Btn>{/each}</span>
                    <Detail rows={rowsOf(cd)}>
                      {#if ui.moved[cd.id]}<Btn small icon="revert" onclick={() => undo(cd)}>Undo move</Btn>{/if}
                    </Detail>
                  {/if}
                </div>
              {/each}
              {#if here.length === 0}{#if p.id === "needs" && cards.length === 0 && task.state === "live"}<Loading label={task.doing || "Home is reading what arrived…"} lines={2} />{:else}<span class="g-empty">{p.id === "inbox" ? "Inbox clear" : "Drop a card here"}</span>{/if}{/if}
            </div>
          </Panel>
        </div>
      {/each}
    </div>
    <div class="g-dock">
      <span class="g-dock-l"><Icon name="checklist" size={12} />To-do list</span>
      {#each flown as cd (cd.id)}<span class="g-fly in"><Icon name="checklist" size={11} />{cd.todo}<small>from Needs you</small></span>{/each}
      {#if flown.length === 0}<span class="h9-dim">A Needs-you item that is a real task shows here, on its way to your to-do list.</span>{/if}
    </div>
  </div>
  <div class="h9-col h9-wide"><Panel title="Home's steps" live={task.state === "live"} flush><Steps id={task.id} /></Panel></div>
</div>

<style>
  .g-col { display: flex; flex-direction: column; gap: 8px; min-height: 0; min-width: 0; }
  .g-piles { flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.55fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; min-height: 0; }
  .g-pile { display: flex; min-height: 0; min-width: 0; border-radius: var(--r2); transition: box-shadow 120ms, transform 120ms; }
  .g-pile > :global(.h9-panel) { flex: 1; }
  .g-pile.over { box-shadow: 0 0 0 1.5px var(--accent), var(--glow-main); transform: translateY(-2px); }
  .g-list { display: flex; flex-direction: column; gap: 7px; min-height: 100%; }
  .g-card { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 8px 10px 9px; border-radius: var(--r1); border: 1px solid var(--line2); background: var(--raised); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 3px 10px rgba(0, 0, 0, 0.3); cursor: grab; transition: border-color 120ms, box-shadow 120ms, transform 120ms; }
  .g-card:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--line2)); transform: translateY(-1px); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 8px 18px rgba(0, 0, 0, 0.45); }
  .g-card.isopen { border-color: var(--accent); cursor: default; }
  .g-card.dragging { transform: rotate(-2deg) translateY(-4px); border-color: var(--accent); box-shadow: 0 16px 30px rgba(0, 0, 0, 0.6), var(--glow-main); z-index: 5; }
  .g-hand { align-self: flex-start; padding: 2px 6px; border-radius: 3px; background: var(--accent); color: #1a1205; font: 600 9.5px/1.35 var(--mono); }
  .g-mine { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
  .g-card.reading { border-color: var(--signal); box-shadow: var(--glow-live); }
  .g-read { position: absolute; inset: 0; border-radius: var(--r1); overflow: hidden; pointer-events: none; }
  .g-read::after { content: ""; position: absolute; left: 0; right: 0; top: -30%; height: 30%; background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--motion-ink) 20%, transparent) 80%, var(--motion-ink-hi)); animation: g-read 1.1s cubic-bezier(0.5, 0, 0.5, 1) infinite; }
  @keyframes g-read { to { top: 110%; } }
  .g-card.mine { border-left: 2px solid var(--accent); }
  .g-top { display: flex; align-items: center; gap: 6px; font: 10.5px var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--dim); }
  .g-from { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .g-you { font: 10.5px var(--mono); color: var(--accent-ink); white-space: nowrap; }
  .g-title { font-size: 13px; font-weight: 500; line-height: 1.35; }
  .g-verdict { font-size: 11.5px; color: var(--ink2); }
  .g-verdict.live { color: var(--signal-ink); font-family: var(--mono); }
  .g-empty { margin: auto; padding: 18px 0; font-size: 12px; color: var(--dim); border: 1px dashed var(--line2); border-radius: var(--r1); width: 100%; text-align: center; }
  .g-card :global(.h9-detail) { margin: 4px 0 0; grid-template-columns: minmax(0, 1fr); gap: 1px 0; }
  .g-card :global(.h9-detail > dd) { margin-bottom: 5px; overflow-wrap: anywhere; }
  .g-card :global(.h9-detail-acts .jb) { flex: 0 1 auto; min-width: 0; white-space: normal; text-align: left; padding-top: 3px; padding-bottom: 3px; }
  .g-card :global(.nd-reply) { flex-wrap: wrap; }
  .g-card :global(.nd-reply input) { flex: 1 1 120px; }
  .g-fly { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--done); background: var(--done-soft); color: var(--add-fg); font-size: 11.5px; line-height: 1.35; max-width: 100%; box-sizing: border-box; }
  .g-fly.in { animation: h9-flash 700ms ease-out both; }
  .g-fly small { color: var(--dim); font: 10px var(--mono); }
  .g-dock { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; padding: 6px 12px; border-radius: var(--r2); border: 1px dashed var(--line2); font-size: 11.5px; min-height: 22px; }
  .g-dock-l { display: inline-flex; align-items: center; gap: 6px; font: 500 10.5px var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink2); flex: none; }
  .g-safe { flex: none; display: flex; align-items: baseline; gap: 7px; padding: 0 2px; font-size: 11.5px; line-height: 1.4; color: var(--dim); }
  .g-safe :global(svg) { flex: none; transform: translateY(1px); color: var(--accent-ink); }
  /* A narrow stage (Stage.svelte's .narrow, measured in CSS px — never a container query, which WebKit reads × the page zoom). */
  :global(.h9-stage.narrow) .g-piles { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: minmax(190px, 1fr); overflow: hidden auto; padding: 4px; scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }
  /* A tiny stage (the phone, 845 batch 3): one pile under another, each as tall as its cards; the page scrolls. */
  :global(.h9-stage.tiny) .g-piles { grid-template-columns: minmax(0, 1fr); grid-auto-rows: auto; overflow: visible; }
  /* …and each pile's panel is the pile's full width: the tiny stage sets every panel `flex: none`, which in this row
     sized it to its own text — the Inbox panel took half the width and Needs you ran 111 px off a 375 px phone. */
  :global(.h9-stage.tiny) .g-pile { flex-direction: column; }

  .g-gm { margin: 4px 0 2px; align-items: center; }
</style>
