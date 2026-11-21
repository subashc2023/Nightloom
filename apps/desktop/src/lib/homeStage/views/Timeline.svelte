<script lang="ts">
  // Timeline (item 845; 809 round 6) — Home is changing his schedule, on live data: the day Home put in the task
  // (`update_task` data: `day`, `date`, `events`, `changes`). The track has a row for his calendar and one for what
  // Home proposes, free slots as a soft band behind both, and is zoomed to the hours that matter. A label is measured
  // against its block and goes inside (one line or two), else beside it, never cut. A narrow stage (960 × 600 at
  // 150%, a split, the phone) shows the same things as an agenda list instead.
  //   Accept / Skip, Undo, a slot pick — kind B: kept here at once, and told to Home for its next look (`tell`).
  //   Opening a row, a block — kind A.
  // Nothing is written to any calendar from here; a gated write is Home's, after his approval (846, batch 4).
  import { tip } from "../../tip";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Btn from "../Btn.svelte";
  import Choice from "../Choice.svelte";
  import Detail from "../Detail.svelte";
  import Loading from "../Loading.svelte";
  import { bag } from "../stageState.svelte";
  import { tell, type HomeTask } from "../tasks.svelte";
  import { timelineOf, hourWords, type Change, type Rows } from "../taskData";

  let { task }: { task: HomeTask } = $props();
  const day = $derived(timelineOf(task.data));
  // svelte-ignore state_referenced_locally
  const ui = bag(`task:${task.id}`, { verdict: {} as Record<string, "yes" | "no">, slot: {} as Record<string, number>, open: null as string | null });
  let hover = $state<string | null>(null);

  const Z0 = $derived(day.z0);
  const Z1 = $derived(day.z1);
  const x = (h: number) => `${((h - Z0) / (Z1 - Z0)) * 100}%`;
  const w = (d: number) => `${(d / (Z1 - Z0)) * 100}%`;
  const short = (h: number) => hourWords(h).replace(":00", "");

  let clock = $state(new Date());
  $effect(() => {
    const t = setInterval(() => (clock = new Date()), 60_000);
    return () => clearInterval(t);
  });
  const now = $derived(clock.getHours() + clock.getMinutes() / 60);
  const showNow = $derived(day.today && now >= Z0 && now <= Z1);

  const slotOf = (ch: Change) => (ch.kind === "pick" ? (ch.slots.includes(ui.slot[ch.id]) ? ui.slot[ch.id] : ch.h) : ch.h);
  const lineOf = (ch: Change) => (ch.kind === "pick" ? `${hourWords(slotOf(ch))}${ch.slots.length > 1 ? ` · ${ch.slots.length} free slots` : ""}` : ch.was !== null ? `${hourWords(ch.was)} → ${hourWords(ch.h)}` : `${hourWords(ch.h)}–${hourWords(ch.h + ch.d)}`);
  const pending = $derived(day.changes.filter((ch) => !ui.verdict[ch.id]).length);
  const asks = $derived(day.changes.filter((ch) => ch.yours));
  const pick = $derived(day.changes.find((ch) => ch.kind === "pick" && ch.slots.length > 1 && ui.verdict[ch.id] !== "no"));

  function choose(ch: Change, v: "yes" | "no") {
    ui.verdict[ch.id] = v;
    const what = ch.kind === "add" ? `adding ${ch.title} at ${hourWords(slotOf(ch))}` : ch.kind === "pick" ? `${ch.title} at ${hourWords(slotOf(ch))}` : `moving ${ch.title} to ${hourWords(ch.h)}`;
    void tell(task, v === "yes" ? `you accepted ${what}` : `you skipped ${what}`);
  }
  function undo(ch: Change) {
    const was = ui.verdict[ch.id];
    delete ui.verdict[ch.id];
    void tell(task, `you undid your ${was === "yes" ? "accept" : "skip"} of ${ch.title} — it waits for you again`);
  }
  function slot(ch: Change, s: number) {
    if (ui.slot[ch.id] === s) return;
    ui.slot[ch.id] = s;
    void tell(task, `you picked ${hourWords(s)} for ${ch.title}`);
  }
  function acceptAll() {
    for (const ch of day.changes) if (!ui.verdict[ch.id]) choose(ch, "yes");
  }
  const toggle = (id: string) => (ui.open = ui.open === id ? null : id);

  // ---- the track's blocks, each with where its label goes (measured, so nothing is ever cut) ----
  interface Block { id: string; row: 0 | 1; h: number; d: number; label: string; cls: string; tipText: string }
  const blocks = $derived<Block[]>([
    ...day.events.map((e): Block => ({ id: e.id, row: 0, h: e.h, d: e.d, label: e.title, cls: "", tipText: `${e.title} · ${hourWords(e.h)}\nClick for the detail` })),
    ...day.changes.filter((ch) => ch.was !== null && ui.verdict[ch.id] !== "no").map((ch): Block => ({ id: `${ch.id}:was`, row: 0, h: ch.was!, d: ch.d, label: `was ${hourWords(ch.was!)}`, cls: "ghost", tipText: `${ch.title} · was ${hourWords(ch.was!)}\nHome proposes ${hourWords(ch.h)}` })),
    ...day.changes.filter((ch) => ui.verdict[ch.id] !== "no").map((ch): Block => ({ id: ch.id, row: 1, h: slotOf(ch), d: ch.d, label: ch.title, cls: `prop${ui.verdict[ch.id] === "yes" ? " ok" : ""}`, tipText: `${ch.title} · ${lineOf(ch)}\nClick for the detail` })),
  ]);
  let W = $state(560);
  let meter: CanvasRenderingContext2D | null = null;
  function textW(s: string, font = "500 11px 'IBM Plex Sans', sans-serif") {
    meter ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (!meter) return s.length * 6.4;
    meter.font = font;
    return meter.measureText(s).width * 1.04 + 1;
  }
  type Fit = "in" | "two" | "right" | "left" | "tiny" | "none";
  const fit = $derived.by(() => {
    const px = (hrs: number) => (hrs / (Z1 - Z0)) * W;
    const out: Record<string, Fit> = {};
    for (const row of [0, 1] as const) {
      const here = blocks.filter((b) => b.row === row).sort((a, b) => a.h - b.h);
      // Space already promised to a neighbour's outside label, so two labels never meet.
      let takenTo = 0;
      here.forEach((b, i) => {
        const inner = px(b.d) - 12;
        const full = textW(b.label, b.cls === "ghost" ? "400 9.5px 'IBM Plex Mono', monospace" : undefined);
        const words = b.label.split(/\s+/);
        const widest = Math.max(...words.map((s) => textW(s)));
        const x0 = px(b.h - Z0), x1 = px(b.h + b.d - Z0);
        const next = here[i + 1] ? px(here[i + 1].h - Z0) : W;
        const prev = Math.max(takenTo, i ? px(here[i - 1].h + here[i - 1].d - Z0) : 0);
        if (full <= inner) out[b.id] = "in";
        else if (words.length > 1 && widest <= inner && full <= inner * 1.9) out[b.id] = "two";
        else if (next - x1 >= full + 12) (out[b.id] = "right"), (takenTo = x1 + full + 12);
        else if (x0 - prev >= full + 12) out[b.id] = "left";
        else if (textW(b.label, "500 9.5px 'IBM Plex Sans', sans-serif") <= px(b.d) - 5) out[b.id] = "tiny";
        else out[b.id] = "none";
      });
    }
    return out;
  });
  // The agenda (a narrow stage): the same things as a list in time order — nothing to squeeze.
  const agenda = $derived(
    [
      ...day.events.map((e) => ({ id: e.id, h: e.h, name: e.title, kind: "cal", note: "" })),
      ...day.changes.filter((ch) => ch.was !== null && ui.verdict[ch.id] !== "no").map((ch) => ({ id: ch.id, h: ch.was!, name: ch.title, kind: "was", note: `moves to ${hourWords(ch.h)}` })),
      ...day.changes.filter((ch) => ui.verdict[ch.id] !== "no").map((ch) => ({ id: ch.id, h: slotOf(ch), name: ch.title, kind: ui.verdict[ch.id] === "yes" ? "ok" : "prop", note: ch.yours ? "you asked" : "Home proposes" })),
    ].sort((a, b) => a.h - b.h),
  );
  const openRows = $derived<Rows | null>(day.events.find((e) => e.id === ui.open)?.detail ?? null);
  const rowsOf = (ch: Change): Rows => (ch.detail.length ? ch.detail : [["What", lineOf(ch)], ...(ch.why ? ([["Why", ch.why]] as Rows) : []), ["Written", "Nothing yet — a proposal until you accept"]]);
