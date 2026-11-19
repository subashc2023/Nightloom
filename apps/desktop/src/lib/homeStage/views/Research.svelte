<script lang="ts">
  // Research (item 845; 809 round 6) — a question, its sources and the claims Home keeps, on live data (`update_task`
  // data). Sources stream in (reading, kept, dropped); each claim is tied to its source, and hovering one lights the
  // other; the answer cites its claims. Provenance is said on every source: his own note, or "the source claims it".
  //   Drop source / Undo drop, Pin / Unpin — kind B: kept here at once and told to Home for its next look.
  //   Keep as a note — writes the page into Home's notes (a new file; never over one he has). Ask a follow-up puts the
  //   cursor in the message box. Hover, opening a row — kind A.
  import { flip } from "svelte/animate";
  import Icon from "../../Icon.svelte";
  import * as api from "../../api";
  import { addToast } from "../../state.svelte";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Btn from "../Btn.svelte";
  import Detail from "../Detail.svelte";
  import Loading from "../Loading.svelte";
  import { bag } from "../stageState.svelte";
  import { tell, type HomeTask } from "../tasks.svelte";
  import { noteName, researchNote, researchOf, type ResearchSource } from "../taskData";

  let { task }: { task: HomeTask } = $props();
  const r = $derived(researchOf(task.data));
  // svelte-ignore state_referenced_locally
  const ui = bag(`task:${task.id}`, { dropped: {} as Record<string, boolean>, pinned: {} as Record<string, boolean>, open: null as string | null, saved: "" });
  const toggle = (id: string) => (ui.open = ui.open === id ? null : id);
  let hot = $state<string | null>(null);
  const st = (s: ResearchSource) => (ui.dropped[s.id] ? "dropped" : s.state);
  const srcOf = (id: string) => r.sources.find((s) => s.id === id);
  const claims = $derived(r.claims.filter((c) => !ui.dropped[c.src]).sort((a, b) => Number(!!ui.pinned[b.id]) - Number(!!ui.pinned[a.id])));
  const answer = $derived(r.answer.filter((a) => a.cites.length === 0 || a.cites.some((id) => claims.some((c) => c.id === id))));
  const finished = $derived(r.done || task.state !== "live");
  const kept = $derived(r.sources.filter((s) => st(s) === "kept").length);
  const droppedN = $derived(r.sources.filter((s) => st(s) === "dropped").length);
  const provenance = (s: ResearchSource) => (s.own ? "Your own note (you stated it)" : `External — ${s.site || "the page"} claims it; Home has not tested it`);

  function drop(s: ResearchSource) {
    ui.dropped[s.id] = true;
    void tell(task, `you dropped the source “${s.title}” — leave out its claims`);
  }
  function undrop(s: ResearchSource) {
    delete ui.dropped[s.id];
    void tell(task, `you put the source “${s.title}” back`);
  }
  function pin(id: string, text: string) {
    ui.pinned[id] = !ui.pinned[id];
    void tell(task, ui.pinned[id] ? `you pinned the claim “${text.slice(0, 80)}” — lead the answer with it` : `you unpinned the claim “${text.slice(0, 80)}”`);
  }
  let saving = $state(false);
  async function keepNote() {
    if (saving || ui.saved) return;
    saving = true;
    try {
      const taken = (await api.listNotes("project").catch(() => [])).map((n) => n.name);
      const name = noteName(`Research — ${r.question || task.name}`, taken);
      await api.saveNote("project", name, researchNote(r, ui.dropped));
      ui.saved = name;
    } catch (e) {
      addToast(`Could not keep it as a note — ${String(e)}`);
    } finally {
      saving = false;
    }
  }
  function followUp() {
    document.querySelector<HTMLElement>(".composer [contenteditable], .composer textarea")?.focus();
  }
  const num = (id: string) => claims.findIndex((c) => c.id === id) + 1;
</script>

