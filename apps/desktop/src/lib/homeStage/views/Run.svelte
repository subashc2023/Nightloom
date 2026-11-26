<script lang="ts">
  // Run (item 845; 809 round 6) — a chain of project work (a build, a merge, a night run), on live data: the steps,
  // helpers and log lines Home puts in the task (`update_task` data). Each step is a node on the chain with the live
  // one bracketed; helpers carry their own state; the log's last lines follow the newest.
  //   Stop / Undo — kind B + the short turn (blocker 2143): "stop after the step in hand"; its Undo is told at the next
  //   look. Run controls (item 872; 846 §4 Run, §7 step 7):
  //   Stop now — kind A + B + the short turn: code stops the routed chat's turn (`stopChat`; what landed stays), then
  //     Home is told to start nothing in the chain. Shown only when the task names its chat and it has not ended.
  //   Resume — kind B + the short turn (blocker 2199's default): after either stop; Home carries on (`send_chat`).
  //   Run this step again — kind B + the short turn (blocker 2199's default): on an open step that is done or failed;
  //     Home sends it into the chat (`send_chat`, gated by the route's own Start card when the chat may write).
  //   Open chat — kind A. Opening a step or a helper — kind A.
  //   How a routed chat ended reaches Home as a row in the same block (`home::tasks::record_route_end`), in code.
  import Icon from "../../Icon.svelte";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Btn from "../Btn.svelte";
  import Detail from "../Detail.svelte";
  import Loading from "../Loading.svelte";
  import { bag } from "../stageState.svelte";
  import { tell, nudge, type HomeTask } from "../tasks.svelte";
  import { stageHost } from "../host";
  import { runOf, moreWords, type RunStep, type Rows } from "../taskData";
  import { stopThenTell, resumeLine, againLine } from "../runControls";
  import MathText from "../../MathText.svelte";
  import InlineMd from "../../InlineMd.svelte"; // Item 991: model-written lines draw their markdown

  let { task }: { task: HomeTask } = $props();
  const r = $derived(runOf(task.data));
  // svelte-ignore state_referenced_locally
  const ui = bag(`task:${task.id}`, { stop: false, halted: false, open: null as string | null, again: [] as string[] });
  let halting = $state(false);
  const toggle = (id: string) => (ui.open = ui.open === id ? null : id);
  const liveStep = $derived(r.steps.find((s) => s.state === "live"));
  const at = $derived(r.steps.filter((s) => s.state !== "wait").length);
  const ended = $derived(task.state !== "live");
  const sub = $derived(ended ? (r.steps.some((s) => s.state === "failed") ? "ended with a failed step" : "finished") : ui.halted ? "stopped — its chat was stopped; Resume to carry on" : ui.stop ? "stopping after this step — Home was told" : r.steps.length ? `step ${Math.max(1, at)} of ${r.steps.length}` : "starting");
  function stop() {
    ui.stop = !ui.stop;
    // Stop is one of the four that start a short Home turn (846 §2, blocker 2143); its Undo is told at the next look.
    if (ui.stop) nudge(task, `you asked to stop after the step in hand${liveStep ? ` (${liveStep.name})` : ""} — start nothing after it`);
    else void tell(task, "you took back the stop — carry on");
  }
  // Stop now: the routed chat's own turn ends here (the run controls, 846 §7 step 7); `runControls.ts` tells Home
  // only once it stopped.
  async function stopNow() {
    if (!r.chat || halting) return;
    halting = true;
    try {
      if (await stopThenTell(task, r.chat, liveStep?.name ?? null)) {
        ui.halted = true;
        ui.stop = false;
      }
    } finally {
      halting = false;
    }
  }
  function resume() {
    const line = resumeLine(ui.halted);
    ui.halted = false;
    ui.stop = false;
    nudge(task, line);
  }
  function again(s: RunStep) {
    if (!ui.again.includes(s.id)) ui.again = [...ui.again, s.id];
    nudge(task, againLine(s.name, s.state === "failed"));
  }
  const pct = (s: RunStep) => (s.progress === null ? "" : `${Math.round(s.progress * 100)}%`);
  const stepRows = (s: RunStep): Rows => [["Step", s.name], ...s.detail, ["Now", s.state === "wait" ? "Not started" : s.state === "live" ? `Running${pct(s) ? ` — ${pct(s)}` : ""}` : s.state === "failed" ? `Failed${s.out ? ` — ${s.out}` : ""}` : s.out || "Done"]];
  const openStep = $derived(r.steps.find((s) => s.id === ui.open));

  let logEl = $state<HTMLElement | null>(null);
  $effect(() => {
    void r.log.length;
    logEl?.scrollTo({ top: logEl.scrollHeight });
  });
</script>

