<script lang="ts">
  // Browse (item 845; 809 round 6) — Home on a website for him, on live data. When the Home chat has the app's own
  // browser (item 508), its live picture is here with the app's Take over / Give back (ClaudeBrowserView: his clicks
  // reach the page only after he clicks into it). Without one, the page Home reports (`update_task` data: url, page,
  // the fields it filled) is drawn as a card. Either way, a hold — something Home will not do without him (pay,
  // submit, send) — is a card of its own.
  //   Allow once / Not now / I'll do it myself — kind C: an answer to the hold, kept here at once and told to Home.
  //   Undo on an answer — kind B. Opening a field — kind A.
  import Icon from "../../Icon.svelte";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Btn from "../Btn.svelte";
  import Detail from "../Detail.svelte";
  import Loading from "../Loading.svelte";
  import { bag } from "../stageState.svelte";
  import { tell, type HomeTask } from "../tasks.svelte";
  import { browseOf } from "../taskData";
  import { stageHost } from "../host";

  let { task }: { task: HomeTask } = $props();
  const b = $derived(browseOf(task.data));
  // svelte-ignore state_referenced_locally
  const ui = bag(`task:${task.id}`, { answer: {} as Record<string, "yes" | "no" | "mine">, open: null as string | null });
  // The chat's browser status, read when the view opens and at each edge of a turn (events keep it between). The live
  // picture is the Mac's (the host's BrowserView, ClaudeBrowserView there); the phone draws the reported page.
  $effect(() => stageHost.now.watchBrowser());
  const session = $derived(stageHost.now.liveBrowser());
  const live = $derived(!!session);
  const BrowserView = stageHost.now.BrowserView;
  const answer = $derived(b.hold ? ui.answer[b.hold.id] : undefined);
  const WORDS = { yes: "Allowed once", no: "Not now — held", mine: "You'll do it yourself" } as const;
  function decide(v: "yes" | "no" | "mine") {
    if (!b.hold) return;
    ui.answer[b.hold.id] = v;
    void tell(task, v === "yes" ? `you allowed once: ${b.hold.what}` : v === "no" ? `you said not now to: ${b.hold.what} — do not do it` : `you will do it yourself: ${b.hold.what} — leave the page to you`);
  }
  function undo() {
    if (!b.hold) return;
    delete ui.answer[b.hold.id];
    void tell(task, `you took back your answer on: ${b.hold.what} — ask again`);
  }
  // One sentence, built in script so no spacing is lost around the template's {#if} blocks.
  const holdWords = $derived(b.hold ? `${b.hold.what}${b.hold.amount ? ` — ${b.hold.amount}` : ""}${b.hold.to ? ` to ${b.hold.to}` : ""}${b.hold.from ? `, from ${b.hold.from}` : ""}. Home does not do this without you.` : "");
  const toggle = (id: string) => (ui.open = ui.open === id ? null : id);
</script>

{#snippet holdCard()}
    <Panel title={answer ? WORDS[answer] : "Home is holding"} lock={!answer} keep>
      <p class="w-hold">{holdWords}</p>
      {#if !answer}
        <span class="h9-acts"><Btn kind="send" icon="check" small onclick={() => decide("yes")}>Allow once</Btn><Btn small onclick={() => decide("no")}>Not now</Btn><Btn small onclick={() => decide("mine")}>I'll do it myself</Btn></span>
      {:else}
        <span class="h9-acts"><span class="ns-pill {answer === 'yes' ? 'done' : 'partial'}"><span class="dot"></span>Home reads this at its next look</span><Btn small icon="revert" tip={"Take back your answer\nHome asks again"} onclick={undo}>Undo</Btn></span>
      {/if}
    </Panel>
{/snippet}

<div class="h9-grid">
  <div class="h9-col">
    <Panel title="Home's browser" sub={live ? "live — the page Home sees" : b.site || "what Home reports"} live={task.state === "live"} flush>
      {#if task.why}<div class="h9-why" style="margin:6px 12px 0"><b>YOU ASKED</b><span>{task.why}</span></div>{/if}
      {#if live && session && BrowserView}
        <div class="w-live"><BrowserView {session} /></div>
      {:else}
        <div class="w-chrome">
          <span class="w-url"><Icon name="lock" size={11} /><span>{b.url || "no page yet"}</span></span>
          <span class="ns-pill {task.state === 'live' ? 'live' : 'done'}"><span class="dot"></span>{task.state === "live" ? "Home" : "done"}</span>
        </div>
        <div class="w-page">
          {#if !b.url && !b.page && b.fields.length === 0}
            <Loading label={task.doing || "Home is opening the page"} lines={4} />
          {:else}
            {#if b.page}<h3 class="w-title">{b.page}</h3>{/if}
            {#each b.fields as f, i (f.label + i)}
              {@const k = `f${i}`}
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div class="h9-item h9-open h9-stagein w-field" style:--i={i} class:isopen={ui.open === k} onclick={() => toggle(k)}>
                <span class="w-fl">{f.label}</span><span class="w-fv">{f.value || "—"}</span><span class="h9-chev">▸</span>
              </div>
              {#if ui.open === k}<Detail rows={[["Field", f.label], ["Home typed", f.value || "Nothing yet"], ["Where", b.url || b.site || "The page Home is on"]]} />{/if}
            {/each}
            {#if b.result}<span class="ns-pill done w-result"><span class="dot"></span>{b.result}</span>{/if}
            <p class="w-note h9-dim">Home's browser runs in Claude Code. Its live picture shows here when this chat has the app's browser on.</p>
          {/if}
        </div>
      {/if}
    </Panel>
    {#if b.hold}<div class="w-narrow">{@render holdCard()}</div>{/if}
  </div>
  <div class="h9-col h9-wide">
    {#if b.hold}{@render holdCard()}{/if}
    <Panel title="Home's steps" live={task.state === "live"} flush><Steps id={task.id} /></Panel>
  </div>
</div>

<style>
  /* A narrow stage (and the phone) does not draw the wide column; the hold, kind C, is drawn in the main one there. */
  .w-narrow { display: none; }
  :global(.h9-stage.narrow) .w-narrow { display: contents; }
  .w-live { position: relative; flex: 1; min-height: 0; height: calc(100% - 4px); display: flex; flex-direction: column; }
  .w-chrome { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
  .w-url { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 13px; background: var(--term); border: 1px solid var(--line2); font: 12px var(--mono); color: var(--ink2); }
  .w-url span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .w-page { padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
  .w-title { margin: 2px 0 8px; font-size: 15px; font-weight: 600; }
  .w-field { align-items: baseline; }
  .w-fl { flex: none; width: 34%; min-width: 90px; font-size: 12px; color: var(--dim); }
  .w-fv { flex: 1; min-width: 0; font: 12.5px var(--mono); color: var(--ink); overflow-wrap: anywhere; }
  .w-result { align-self: flex-start; margin-top: 8px; }
  .w-note { margin: 12px 2px 0; font-size: 11.5px; }
  .w-hold { margin: 0 0 10px; font-size: 13px; line-height: 1.45; color: var(--ink2); }
</style>
