<script lang="ts">
  // Brief (item 845; 809 round 6) — the morning scan as a page, from the Home chat's newest scan: a count per
  // section on top, each section opening for its text, what the scan was given to read, and Home's steps.
  // Every control here is kind A (view-only, no model call). "Read it to me" speaks the page with the Mac's own voice
  // (the web view's speech; it stops when he leaves the view, and the button is not drawn where there is no voice).
  // "Keep as a note" writes the page into Home's notes as a new file (never over one he has); once kept, it says so.
  // Item 898: with `task`, the same page draws a page Home wrote with update_task (view "brief", data {title, body})
  // instead of the morning scan.
  import { onDestroy } from "svelte";
  import { clock, dateLabel, factsWords, scanFacts } from "../../home";
  import { tip } from "../../tip";
  import Panel from "../Panel.svelte";
  import Btn from "../Btn.svelte";
  import Steps from "../Steps.svelte";
  import Loading from "../Loading.svelte";
  import { bag, reveal } from "../stageState.svelte";
  import { briefNote, sectionsOf, speakable, type Brief } from "../brief";
  import { stageHost, type HomeTask } from "../host";
  import { briefPageOf, noteName } from "../taskData";
  import MathText from "../../MathText.svelte";
  import JobRunConfirm from "../../../remote/JobRunConfirm.svelte";
  import { confirmPatch, type Job } from "../../../remote/jobs";

  let { task }: { task?: HomeTask } = $props();
  const page = $derived(task ? briefPageOf(task.data) : null);
  const brief = $derived<Brief | null>(task && page ? { at: task.updated_at || null, asked: "", sections: sectionsOf(page.body), writing: task.state === "live" && !page.body } : stageHost.now.brief());
  const skipped = $derived(stageHost.now.skippedScan());

  // Item 910: a scheduled skip asks him here (Run it now / Keep skipping); answered once on any surface — the job's
  // card goes for every one. Read when drawn, every 20 s, and after his answer.
  let scanJob = $state<Job | null>(null);
  let answering = $state(false);
  async function readScanJob() {
    if (task || !stageHost.now.scanJob) return;
    try {
      scanJob = await stageHost.now.scanJob();
    } catch {
      scanJob = null;
    }
  }
  $effect(() => {
    void skipped;
    void readScanJob();
    const t = setInterval(() => void readScanJob(), 20000);
    return () => clearInterval(t);
  });
  async function answerScan(run: boolean) {
    const j = scanJob;
    if (!j || answering || !stageHost.now.answerJob) return;
    answering = true;
    try {
      await stageHost.now.answerJob(j.id, confirmPatch(run));
    } catch (e) {
      stageHost.now.toast(`Could not answer — ${String(e)}`);
    } finally {
      answering = false;
      await readScanJob();
    }
  }
  const title = $derived(task ? page?.title || task.name : "Today's page");
  // The stage keys each view on its tab, so another task is another view.
  // svelte-ignore state_referenced_locally
  const ui = bag(task ? `task:${task.id}` : "brief", { open: {} as Record<string, boolean>, touched: false, saved: {} as Record<string, string> });
  const isOpen = (key: string, i: number) => (ui.touched ? !!ui.open[key] : i === 0);
  function toggle(key: string, i: number) {
    const now = !isOpen(key, i);
    if (!ui.touched) (ui.open = {}), (ui.touched = true);
    ui.open[key] = now;
  }
  const when = $derived(brief?.at ? `${dateLabel(brief.at)}, ${clock(brief.at)}` : "");
  const read = $derived(brief ? factsWords(scanFacts(brief.asked)) : "");
  const done = $derived(!!brief && !brief.writing && brief.sections.length > 0);
  const savedAs = $derived(brief ? ui.saved[brief.at ?? ""] : undefined);

  // Read it to me: the page in the Mac's own voice, section by section.
  const voice = typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined" ? window.speechSynthesis : null;
  let reading = $state(false);
  function stopReading() {
    voice?.cancel();
    reading = false;
  }
  function readAloud() {
    if (!voice || !brief) return;
    if (reading) return stopReading();
    voice.cancel();
    const parts = brief.sections.map((s) => `${s.title}. ${speakable(s.body)}`);
    parts.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t);
      if (i === parts.length - 1) u.onend = u.onerror = () => (reading = false);
      voice.speak(u);
    });
    reading = true;
  }
  onDestroy(stopReading);

  let saving = $state(false);
  async function keepNote() {
    if (!brief || saving || savedAs) return;
    saving = true;
    try {
      const taken = await stageHost.now.noteNames();
      const name = noteName(task ? title : `Morning brief — ${when ? dateLabel(brief.at!) : "today"}`, taken);
      await stageHost.now.saveNote(name, briefNote(brief, when));
      ui.saved[brief.at ?? ""] = name;
    } catch (e) {
      stageHost.now.toast(`Could not keep it as a note — ${String(e)}`);
    } finally {
      saving = false;
    }
  }