<div class="h9-grid">
  <div class="h9-col r-main">
    <Panel title={r.title || task.name} {sub} live={!ended && !ui.stop}>
      {#snippet tools()}
        {#if r.chat}<Btn small icon="chat" tip={"Open the chat running this"} onclick={() => stageHost.now.openChat(r.chat, r.project || null)}>Open chat</Btn>{/if}
        {#if !ended && ui.halted}<Btn small icon="play" tip={"Tell Home to carry on\nIt sends the chain on from where it stopped"} onclick={resume}>Resume</Btn>
        {:else if !ended}
          <Btn small kind={ui.stop ? "ghost" : "danger"} icon={ui.stop ? "revert" : "stop"} tip={ui.stop ? "Take back the stop" : "Stop after the step in hand\nHome is told now"} onclick={stop}>{ui.stop ? "Stopping · Undo" : "Stop"}</Btn>
          {#if r.chat}<Btn small kind="danger" icon="stop" tip={"Stop its chat now, mid-step\nWhat it already did stays"} onclick={stopNow}>{halting ? "Stopping…" : "Stop now"}</Btn>{/if}
        {/if}
      {/snippet}
      {#if r.steps.length === 0}<Loading label={task.doing || "Home is planning the run"} lines={2} />{/if}
      <div class="r-chain" class:compact={!!openStep} data-pin>
        {#each r.steps as s, i (s.id)}
          {#if i}<i class="r-link" class:done={s.state !== "wait"} class:live={s.state === "live"}></i>{/if}
          <button class="r-node {s.state}" class:sel={ui.open === s.id} class:h9-brk={s.state === "live"} onclick={() => toggle(s.id)} aria-expanded={ui.open === s.id}>
            {#if s.state === "live"}<i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i>{/if}
            <span class="r-mark">{#if s.state === "done"}<Icon name="check" size={12} />{:else if s.state === "failed"}<Icon name="x" size={11} />{:else}{i + 1}{/if}</span>
            <span class="r-name"><InlineMd text={s.name} /></span>
            <span class="r-out">{s.state === "live" ? pct(s) || "running" : s.state === "wait" ? "queued" : s.out || (s.state === "done" ? "done" : "failed")}</span>
            {#if s.state === "live" && s.progress !== null}<span class="h9-meter" style:--p={s.progress}><i></i></span>{/if}
          </button>
        {/each}
        {#if r.stepsMore}<div class="h9-more">{moreWords(r.stepsMore, r.stepsMore === 1 ? "step" : "steps")}</div>{/if}
      </div>
      {#if task.why}<div class="h9-why" style="margin-top:8px"><b>YOU ASKED</b><span><MathText text={task.why} /></span></div>{/if}
      {#if openStep}<div class="r-det"><Detail rows={stepRows(openStep)} />{#if openStep.state === "done" || openStep.state === "failed"}<div class="r-again">{#if ui.again.includes(openStep.id)}<span class="h9-dim">Home was asked to run it again</span>{/if}<Btn small icon="refresh" tip={"Ask Home to run this step again\nIt is told now"} onclick={() => openStep && again(openStep)}>Run this step again</Btn></div>{/if}</div>{/if}
      {#if r.asks}<p class="r-asks"><b>At the end</b><InlineMd text={r.asks} /></p>{/if}
    </Panel>
    <div class="h9-row h9-fill">
      <Panel title="Helpers" sub="{r.agents.filter((a) => a.state === 'live').length} running">
        {#each r.agents as a, i (a.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="h9-item h9-stagein h9-open r-agent" style:--i={i} class:cur={a.state === "live"} class:isopen={ui.open === a.id} onclick={() => toggle(a.id)}>
            <span class="r-av {a.state}"><Icon name="agent" size={13} /></span>
            <span class="r-am"><span class="r-an"><span>{a.name}</span>{#if a.tokens !== null}<span class="h9-mono h9-dim r-tok">{a.tokens}k tokens</span>{/if}</span><span class="r-at">{a.state === "done" ? "reported" : a.state === "failed" ? "stopped with an error" : a.task}</span></span><span class="h9-chev">▸</span>
          </div>
          {#if ui.open === a.id}<Detail rows={[["Helper", `${a.name} — an agent Home started for this run`], ["Doing", a.task || "—"], ...a.detail, ...(a.tokens !== null ? ([["Used", `${a.tokens}k tokens so far`]] as Rows) : [])]} />{/if}
        {/each}
        {#if r.agents.length === 0}<span class="h9-dim r-none">No helpers in this run.</span>{/if}
      </Panel>
      <div class="h9-col" style="flex:1.6;min-width:0">
        <Panel title="Log" sub="last lines" flush>
          <div class="r-logw"><div class="r-log" bind:this={logEl}>
            {#each r.log as line, i (i)}<div class="r-line" class:warn={/conflict|fail|error|warn/i.test(line)} class:ok={/^built |\bok\b|passed/i.test(line)}>{line}</div>{/each}
            {#if r.log.length === 0}<div class="r-line h9-dim">No log lines yet.</div>{/if}
            {#if !ended}<div class="r-line"><i class="h9-caret"></i></div>{/if}
          </div></div>
        </Panel>
      </div>
    </div>
  </div>
  <div class="h9-col h9-wide"><Panel title="Home's steps" live={!ended} flush><Steps id={task.id} /></Panel></div>
</div>

<style>
  .r-chain { display: flex; align-items: stretch; padding: 4px 0 2px; }
  .r-link { flex: 0 0 12px; height: 2px; margin-top: 21px; background: var(--line2); position: relative; overflow: hidden; }
  .r-link.done { background: color-mix(in srgb, var(--done) 60%, var(--line2)); }
  .r-link.live { background: var(--line2); }
  .r-link.live::after { content: ""; position: absolute; inset: 0; width: 45%; background: linear-gradient(90deg, transparent, var(--motion-ink-hi)); box-shadow: var(--glow-signal); animation: h9-sweep 900ms linear infinite; left: -45%; }
  .r-node { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 3px; flex: 1 1 0; min-width: 0; padding: 8px 9px; border-radius: var(--r1); border: 1px solid var(--line2); background: var(--well); color: var(--ink); text-align: left; cursor: pointer; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05); transition: background-color 120ms, border-color 200ms, box-shadow 200ms; }
  .r-node:hover { background: var(--well2); }
  .r-node.wait { background: transparent; color: var(--dim); border-style: dashed; box-shadow: none; }
  .r-node.live { border-color: var(--signal); background: var(--signal-soft); box-shadow: var(--glow-live); }
  .r-node.done { border-color: color-mix(in srgb, var(--done) 45%, var(--line2)); }
  .r-node.failed { border-color: var(--danger, #c0574f); }
  .r-mark { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; font: 500 10px var(--mono); background: var(--term); border: 1px solid var(--line2); color: var(--dim); }
  .r-node.done .r-mark { background: var(--done-soft); border-color: var(--done); color: var(--done); }
  .r-node.failed .r-mark { border-color: var(--danger, #c0574f); color: var(--danger, #c0574f); }
  .r-node.live .r-mark { border-color: var(--signal); color: var(--signal-ink); animation: h9-pulse 1.2s ease-in-out infinite; }
  .r-name { font-size: 13px; font-weight: 600; max-width: 100%; overflow-wrap: anywhere; }
  .r-out { font-size: 10.5px; line-height: 1.3; color: var(--dim); overflow-wrap: anywhere; max-width: 100%; min-height: 2.6em; }
  .r-node .h9-meter { width: 100%; }
  .r-node.sel { outline: 1.5px solid var(--accent); outline-offset: 1px; }
  .r-chain.compact { position: sticky; top: 0; z-index: 3; margin: 0 -12px; padding: 4px 12px 6px; background: var(--sheet); }
  .r-chain.compact .r-out { min-height: 0; }
  .r-chain.compact .r-node { padding: 6px 8px; gap: 2px; }
  .r-again { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 6px; font-size: 12px; }
  .r-asks { margin: 8px 2px 0; font-size: 12px; color: var(--ink2); }
  .r-asks b { font: 600 10px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent-ink); margin-right: 8px; }
  .r-agent { align-items: flex-start; padding: 5px 8px; }
  .r-tok { flex: none; white-space: nowrap; font-size: 10.5px; }
  .r-av { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--line2); background: var(--well); color: var(--dim); flex: none; }
  .r-av.live { color: var(--signal-ink); border-color: var(--signal); box-shadow: var(--glow-live); }
  .r-av.done { color: var(--done); border-color: var(--done); }
  .r-am { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .r-an { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 500; white-space: nowrap; }
  .r-at { font-size: 11.5px; line-height: 1.3; color: var(--dim); overflow-wrap: anywhere; }
  .r-none { display: block; padding: 6px 2px; font-size: 12px; }
  .r-logw { position: relative; height: 100%; min-height: 120px; }
  .r-log { position: absolute; inset: 0; box-sizing: border-box; overflow: hidden auto; scrollbar-width: thin; scrollbar-color: var(--line2) transparent; padding: 8px 12px; background: var(--term); border-radius: 0 0 var(--r2) var(--r2); font: 11.5px/1.5 var(--mono); color: var(--ink2); user-select: text; }
  .r-line { white-space: normal; overflow-wrap: anywhere; margin-bottom: 2px; }
  .r-line.warn { color: var(--partial); }
  .r-line.ok { color: var(--add-fg); }
  /* A narrow stage (Stage.svelte's .narrow, measured in CSS px — never a container query, which WebKit reads × the page zoom). */
  :global(.h9-stage.narrow) .r-chain { flex-wrap: wrap; gap: 6px; }
  :global(.h9-stage.narrow) .r-link { display: none; }
  :global(.h9-stage.narrow) .r-node { flex: 0 0 calc(33.3% - 4px); }
  :global(.h9-stage.tiny) .r-node { flex: 0 0 calc(50% - 3px); }
  :global(.h9-stage.narrow) .r-chain.compact { position: static; }
  /* A narrow stage is short too (960 × 600 at 150 %: ~350 px): the column scrolls, the chain, helpers and log keep their height. */
  :global(.h9-stage.narrow) .r-main { overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }
  :global(.h9-stage.narrow) .r-main > :global(*) { flex: none !important; }
  :global(.h9-stage.narrow) .r-main > :global(.h9-row) { height: 240px; }
</style>
