<script lang="ts">
  // Brief (item 845; 809 round 6) — the morning scan as a page, from the Home chat's newest scan: a count per
  // section on top, each section opening for its text, what the scan was given to read, and Home's steps.
  // Every control here is kind A (view-only). "Read it to me" and "Keep as a note" (846 §4) are not built yet.
  import { app } from "../../state.svelte";
  import { clock, dateLabel, factsWords, isScanMessage, scanFacts } from "../../home";
  import { home } from "../../home.svelte";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Loading from "../Loading.svelte";
  import { bag, reveal } from "../stageState.svelte";
  import { briefOf } from "../brief";
  import type { Ev } from "../steps";

  const brief = $derived(briefOf(app.events as unknown as Ev[], isScanMessage, app.busy));
  const ui = bag("brief", { open: {} as Record<string, boolean>, touched: false });
  const isOpen = (key: string, i: number) => (ui.touched ? !!ui.open[key] : i === 0);
  function toggle(key: string, i: number) {
    const now = !isOpen(key, i);
    if (!ui.touched) (ui.open = {}), (ui.touched = true);
    ui.open[key] = now;
  }
  const when = $derived(brief?.at ? `${dateLabel(brief.at)}, ${clock(brief.at)}` : "");
  const read = $derived(brief ? factsWords(scanFacts(brief.asked)) : "");
</script>

<div class="h9-grid">
  <div class="h9-col">
    {#if brief && brief.sections.length}
      <div class="b-counts">
        {#each brief.sections as s, i (s.key)}
          <button class="b-count" class:on={isOpen(s.key, i)} onclick={() => toggle(s.key, i)}><b class="h9-num">{s.lines || "·"}</b><span>{s.title}</span></button>
        {/each}
      </div>
    {/if}
    <Panel title="Today's page" sub={when} live={!!brief?.writing}>
      {#if !brief}
        <span class="h9-dim b-none">No scan in this chat yet — the morning scan runs {home.info?.scan_words?.toLowerCase() ?? "every day at 8:00 AM"}, and its page lands here.</span>
      {:else if brief.sections.length === 0}
        <Loading label={brief.writing ? "Home is writing today's page" : "The scan ended without a page"} lines={4} />
      {:else}
        {#each brief.sections as s, i (s.key)}
          {@const open = isOpen(s.key, i)}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="h9-item h9-open h9-stagein b-sec" style:--i={i} class:isopen={open} onclick={() => toggle(s.key, i)}><span class="h9-chev">▸</span><span class="b-title">{s.title}</span>{#if s.lines}<span class="h9-mono h9-dim">{s.lines} line{s.lines === 1 ? "" : "s"}</span>{/if}</div>
          {#if open}<div class="b-body" use:reveal>{s.body}</div>{/if}
        {/each}
        {#if brief.writing}<Loading label="Home is still writing" lines={2} />{/if}
      {/if}
    </Panel>
  </div>
  <div class="h9-col h9-wide">
    {#if read}<Panel title="What the scan read"><span class="b-read">{read}</span></Panel>{/if}
    <Panel title="Home's steps" live={app.busy} flush><Steps id="brief" /></Panel>
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