</script>

<div class="h9-grid">
  <div class="h9-col">
    {#if brief && brief.sections.length}
      <div class="b-counts">
        {#each brief.sections as s, i (s.key)}
          <button class="b-count" class:on={isOpen(s.key, i)} onclick={() => toggle(s.key, i)}><b class="h9-num">{s.lines || "·"}</b><span data-ellipsis use:tip={s.title}>{s.title}</span></button>
        {/each}
      </div>
    {/if}
    <Panel {title} sub={when} live={!!brief?.writing}>
      {#snippet tools()}
        {#if done}
          {#if voice}<Btn small kind={reading ? "ghost" : "send"} icon={reading ? "stop" : "play"} tip={reading ? "Stop reading" : "Read the page aloud\nThe Mac's own voice; nothing is sent"} onclick={readAloud}>{reading ? "Stop reading" : "Read it to me"}</Btn>{/if}
          <Btn small icon="note" disabled={!!savedAs || saving} tip={savedAs ? `Kept in Home's notes as\n${savedAs}` : task ? "Keep this page\nA new note in Home's notes" : "Keep today's page\nA new note in Home's notes"} onclick={() => void keepNote()}>{savedAs ? "Kept in Notes" : saving ? "Keeping…" : "Keep as a note"}</Btn>
        {/if}
      {/snippet}
      {#if !task && scanJob?.confirm?.scheduled}
        <div data-scan-ask><JobRunConfirm job={scanJob} busy={answering} onanswer={(run) => void answerScan(run)} /></div>
      {/if}
      {#if !brief && !task && skipped}
        <span class="h9-dim b-none" data-scan-skipped>Today's scan was skipped at {clock(skipped.at)} — {skipped.why}. Home's chat has no page for it; the facts alone are on the phone's Home.</span>
      {:else if !brief}
        <span class="h9-dim b-none">No scan in this chat yet — the morning scan runs {stageHost.now.scanWords()?.toLowerCase() ?? "every day at 8:00 AM"}, and its page lands here.</span>
      {:else if brief.sections.length === 0}
        <Loading label={brief.writing ? (task ? task.doing || "Home is writing this page" : "Home is writing today's page") : task ? "Home has not written this page yet" : "The scan ended without a page"} lines={4} />
      {:else}
        {#each brief.sections as s, i (s.key)}
          {@const open = isOpen(s.key, i)}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="h9-item h9-open h9-stagein b-sec" style:--i={i} class:isopen={open} onclick={() => toggle(s.key, i)}><span class="h9-chev">▸</span><span class="b-title">{s.title}</span>{#if s.lines}<span class="h9-mono h9-dim">{s.lines} line{s.lines === 1 ? "" : "s"}</span>{/if}</div>
          {#if open}<div class="b-body" use:reveal><MathText text={s.body} /></div>{/if}
        {/each}
        {#if brief.writing}<Loading label="Home is still writing" lines={2} />{/if}
      {/if}
    </Panel>
  </div>
  <div class="h9-col h9-wide">
    {#if read}<Panel title="What the scan read"><span class="b-read">{read}</span></Panel>{/if}
    <Panel title="Home's steps" live={stageHost.now.busy()} flush><Steps id="brief" /></Panel>
  </div>
</div>

<style>
  .b-counts { display: flex; gap: 8px; flex: none; overflow-x: auto; scrollbar-width: none; }
  .b-count { flex: 1 1 0; min-width: 96px; display: flex; flex-direction: column; gap: 2px; align-items: flex-start; padding: 8px 12px; border-radius: var(--r2); border: 1px solid var(--line2); background: var(--well); color: var(--ink2); font-size: 11.5px; text-align: left; cursor: pointer; }
  .b-count b { font: 500 20px var(--mono); color: var(--ink); }
  .b-count.on { border-color: var(--accent); color: var(--ink); }
  .b-count span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .b-sec { align-items: baseline; }
  .b-title { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; }
  .b-body { margin: 2px 0 8px 22px; padding: 8px 12px; border-left: 2px solid color-mix(in srgb, var(--home) 50%, transparent); font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .b-none { display: block; padding: 6px 2px; font-size: 12.5px; }
  .b-read { display: block; font-size: 12px; color: var(--ink2); line-height: 1.45; }
</style>
