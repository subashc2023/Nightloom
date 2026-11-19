<script lang="ts">
  // Home's stage (nightshift item 845; the design is 809 round 6). Home's project does not open on the app's new-chat
  // page or a bare transcript: it opens here. The bar says what Home is doing; the tab row lists what is live; one
  // view is in focus. A blank Home chat is Watch (Home's own new-chat page); the conversation is the Chat tab, the
  // app's own transcript inside the stage's frame (Home's own chat screen). The message box is the app's Composer,
  // under the stage, never remounted by a view switch. A send lands in the reply strip; the stage does not move.
  // Tab clicks, the strip's Open chat and Close are kind A (view-only).
  import { untrack, type Snippet } from "svelte";
  import "./stage.css";
  import Icon from "../Icon.svelte";
  import { tip } from "../tip";
  import { hudIn, hudOut } from "../hudMenu";
  import { app } from "../state.svelte";
  import { classic } from "../layout.svelte";
  import { home, refreshHome, refreshReach, refreshSources, refreshRoutes } from "../home.svelte";
  import { isScanMessage } from "../home";
  import { needsNow } from "../needsBoard.svelte";
  import Btn from "./Btn.svelte";
  import Watch from "./views/Watch.svelte";
  import Brief from "./views/Brief.svelte";
  import Timeline from "./views/Timeline.svelte";
  import Todo from "./views/Todo.svelte";
  import Triage from "./views/Triage.svelte";
  import Browse from "./views/Browse.svelte";
  import Run from "./views/Run.svelte";
  import Research from "./views/Research.svelte";
  import { tasks, refreshTasks, closeTask, type HomeTask } from "./tasks.svelte";
  import { briefOf } from "./brief";
  import { def, keep, stage, type ViewId } from "./stageState.svelte";
  import { lastExchange, type Ev } from "./steps";
  import { tabsFor, focusOf, type Tab } from "./tabs";

  let { blank, children }: { blank: boolean; children: Snippet } = $props();

  const needs = $derived(needsNow().filter((r) => r.state !== "working").length + home.cards.length);
  const brief = $derived(briefOf(app.events as unknown as Ev[], isScanMessage, app.busy));
  // The views a task of Home's may be drawn in.
  const TASK_VIEWS = ["timeline", "todo", "triage", "browse", "run", "research"];
  const shown = $derived(tasks.rows.filter((t) => TASK_VIEWS.includes(t.view)));
  const taskOf = (id: string): HomeTask | undefined => shown.find((t) => `task:${t.id}` === id);
  // The tabs live work adds: the morning brief once this chat holds a scan (its pulse while Home writes it), and one
  // tab per task Home shows with `update_task` (its pulse while live, its count of what waits on him).
  const more = $derived<Tab[]>([
    ...(brief ? [{ id: "brief", view: "brief", name: brief.writing ? "Writing the morning brief" : "Morning brief", needs: 0, live: brief.writing } as Tab] : []),
    ...shown.map((t): Tab => ({ id: `task:${t.id}`, view: t.view as ViewId, name: t.name, needs: t.needs, live: t.state === "live" })),
  ]);
  const row = $derived(tabsFor({ blank, needs, more }));
  const focus = $derived(focusOf(row, stage.focus));
  const last = $derived(lastExchange(app.events as unknown as Ev[], isScanMessage));
  const focusTask = $derived(taskOf(focus.id));
  const doing = $derived(focusTask ? (focusTask.state === "live" ? focusTask.doing || def(focusTask.view as ViewId).doing : `Done — ${focusTask.name}`) : focus.view === "brief" ? (brief?.writing ? "Writing your morning brief" : def("brief").doing) : app.busy && focus.view !== "chat" ? "Working on what you sent" : def(focus.view).doing);
  const chips: Record<string, HTMLElement> = $state({});
  // The view's width in CSS px (the body less the view's 14 px insets) — what .narrow and .tiny are set from, since
  // WebKit reads a container query at width × the page zoom (stage.css, fold.ts).
  let bodyW = $state(1200);
  const viewW = $derived(bodyW - 28);

  // A new send opens the strip again (he closed it on an older message).
  $effect(() => {
    const at = last?.at;
    untrack(() => {
      if (at && at !== stage.stripFor && stage.strip === "closed") stage.strip = "open";
    });
  });
  $effect(() => {
    JSON.stringify(stage);
    untrack(keep);
  });
  // Home's own data, read when the stage opens and every minute while it shows (files and one status call; no model).
  $effect(() => {
    const read = () => {
      void refreshHome();
      void refreshRoutes();
      void refreshSources();
    };
    // Untracked: the refreshes read and write their own flags (home.loading); tracked, this effect would re-run forever.
    untrack(() => {
      read();
      void refreshReach();
      void refreshTasks();
    });
    const t = setInterval(() => (read(), void refreshTasks()), 60_000);
    return () => clearInterval(t);
  });
  // The tasks are re-read when the chat moves (a step landed — `update_task` may have written) and when a turn ends.
  $effect(() => {
    void app.events.length;
    void app.busy;
    untrack(() => void refreshTasks());
  });
  // A view switch animates only when he picked the tab. A switch the stage makes itself (the tab he left it on comes
  // back once the chat or the tasks are read, at every open) is instant — no exit animation to wait on, so no old view
  // ever stays drawn behind the new one (the 845 "ghost": a hidden window never finishes an exit).
  let picked = false;
  const viewIn = (node: HTMLElement, a: { anchor?: HTMLElement | null }) => (picked ? hudIn(node, a) : { duration: 0 });
  const viewOut = (node: HTMLElement) => (picked ? hudOut(node) : { duration: 0 });
  function closeStrip() {
    stage.strip = "closed";
    stage.stripFor = last?.at ?? "";
  }
  function pick(id: string) {
    if (stage.focus === id && focus.id === id) return;
    picked = true;
    stage.focus = id;
    setTimeout(() => (picked = false), 0);
  }
  async function close(t: HomeTask) {
    if (focus.id === `task:${t.id}`) pick("watch");
    await closeTask(t.id);
  }