<div class="h9-grid">
  <div class="h9-col s-mainc">
    <Panel title="Question" sub="{kept} kept · {droppedN} dropped" live={!finished}>
      <p class="s-q">{r.question || task.why || task.name}</p>
    </Panel>
    <div class="h9-row h9-fill">
      <div class="h9-col s-left">
        <Panel title="Sources" sub="as Home reads them">
          {#if r.sources.length === 0}<Loading label={task.doing || "Home is choosing where to look"} lines={3} />{/if}
          {#each r.sources as s, i (s.id)}
            {@const x = st(s)}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="h9-item h9-stagein h9-open s-src {x}" style:--i={i} class:cur={x === "reading"} class:h9-brk={x === "reading"} class:hot={hot === s.id} class:isopen={ui.open === s.id} onmouseenter={() => (hot = s.id)} onmouseleave={() => (hot = null)} onclick={() => toggle(s.id)}>
              {#if x === "reading"}<i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i>{/if}
              <span class="s-fav"><Icon name={s.own ? "note" : "globe"} size={13} /></span>
              <span class="s-main"><span class="s-t">{s.title}</span><span class="s-site">{s.site}{x === "dropped" ? ` — ${ui.dropped[s.id] ? "dropped by you" : s.why || "dropped"}` : ""}</span></span>
              <span class="ns-pill {x === 'kept' ? 'done' : x === 'dropped' ? 'grey' : 'live'}"><span class="dot"></span>{x}</span>
              <span class="h9-chev">▸</span>
            </div>
            {#if ui.open === s.id}
              <Detail rows={[["What was read", s.got || "—"], ["Verdict", x === "reading" ? "Still reading" : x === "kept" ? "Kept" : `Dropped — ${ui.dropped[s.id] ? "by you" : s.why || "by Home"}`], ["Provenance", provenance(s)], ["Claims from it", String(r.claims.filter((k) => k.src === s.id).length)]]}>
                {#if x === "kept"}<Btn small icon="x" tip={"Drop this source\nIts claims go with it; Home reads this at its next look"} onclick={() => drop(s)}>Drop source</Btn>{:else if ui.dropped[s.id]}<Btn small icon="revert" onclick={() => undrop(s)}>Undo drop</Btn>{/if}
              </Detail>
            {/if}
          {/each}
        </Panel>
        <Panel title="What Home is keeping" sub="{claims.length} claim{claims.length === 1 ? '' : 's'}">
          {#each claims as c, i (c.id)}
            {@const src = srcOf(c.src)}
            <div class="s-cw" animate:flip={{ duration: 300 }}>
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div class="s-claim h9-stagein h9-open" id="claim-{c.id}" class:hot={hot === c.src || hot === c.id} class:pin={ui.pinned[c.id]} class:isopen={ui.open === c.id} onmouseenter={() => (hot = c.src)} onmouseleave={() => (hot = null)} onclick={() => toggle(c.id)}>
                <span class="s-n">{i + 1}</span>
                <span class="s-ct">{c.text}{#if src?.site}<span class="ns-chip mono s-cite">{src.site}</span>{/if}</span>
                <Btn small icon="key" on={ui.pinned[c.id]} tip={ui.pinned[c.id] ? "Unpin" : "Pin to the top\nThe answer leads with it"} onclick={() => pin(c.id, c.text)}>{ui.pinned[c.id] ? "Pinned" : "Pin"}</Btn>
              </div>
              {#if ui.open === c.id}
                <Detail rows={[...(c.quote ? ([["Quote", c.quote]] as [string, string][]) : []), ["Source", src ? `${src.title}${src.site ? ` — ${src.site}` : ""}` : "—"], ["Provenance", src ? provenance(src) : "—"], ...(c.confidence ? ([["Confidence", c.confidence]] as [string, string][]) : [])]}>
                  {#if src}<Btn small icon="globe" onclick={() => toggle(src.id)}>Open its source</Btn>{/if}
                </Detail>
              {/if}
            </div>
          {/each}
          {#if claims.length === 0}<p class="h9-dim s-none">Nothing kept yet — a claim lands here with its source.</p>{/if}
        </Panel>
      </div>
      <div class="h9-col" style="flex:1.15;min-width:0">
        <Panel title="Synthesis" sub={finished ? "finished" : "drafting as claims are kept"} live={!finished}>
          <div class="y-ans">
            {#each answer as a, i (i)}
              <p class="h9-stagein">{a.text}{#each a.cites.filter((id) => num(id) > 0) as id (id)}<button class="ns-chip mono y-cite" class:hot={hot === id} onmouseenter={() => (hot = id)} onmouseleave={() => (hot = null)} onclick={() => ((ui.open = id), document.getElementById(`claim-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }))}>claim {num(id)}</button>{/each}</p>
            {/each}
            {#if answer.length === 0}<Loading label="Waiting for the first claim to draft from" lines={3} />{/if}
          </div>
          {#if r.open.length}
            <div class="y-k ns-cap">Open questions</div>
            {#each r.open as o, i (i)}<div class="y-open h9-stagein" class:closed={!!o.answered}><i></i>{o.text}{#if o.answered}<span class="h9-dim"> — {o.answered}</span>{/if}</div>{/each}
          {/if}
          {#if r.confidence}<div class="y-k ns-cap">Confidence</div><div class="y-conf">{r.confidence}</div>{/if}
          {#if finished}
            <div class="y-end"><Btn kind="send" icon="note" small disabled={!!ui.saved || saving} tip={ui.saved ? `Kept in Home's notes as\n${ui.saved}` : "Keep the question, answer, claims and sources\nA new note in Home's notes"} onclick={() => void keepNote()}>{ui.saved ? "Kept in Notes" : saving ? "Keeping…" : "Keep as a note"}</Btn><Btn small icon="reply" tip={"Type the follow-up in the box below\nIt continues this research"} onclick={followUp}>Ask a follow-up</Btn></div>
          {/if}
        </Panel>
      </div>
    </div>
  </div>
  <div class="h9-col h9-wide"><Panel title="Home's steps" live={!finished} flush><Steps id={task.id} /></Panel></div>
</div>

<style>
  .s-q { margin: 0; font-size: 14.5px; line-height: 1.45; font-weight: 500; user-select: text; }
  .s-left { flex: 1; min-width: 0; }
  .s-src { align-items: center; }
  .s-src.dropped .s-t { color: var(--dim); text-decoration: line-through; text-decoration-color: var(--line2); }
  .s-src.hot, .s-claim.hot { border-color: var(--accent); box-shadow: var(--glow-accent); }
  .s-fav { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: var(--r1); background: var(--well); border: 1px solid var(--line2); color: var(--ink2); }
  .s-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .s-t { font-size: 12.5px; font-weight: 500; overflow-wrap: anywhere; }
  .s-site { font: 11px var(--mono); color: var(--dim); overflow-wrap: anywhere; }
  .s-cw { margin-bottom: 4px; }
  .s-claim { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: var(--r1); border: 1px solid var(--line); background: var(--well); cursor: pointer; transition: border-color 150ms, box-shadow 150ms; }
  .s-claim.pin { border-color: color-mix(in srgb, var(--accent) 60%, var(--line2)); }
  .s-n { flex: none; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; font: 500 10px var(--mono); background: var(--term); border: 1px solid var(--line2); color: var(--ink2); }
  .s-ct { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
  .s-cite { margin-left: 6px; font-size: 10px; }
  .s-none { margin: 6px 2px; font-size: 13px; }
  .y-ans p { margin: 0 0 8px; font-size: 13.5px; line-height: 1.55; user-select: text; }
  .y-cite { margin-left: 5px; font-size: 10px; cursor: pointer; }
  .y-cite.hot { border-color: var(--accent); color: var(--accent-ink); }
  .y-k { margin: 12px 0 6px; }
  .y-open { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; color: var(--ink2); margin-bottom: 4px; }
  .y-open i { flex: none; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--accent); }
  .y-open.closed { color: var(--dim); }
  .y-open.closed i { border-color: var(--done); background: var(--done-soft); }
  .y-conf { font-size: 12.5px; color: var(--ink2); line-height: 1.45; }
  .y-end { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  /* A narrow stage (Stage.svelte's .narrow): the two columns stack, the page scrolls. */
  :global(.h9-stage.narrow) .h9-row.h9-fill:has(.s-left) { flex-direction: column; }
  :global(.h9-stage.narrow) .s-mainc { overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }
  :global(.h9-stage.narrow) .s-mainc :global(:is(.h9-row, .h9-col, .h9-panel)) { flex: none !important; min-height: 0 !important; }
  :global(.h9-stage.narrow) .s-mainc :global(.h9-pb) { overflow: visible; }
</style>