</script>

<div class="h9-grid">
  <div class="h9-col">
    <Panel keep title={day.day || task.name} sub="{pending} proposed · nothing written yet" live={task.state === "live"}>
      {#snippet tools()}
        <Btn kind="send" small disabled={pending === 0} tip={"Accept every change still open\nHome reads it at its next look"} onclick={acceptAll}>Accept all {pending || ""}</Btn>
      {/snippet}
      {#if task.why}<div class="h9-why"><b>YOU ASKED</b><span>{task.why}</span></div>{/if}
      {#if day.events.length || day.changes.length}
        <div class="t-wrap">
          <div class="t-keys"><span class="h"></span>{#if asks.length}<span class="you">You asked</span>{/if}<span>Your calendar</span><span class="home">Home proposes</span><span class="free">{pick ? "Free slots" : ""}</span></div>
          <div class="t-main">
            <div class="t-nowrow">{#if showNow}<b class="t-nowl" style:left={x(now)}>now {hourWords(now).replace(/ .M/, "")}</b>{/if}</div>
            <div class="t-hours">{#each Array(Z1 - Z0) as _, i (i)}<span style:left={x(Z0 + i)}>{short(Z0 + i)}</span>{/each}</div>
            <div class="t-rows" bind:clientWidth={W}>
              {#each Array(Z1 - Z0) as _, i (i)}<i class="t-grid" style:left={x(Z0 + i)}></i>{/each}
              {#if pick}
                {#each pick.slots as s, i (s)}
                  <button class="t-band h9-stagein" class:on={slotOf(pick) === s} style:left={x(s)} style:width={w(pick.d)} style:--i={i} onclick={() => slot(pick, s)} use:tip={`${hourWords(s)} · free\nClick to pick this slot for ${pick.title}`}><span>{slotOf(pick) === s ? "picked" : "free"}</span></button>
                {/each}
              {/if}
              {#if showNow}<i class="t-now" style:left={x(now)}></i>{/if}
              {#if asks.length}
                <div class="t-row you">
                  {#each asks as a (a.id)}
                    <div class="t-ask h9-stagein" class:hang={ui.verdict[a.id] !== "no"} style:left="min({x(slotOf(a))}, 58%)" use:tip={`You asked\n${task.why || a.title}`}><b>You</b><span>{task.why || a.title}</span><i></i></div>
                  {/each}
                </div>
              {/if}
              {#each [0, 1] as row (row)}
                <div class="t-row">
                  {#each blocks.filter((b) => b.row === row) as b (b.id)}
                    {@const f = fit[b.id] ?? "in"}
                    {@const target = b.id.replace(/:was$/, "")}
                    <button class="t-ev {b.cls}" class:two={f === "two"} class:tiny={f === "tiny"} class:bare={f === "right" || f === "left" || f === "none"} class:hov={hover === target} class:sel={ui.open === target} style:left={x(b.h)} style:width={w(b.d)} onclick={() => toggle(target)} use:tip={b.tipText} aria-label={b.label}>{#if f === "in" || f === "two" || f === "tiny"}{b.label}{/if}</button>
                    {#if f === "right" || f === "left"}<button class="t-tag {b.cls} {f}" style:left={f === "right" ? x(b.h + b.d) : undefined} style:right={f === "left" ? `calc(100% - ${x(b.h)})` : undefined} onclick={() => toggle(target)} tabindex="-1">{b.label}</button>{/if}
                  {/each}
                </div>
              {/each}
              <div class="t-free"></div>
            </div>
          </div>
        </div>
        <div class="t-agenda">
          {#each agenda as a (a.id + a.kind)}
            <button class="t-ag {a.kind}" class:sel={ui.open === a.id} onclick={() => toggle(a.id)}><span class="t-ag-h">{hourWords(a.h)}</span><span class="t-ag-n">{a.name}</span>{#if a.note}<span class="t-ag-k">{a.note}</span>{/if}</button>
          {/each}
          {#if pick}<div class="t-ag-free">Free slots: {#each pick.slots as s (s)}<button class="t-ag-slot" class:on={slotOf(pick) === s} onclick={() => slot(pick, s)}>{hourWords(s)}</button>{/each}</div>{/if}
        </div>
        {#if openRows}<Detail rows={openRows} />{/if}
        <div class="t-legend"><span><i class="k cal"></i>on your calendar</span><span><i class="k prop"></i>Home proposes</span><span><i class="k ok"></i>accepted</span>{#if pick}<span><i class="k slot"></i>free slot</span>{/if}<span class="t-zoom">{short(Z0)}–{short(Z1)} shown</span></div>
      {:else}
        <Loading label={task.doing || "Home is reading your calendar…"} lines={3} />
      {/if}
    </Panel>
    <Panel title="Changes" sub="one choice each · click a row for the detail">
      {#each day.changes as ch (ch.id)}
        {@const open = ui.open === ch.id}
        <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
        <div class="h9-item h9-stagein h9-open t-chg" class:isopen={open} onmouseenter={() => (hover = ch.id)} onmouseleave={() => (hover = null)} onclick={() => toggle(ch.id)}>
          <span class="h9-chev">▸</span>
          <span class="ns-pill {ui.verdict[ch.id] === 'yes' ? 'done' : ui.verdict[ch.id] === 'no' ? 'grey' : 'live'}"><span class="dot"></span>{ch.kind === "add" ? "add" : ch.kind === "pick" ? "pick a slot" : "move"}</span>
          <span class="t-ct"><b>{ch.title}</b> · {lineOf(ch)}{#if ch.why}{" "}<span class="h9-dim">— {ch.why}</span>{/if}</span>
          {#if ch.yours}<span class="h9-yours">you asked</span>{/if}
          <Choice value={ui.verdict[ch.id]} onpick={(v) => choose(ch, v)} onundo={() => undo(ch)} />
        </div>
        {#if open}<Detail rows={rowsOf(ch)} />{/if}
      {/each}
      {#if day.changes.length === 0}
        {#if task.state === "live"}<Loading label={task.doing || "Home is working out what to propose…"} lines={2} />{:else}<span class="h9-dim t-none">Nothing to change — Home left your day as it is</span>{/if}
      {/if}
    </Panel>
  </div>
  <div class="h9-col h9-wide"><Panel title="Home's steps" live={task.state === "live"} flush><Steps id={task.id} /></Panel></div>
</div>

<style>
  .t-wrap { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 0 4px; padding: 2px 0 0; }
  .t-keys { display: flex; flex-direction: column; font: 10.5px var(--mono); color: var(--dim); white-space: nowrap; }
  .t-keys span { height: 45px; display: flex; align-items: center; }
  .t-keys .h { height: 35px; }
  .t-keys .home { color: var(--signal-ink); }
  .t-keys .you { color: var(--accent-ink); height: 35px; }
  .t-keys .free { height: 17px; color: color-mix(in srgb, var(--signal-ink) 75%, transparent); font-size: 9.5px; }
  .t-main { min-width: 0; }
  .t-nowrow { position: relative; height: 17px; }
  .t-nowl { position: absolute; top: 0; transform: translateX(-50%); padding: 0 6px; border-radius: 3px; background: var(--accent); color: #1a1205; font: 600 10px/15px var(--mono); white-space: nowrap; z-index: 4; box-shadow: var(--glow-accent); transition: left 200ms linear; }
  .t-hours { position: relative; height: 18px; font: 10.5px var(--mono); color: var(--dim); }
  .t-hours span { position: absolute; top: 2px; transform: translateX(3px); white-space: nowrap; }
  .t-rows { position: relative; border-radius: var(--r1); background: var(--term); border: 1px solid var(--line); overflow: hidden; }
  .t-row { position: relative; height: 44px; }
  .t-row + .t-row { border-top: 1px dashed var(--line); }
  .t-row.you { height: 34px; }
  .t-free { height: 16px; border-top: 1px dashed var(--line); }
  .t-grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line); }
  .t-now { position: absolute; top: 0; bottom: 0; width: 1.5px; background: var(--accent); box-shadow: var(--glow-accent); z-index: 3; transition: left 200ms linear; pointer-events: none; }
  .t-band { position: absolute; top: 0; bottom: 0; padding: 0; border: 0; border-left: 1px dashed color-mix(in srgb, var(--signal) 55%, transparent); border-right: 1px dashed color-mix(in srgb, var(--signal) 55%, transparent); background: color-mix(in srgb, var(--signal) 8%, transparent); cursor: pointer; z-index: 1; transition: background-color 140ms, box-shadow 140ms; }
  .t-band span { position: absolute; left: 0; right: 0; bottom: 0; height: 16px; font: 9px/16px var(--mono); color: color-mix(in srgb, var(--signal-ink) 80%, transparent); text-align: center; white-space: nowrap; }
  .t-band:hover { background: color-mix(in srgb, var(--signal) 16%, transparent); }
  .t-band.on { background: color-mix(in srgb, var(--signal) 20%, transparent); border-color: var(--signal); box-shadow: inset 0 0 14px color-mix(in srgb, var(--signal) 22%, transparent); }
  .t-band.on span { color: var(--signal-ink); font-weight: 600; }
  .t-ev { position: absolute; top: 6px; height: 32px; display: flex; flex-direction: column; justify-content: center; padding: 0 5px; border-radius: var(--r1); font: 500 11px/1.15 var(--sans); text-align: left; white-space: nowrap; overflow: hidden; box-sizing: border-box; cursor: pointer; z-index: 2; background: var(--well); border: 1px solid var(--line2); color: var(--ink); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05); transition: left 420ms cubic-bezier(0.3, 1.2, 0.4, 1), background-color 200ms, border-color 200ms, box-shadow 200ms, transform 120ms, opacity 200ms; }
  .t-ev.two { white-space: normal; font-size: 10.5px; line-height: 1.12; }
  .t-ev.bare { padding: 0; }
  .t-ev.tiny { padding: 0 2px; font-size: 9.5px; align-items: center; }
  .t-ev:hover, .t-ev.hov { transform: translateY(-1px); border-color: var(--dim); }
  .t-ev.sel { outline: 1.5px solid var(--accent); outline-offset: 1px; }
  .t-ev.ghost { background: transparent; border-style: dashed; color: var(--dim); box-shadow: none; font: 400 9.5px var(--mono); }
  .t-ev.prop { background: var(--signal-soft); border-color: var(--signal); color: var(--signal-ink); box-shadow: var(--glow-signal); }
  .t-ev.prop.hov { box-shadow: var(--glow-live); }
  .t-ev.ok { background: var(--done-soft); border-color: var(--done); color: var(--add-fg); box-shadow: none; }
  /* A label that does not fit its block sits beside it, in the block's colour, on a short leader. */
  .t-tag { position: absolute; top: 6px; height: 32px; display: flex; align-items: center; padding: 0 5px 0 7px; border: 0; background: none; font: 500 11px/1 var(--sans); color: var(--ink2); white-space: nowrap; cursor: pointer; z-index: 2; }
  .t-tag.left { padding: 0 7px 0 5px; }
  .t-tag.prop { color: var(--signal-ink); }
  .t-tag.ok { color: var(--add-fg); }
  .t-tag.ghost { color: var(--dim); font: 400 9.5px var(--mono); }
  .t-tag::before { content: ""; position: absolute; left: 0; top: 50%; width: 4px; height: 1px; background: currentColor; opacity: 0.6; }
  .t-tag.left::before { left: auto; right: 0; }
  .t-arrow { position: absolute; top: 22px; height: 1.5px; background: linear-gradient(90deg, var(--line2), var(--signal)); z-index: 1; }
  .t-arrow::after { content: ""; position: absolute; right: -1px; top: -3.5px; border: 4px solid transparent; border-left-color: var(--signal); }
  .t-drop { animation: t-drop 420ms cubic-bezier(0.2, 0.9, 0.25, 1.25) both; }
  @keyframes t-drop { from { opacity: 0; transform: translateY(-30px) scaleY(0.6); } }
  .t-ask { position: absolute; top: 5px; height: 24px; max-width: 42%; display: flex; align-items: center; gap: 6px; padding: 0 9px; border-radius: 12px; background: var(--accent-soft); border: 1px solid var(--accent); color: var(--ink); font-size: 11.5px; z-index: 4; box-shadow: var(--glow-accent); box-sizing: border-box; }
  .t-ask b { font: 600 9.5px var(--mono); color: var(--accent-ink); flex: none; }
  .t-ask span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t-ask i { display: none; position: absolute; left: 14px; top: 100%; width: 1.5px; height: 56px; background: linear-gradient(var(--accent), color-mix(in srgb, var(--accent) 30%, transparent)); pointer-events: none; }
  .t-ask.hang i { display: block; }
  .t-agenda { display: none; flex-direction: column; gap: 3px; }
  .t-ag { display: flex; align-items: baseline; gap: 10px; padding: 5px 9px; border-radius: var(--r1); border: 1px solid var(--line2); background: var(--well); color: var(--ink); font: 12.5px/1.35 var(--sans); text-align: left; cursor: pointer; }
  .t-ag.sel { outline: 1.5px solid var(--accent); outline-offset: 1px; }
  .t-ag-h { flex: none; width: 62px; font: 10.5px var(--mono); color: var(--dim); }
  .t-ag-n { flex: 1; min-width: 0; font-weight: 500; }
  .t-ag-k { flex: none; font: 10px var(--mono); color: var(--dim); }
  .t-ag.prop { background: var(--signal-soft); border-color: var(--signal); color: var(--signal-ink); }
  .t-ag.prop .t-ag-k, .t-ag.prop .t-ag-h { color: var(--signal-ink); }
  .t-ag.ok { background: var(--done-soft); border-color: var(--done); color: var(--add-fg); }
  .t-ag.was { background: transparent; border-style: dashed; color: var(--dim); }
  .t-ag.was .t-ag-n { text-decoration: line-through; text-decoration-color: var(--line2); font-weight: 400; }
  .t-ag-free { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 2px 0; font: 10.5px var(--mono); color: var(--dim); }
  .t-ag-slot { padding: 2px 8px; border-radius: 10px; border: 1px dashed var(--signal); background: color-mix(in srgb, var(--signal) 8%, transparent); color: var(--signal-ink); font: 10.5px var(--mono); cursor: pointer; }
  .t-ag-slot.on { border-style: solid; background: color-mix(in srgb, var(--signal) 22%, transparent); font-weight: 600; }
  .t-legend { display: flex; flex-wrap: wrap; gap: 3px 14px; padding: 7px 2px 0; font-size: 10.5px; color: var(--dim); }
  .t-legend .k { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; border: 1px solid var(--line2); background: var(--well); }
  .t-legend .k.prop { background: var(--signal-soft); border-color: var(--signal); }
  .t-legend .k.ok { background: var(--done-soft); border-color: var(--done); }
  .t-legend .k.slot { background: color-mix(in srgb, var(--signal) 14%, transparent); border: 1px dashed var(--signal); }
  .t-chg { align-items: center; padding-top: 5px; padding-bottom: 5px; }
  .t-ct { flex: 1; min-width: 0; font-size: 13px; line-height: 1.35; }
  /* A narrow stage (one half of a split, the phone): the agenda instead of the track; rows wrap instead of cutting. */
  /* A narrow stage (Stage.svelte's .narrow, measured in CSS px — never a container query, which WebKit reads × the page zoom). */
  :global(.h9-stage.narrow) .t-wrap, :global(.h9-stage.narrow) .t-zoom { display: none; }
  :global(.h9-stage.narrow) .t-agenda { display: flex; }
  :global(.h9-stage.narrow) .t-chg { flex-wrap: wrap; row-gap: 5px; }
  :global(.h9-stage.narrow) .t-ct { flex-basis: calc(100% - 110px); }

  .t-none { display: block; padding: 6px 2px; font-size: 12px; }
</style>