</script>

<div class="h9-stage real" class:classic={classic()} class:blank class:narrow={viewW <= 760} class:tiny={viewW <= 480} data-home-stage>
  <div class="h9-bar">
    <span class="h9-home"><i class="h9-dot" class:idle={!app.busy} aria-hidden="true"></i>HOME</span>
    {#key doing}<span class="h9-doing h9-stagein">{doing}</span>{/key}
    <span class="h9-grow"></span>
    {#if home.info?.scan_words}<span class="h9-ms ns-mono" use:tip={"The morning scan's schedule\nChange it in Settings → Home"}>scan {home.info.scan_words.toLowerCase()}</span>{/if}
  </div>
  <div class="h9-tabs" role="tablist">
    {#each row as t (t.id)}
      <button class="h9-tab" class:on={focus.id === t.id} role="tab" aria-selected={focus.id === t.id} bind:this={chips[t.id]} onclick={() => pick(t.id)} use:tip={`${t.name}\n${t.needs > 0 ? `${t.needs} need${t.needs === 1 ? "s" : ""} you` : `${def(t.view).name} view`}`}>
        <Icon name={def(t.view).icon} size={13} /><span class="tn">{t.name}</span>
        {#if t.live}<i class="pulse" class:amber={t.needs > 0}></i>{/if}
        {#if t.needs > 0}<span class="cnt" aria-label="{t.needs} need you">{t.needs}</span>{/if}
        {#if focus.id === t.id && taskOf(t.id)}<!-- svelte-ignore a11y_click_events_have_key_events --><span class="h9-x" role="button" tabindex="-1" aria-label="Close this tab" use:tip={"Close this tab\nHome's work goes on; only the tab goes"} onclick={(e) => (e.stopPropagation(), void close(taskOf(t.id)!))}>×</span>{/if}
      </button>
    {/each}
    <span class="sep"></span>
  </div>
  <div class="h9-body" bind:clientWidth={bodyW}>
    {#key focus.id}
      <div class="h9-view" class:chatview={focus.view === "chat"} in:viewIn|global={{ anchor: chips[focus.id] }} out:viewOut|global>
        {#if focus.view === "chat"}
          <div class="h9-chat">{@render children()}</div>
        {:else if focus.view === "brief"}
          <Brief />
        {:else if focusTask && focusTask.view === "timeline"}
          <Timeline task={focusTask} />
        {:else if focusTask && focusTask.view === "todo"}
          <Todo task={focusTask} />
        {:else if focusTask && focusTask.view === "triage"}
          <Triage task={focusTask} />
        {:else if focusTask && focusTask.view === "browse"}
          <Browse task={focusTask} />
        {:else if focusTask && focusTask.view === "run"}
          <Run task={focusTask} />
        {:else if focusTask && focusTask.view === "research"}
          <Research task={focusTask} />
        {:else}
          <Watch />
        {/if}
      </div>
    {/key}
  </div>
  {#if last && stage.strip === "open" && focus.view !== "chat"}
    {#key last.at}
      <div class="h9-strip">
        <div class="h9-strip-b">
          <span class="h9-him"><b>YOU</b>{last.him}</span>
          {#if last.home}<div class="h9-said"><span class="h9-said-tx">{last.home}</span></div>
          {:else if app.busy}<div class="h9-said"><span class="h9-said-th live">Home is working on it…</span></div>{/if}
          <span class="h9-said-where">Sent to Home · the whole conversation is in Chat</span>
        </div>
        <Btn small icon="chat" tip={"The whole conversation\nOpens as its own view"} onclick={() => pick("chat")}>Open chat</Btn>
        <Btn small icon="x" label="Close" onclick={closeStrip} />
      </div>
    {/key}
  {/if}
</div>

<style>
  /* In the app the stage is the content box itself, not a layer over a transcript (the prototype's harness). */
  .h9-stage.real { position: relative; inset: auto; z-index: auto; flex: 1; min-height: 0; }
  /* Home's own chat screen: the app's transcript, inside the stage's frame with Home's edge. */
  .h9-view.chatview { inset: 8px 10px 0; border: 1px solid color-mix(in srgb, var(--home) 26%, var(--line2)); border-bottom: 0; border-radius: var(--r2) var(--r2) 0 0; overflow: hidden; background: var(--paper); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--home) 30%, transparent); }
  .h9-chat { position: relative; height: 100%; display: flex; flex-direction: column; min-height: 0; }
  .h9-strip { max-height: 132px; overflow-y: auto; }
  .h9-said-tx { white-space: pre-wrap; }
  /* Classic (item 542's layout): the same stage in Classic's plain dress — no glows, no pulse, square tabs. */
  .h9-stage.classic { --home: #7a63c7; --home-glow: none; }
  .h9-stage.classic :global(.h9-dot) { animation: none; box-shadow: none; }
  .h9-stage.classic :global(.h9-panel) { box-shadow: none; }
  .h9-stage.classic :global(.jb) { box-shadow: none; text-shadow: none; }
  .h9-stage.classic :global(.jb-scan), .h9-stage.classic :global(.bk) { display: none; }
  .h9-stage.classic .h9-home { letter-spacing: 0.08em; }
  .h9-stage.classic .h9-view.chatview { box-shadow: none; }
  /* Classic, the task views (Timeline, To-do, Triage): the same marks without glows or moving scan lines. */
  .h9-stage.classic :global(:is(.t-ev, .t-nowl, .t-now, .t-ask, .t-band, .d-box, .d-sub i, .g-card, .g-pile)) { box-shadow: none; }
  .h9-stage.classic :global(:is(.d-beam, .g-read)) { display: none; }
  .h9-stage.classic :global(.d-sub.on i) { animation: none; }
  /* Classic, Browse, Run, Research: no glows, no sweeping link, no pulsing marks. */
  .h9-stage.classic :global(:is(.r-node, .r-av, .s-src.hot, .s-claim.hot)) { box-shadow: none; }
  .h9-stage.classic :global(.r-link.live::after) { display: none; }
  .h9-stage.classic :global(.r-node.live .r-mark) { animation: none; }
</style>
