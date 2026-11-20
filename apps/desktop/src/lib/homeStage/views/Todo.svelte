<script lang="ts">
  // To-do (item 845; 809 round 6) — Home working down his list, on live data: the list Home put in the task
  // (`update_task` data: `items`, each with its state and, while Home is on it, its steps). The row Home is on wears
  // the scan brackets with its steps ticking under it; a finished row moves to Done. Every row opens in place.
  //   Tick, Undo, Hand to Home, Take back — kind B: kept here at once and told to Home for its next look (`tell`).
  //   (The short turn those start, 846's contract, comes in batch 4; until then Home reads them at its next look.)
  //   Opening a row — kind A.
  import { flip } from "svelte/animate";
  import { crossfade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Btn from "../Btn.svelte";
  import Detail from "../Detail.svelte";
  import Loading from "../Loading.svelte";
  import { bag } from "../stageState.svelte";
  import { tell, nudge, type HomeTask } from "../tasks.svelte";
  import { todoOf, type TodoItem, type Rows } from "../taskData";
  import MathText from "../../MathText.svelte";

  let { task }: { task: HomeTask } = $props();
  const items = $derived(todoOf(task.data));
  // svelte-ignore state_referenced_locally
  const ui = bag(`task:${task.id}`, { mine: {} as Record<string, boolean>, handed: {} as Record<string, boolean>, back: {} as Record<string, boolean>, open: null as string | null });

  type St = "open" | "doing" | "done" | "queued" | "yours";
  const st = (i: TodoItem): St => (ui.mine[i.id] ? "done" : i.state === "done" ? "done" : ui.back[i.id] ? "yours" : i.state === "doing" ? "doing" : ui.handed[i.id] ? "queued" : "open");
  const open = $derived(items.filter((i) => st(i) !== "done").sort((a, b) => Number(st(b) === "doing") - Number(st(a) === "doing")));
  const done = $derived(items.filter((i) => st(i) === "done"));
  const [send, receive] = crossfade({ duration: 460, easing: cubicOut });
  const toggle = (id: string) => (ui.open = ui.open === id ? null : id);
  const stepAt = (i: TodoItem) => Math.min(i.steps.length, i.steps.filter((s) => s.done).length + 1);

  function tick(i: TodoItem) {
    ui.mine[i.id] = true;
    void tell(task, `you ticked “${i.text}” yourself`);
  }
  function untick(i: TodoItem) {
    delete ui.mine[i.id];
    void tell(task, `you put “${i.text}” back on the list`);
  }
  function hand(i: TodoItem) {
    ui.handed[i.id] = true;
    delete ui.back[i.id];
    // Hand to Home and Take back start a short Home turn (846 §2, blocker 2143).
    nudge(task, `you handed “${i.text}” to Home to do`);
  }
  function takeBack(i: TodoItem) {
    if (ui.handed[i.id]) delete ui.handed[i.id];
    else ui.back[i.id] = true;
    nudge(task, `you took “${i.text}” back — leave it to you`);
  }
  const rowsOf = (i: TodoItem): Rows => (i.detail.length ? i.detail : [["Who", i.who === "you" ? "Yours to do" : "Home does it"], ...(i.note ? ([["Note", i.note]] as Rows) : []), ...(i.result ? ([["Result", i.result]] as Rows) : [])]);
</script>

<div class="h9-grid">
  <div class="h9-row">
    <div class="h9-col h9-fill" style="flex:1.5">
      <Panel title="To do" sub="{open.length} open · click a row for more" live={task.state === "live"}>
        {#if task.why}<div class="h9-why"><b>YOU ASKED</b><span>{task.why}</span></div>{/if}
        {#if items.length === 0}<Loading label={task.doing || "Home is reading your list — which of these can it do itself?"} lines={2} />{/if}
        {#each open as i (i.id)}
          {@const s = st(i)}
          <div class="d-wrap" animate:flip={{ duration: 380 }} in:receive={{ key: i.id }} out:send={{ key: i.id }}>
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="h9-item d-item h9-open" class:cur={s === "doing"} class:h9-brk={s === "doing"} class:isopen={ui.open === i.id} onclick={() => toggle(i.id)}>
              {#if s === "doing"}<i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i><i class="d-beam"></i>{/if}
              <button class="d-box" aria-label="Mark done" onclick={(e) => (e.stopPropagation(), tick(i))}></button>
              <span class="d-main">
                <span class="d-t"><MathText text={i.text} /></span>
                <span class="d-m">{s === "doing" ? (task.doing || "Home is on it now") : s === "queued" ? "handed to Home — it reads this at its next look" : s === "yours" ? "you took it back" : i.note || (i.who === "you" ? "yours" : "Home's")}</span>
                {#if s === "doing" && i.steps.length}
                  <span class="d-subs">
                    {#each i.steps as sub, k (k)}
                      {@const cur = !sub.done && k === stepAt(i) - 1}
                      {#if sub.done || cur}<span class="d-sub" class:ok={sub.done} class:on={cur}><i>{#if sub.done}<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 6.2l2.4 2.4 4.6-5" /></svg>{/if}</i>{sub.text}</span>{/if}
                    {/each}
                  </span>
                {/if}
              </span>
              {#if s === "doing"}
                {#if i.steps.length}<span class="ns-pill live"><span class="dot"></span>step {stepAt(i)} of {i.steps.length}</span>{/if}
                <Btn small icon="revert" tip={"Take it back from Home\nHome reads this at its next look"} onclick={() => takeBack(i)}>Take back</Btn>
              {:else if (i.who === "you" && s === "open") || s === "yours"}<Btn small icon="send" tip={"Ask Home to do it\nHome reads this at its next look"} onclick={() => hand(i)}>Hand to Home</Btn>
              {:else if s === "queued"}<Btn small icon="revert" onclick={() => takeBack(i)}>Take back</Btn>
              {:else}<span class="h9-mono h9-dim">Home · next</span>{/if}
              <span class="h9-chev">▸</span>
            </div>
            {#if ui.open === i.id}<Detail rows={rowsOf(i)} />{/if}
          </div>
        {/each}
      </Panel>
    </div>
    <div class="h9-col h9-fill">
      <Panel title="Done" sub={String(done.length)}>
        {#each done as i (i.id)}
          <div class="d-wrap" animate:flip={{ duration: 380 }} in:receive={{ key: i.id }} out:send={{ key: i.id }}>
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="h9-item d-item d-done h9-open" class:isopen={ui.open === i.id} onclick={() => toggle(i.id)}>
              <span class="d-box on"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 6.2l2.4 2.4 4.6-5" /></svg></span>
              <span class="d-main"><span class="d-t"><MathText text={i.text} /></span><span class="d-m ok">{#if ui.mine[i.id]}You ticked it{:else}<MathText text={i.result || "Done by Home"} />{/if}</span></span>
              {#if ui.mine[i.id]}<Btn small icon="revert" tip={"Put it back on the list"} onclick={() => untick(i)}>Undo</Btn>{/if}
              <span class="h9-chev">▸</span>
            </div>
            {#if ui.open === i.id}<Detail rows={rowsOf(i)} />{/if}
          </div>
        {/each}
        {#if done.length === 0}<p class="h9-dim" style="margin:6px 2px;font-size:13px">Nothing done yet — a finished row moves here.</p>{/if}
      </Panel>
    </div>
  </div>
  <div class="h9-col h9-wide"><Panel title="Home's steps" live={task.state === "live"} flush><Steps id={task.id} /></Panel></div>
</div>

<style>
  .d-wrap { margin-bottom: 3px; }
  .d-item { position: relative; align-items: flex-start; }
  .d-item.cur { overflow: visible; }
  .d-beam { position: absolute; left: 0; right: 0; top: 0; height: 100%; border-radius: var(--r1); pointer-events: none; overflow: hidden; }
  .d-beam::after { content: ""; position: absolute; left: 0; right: 0; height: 40%; top: -40%; background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--motion-ink) 16%, transparent) 80%, var(--motion-ink-hi)); animation: d-beam 1.8s cubic-bezier(0.5, 0, 0.5, 1) infinite; }
  @keyframes d-beam { to { top: 110%; } }
  .d-box { display: grid; place-items: center; flex: none; width: 18px; height: 18px; margin-top: 1px; padding: 0; border-radius: 5px; border: 1.5px solid var(--line2); background: var(--term); cursor: pointer; transition: border-color 120ms, box-shadow 120ms; position: relative; z-index: 1; }
  .d-box:hover { border-color: var(--accent); box-shadow: var(--glow-accent); }
  .d-box.on { background: var(--done-soft); border-color: var(--done); cursor: default; animation: d-land 520ms cubic-bezier(0.3, 1.7, 0.4, 1) both; }
  @keyframes d-land { from { transform: scale(2.1); box-shadow: 0 0 0 6px color-mix(in srgb, var(--done) 30%, transparent), 0 0 18px var(--done); } }
  .d-box svg, .d-sub svg { fill: none; stroke: var(--done); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 12; animation: d-tick 320ms 160ms ease-out both; }
  @keyframes d-tick { from { stroke-dashoffset: 12; } }
  .d-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; position: relative; z-index: 1; }
  .d-t { font-size: 13.5px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
  .d-done .d-t { color: var(--ink2); text-decoration: line-through; text-decoration-color: var(--line2); font-weight: 400; }
  .d-m { font-size: 11.5px; color: var(--dim); }
  .d-m.ok { color: var(--done); }
  .d-subs { display: flex; flex-direction: column; gap: 3px; margin: 4px 0 2px; padding-left: 2px; border-left: 1.5px solid color-mix(in srgb, var(--signal) 40%, var(--line2)); }
  .d-sub { position: relative; display: flex; align-items: center; gap: 7px; padding: 1px 8px; font-size: 12px; color: var(--ink2); animation: rm-rise 300ms ease-out both; overflow: hidden; }
  .d-sub i { display: grid; place-items: center; flex: none; width: 12px; height: 12px; border-radius: 50%; border: 1.2px solid var(--signal); }
  .d-sub.on { color: var(--signal-ink); }
  .d-sub.on i { animation: h9-pulse 0.9s ease-in-out infinite; box-shadow: var(--glow-signal); }
  .d-sub.ok { color: var(--dim); }
  .d-sub.ok i { border-color: var(--done); }
  /* A tiny stage (the phone, 845 batch 3): the row's words take the width; its pill and button wrap under them. */
  :global(.h9-stage.tiny) .d-item { flex-wrap: wrap; row-gap: 6px; }
  :global(.h9-stage.tiny) .d-main { flex: 1 1 calc(100% - 64px); }
  :global(.h9-stage.tiny) .d-item > :global(.h9-chev) { order: 1; }
  :global(.h9-stage.tiny) .d-item > :global(:is(.ns-pill, .jb, .h9-mono)) { order: 3; }
  :global(.h9-stage.tiny) .d-item::after { content: ""; order: 2; flex: none; width: 18px; }
</style>
