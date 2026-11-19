<script lang="ts">
  /**
   * Home's stage on the phone (nightshift item 845, batch 3; 809 round 6's phone frame): the bar that says what Home
   * is doing and the tab row — Watching, the morning brief, one tab per task Home shows with `update_task`, and Chat —
   * above Home's own sections. Watching is the phone's Home page as it was (Needs you, the scan, Done, Running, Tell
   * Home, Home on this Mac); a task's tab draws the Mac's own view component (Timeline, To-do, Triage, Browse, Run,
   * Research) in its narrow layout, and the brief's tab the Mac's Brief; Chat opens Home's chat screen. Tell Home
   * stays under every tab (HomeFirst). Tab picks are kind A (view-only); a task view's own controls are as on the Mac
   * (B: told to Home through `/home/tasks/event`; C: an answer it waits on).
   *
   * What he picked and each view's state (opened rows, his answers, a Triage draft) are kept in the phone's storage
   * (`stageState.svelte.ts`, the Mac's own keys — the phone's storage is its own), so leaving Home, a reload or
   * closing the page loses nothing.
   */
  import { onDestroy, onMount } from "svelte";
  import "../lib/homeStage/stage.css";
  import "./homeStage.css";
  import Icon from "../lib/Icon.svelte";
  import Brief from "../lib/homeStage/views/Brief.svelte";
  import Timeline from "../lib/homeStage/views/Timeline.svelte";
  import Todo from "../lib/homeStage/views/Todo.svelte";
  import Triage from "../lib/homeStage/views/Triage.svelte";
  import Browse from "../lib/homeStage/views/Browse.svelte";
  import Run from "../lib/homeStage/views/Run.svelte";
  import Research from "../lib/homeStage/views/Research.svelte";
  import { tasks, refreshTasks, closeTask } from "../lib/homeStage/tasks.svelte";
  import { def, keep, stage, type ViewId } from "../lib/homeStage/stageState.svelte";
  import { tabsFor, focusOf, type Tab } from "../lib/homeStage/tabs";
  import { setStageHost, type HomeTask } from "../lib/homeStage/host";
  import { phoneBrief, phoneStageHost } from "./phoneStageHost";
  import type { Client, HomeScanWire } from "./client";

  interface Props {
    client: Client;
    home: { project: string | null; chat: string | null };
    scan: HomeScanWire | null;
    /** What waits on him (Watching's count). */
    needs: number;
    /** Jarvis (the Filament look); Classic draws the same views plainly. */
    fil: boolean;
    /** Bumped when Home's page reads again (a turn ended, the page came back). */
    tick?: number;
    /** Watching is in focus: Home's own sections show under the tabs. */
    watching?: boolean;
    onopen: (chat: string, project: string | null) => void;
    onnote: (text: string) => void;
  }
  let { client, home, scan, needs, fil, tick: bump = 0, watching = $bindable(true), onopen, onnote }: Props = $props();

  // The views ask this page for what they need (set before any view draws).
  setStageHost(phoneStageHost({ client: () => client, home: () => home, scan: () => scan, open: (c, p) => onopen(c, p), note: (t) => onnote(t) }));

  const TASK_VIEWS = ["timeline", "todo", "triage", "browse", "run", "research"];
  const shown = $derived(tasks.rows.filter((t) => TASK_VIEWS.includes(t.view)));
  const taskOf = (id: string): HomeTask | undefined => shown.find((t) => `task:${t.id}` === id);
  const brief = $derived(phoneBrief(scan));
  const more = $derived<Tab[]>([
    ...(brief ? [{ id: "brief", view: "brief", name: "Morning brief", needs: 0, live: false } as Tab] : []),
    ...shown.map((t): Tab => ({ id: `task:${t.id}`, view: t.view as ViewId, name: t.name, needs: t.needs, live: t.state === "live" })),
  ]);
  const row = $derived(tabsFor({ blank: !home.chat, needs, more }));
  // Chat is not a view on the phone: its tab opens Home's chat screen, so focus never rests on it.
  const focus = $derived(focusOf(row.filter((t) => t.view !== "chat"), stage.focus));
  const focusTask = $derived(taskOf(focus.id));
  const doing = $derived(focusTask ? (focusTask.state === "live" ? focusTask.doing || def(focusTask.view as ViewId).doing : `Done — ${focusTask.name}`) : def(focus.view).doing);
  $effect(() => {
    watching = focus.view === "watch";
  });
  $effect(() => {
    JSON.stringify(stage);
    keep();
  });
  let width = $state(390);
  // The tab in focus is scrolled into the row's view (the row scrolls sideways on a phone; never the page).
  let tabsEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const id = focus.id;
    const el = tabsEl?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`);
    if (tabsEl && el && (el.offsetLeft < tabsEl.scrollLeft || el.offsetLeft + el.offsetWidth > tabsEl.scrollLeft + tabsEl.clientWidth)) tabsEl.scrollLeft = Math.max(0, el.offsetLeft - 12);
  });

  function pick(t: Tab) {
    if (t.view === "chat") {
      if (home.chat) onopen(home.chat, home.project);
      return;
    }
    stage.focus = t.id;
  }
  async function close(t: HomeTask) {
    if (focus.id === `task:${t.id}`) stage.focus = "watch";
    await closeTask(t.id).catch(() => {});
  }

  // The tasks: read when Home opens, every 30 s while it shows (as Home's page), when the page reads again, and when
  // the phone comes back to the page.
  let timer: ReturnType<typeof setInterval> | null = null;
  const onVisible = () => document.visibilityState === "visible" && void refreshTasks();
  onMount(() => {
    void refreshTasks();
    timer = setInterval(() => void refreshTasks(), 30_000);
    document.addEventListener("visibilitychange", onVisible);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  });
  let lastBump = 0;
  $effect(() => {
    if (bump !== lastBump) {
      lastBump = bump;
      void refreshTasks();
    }
  });
</script>

<div class="h9-stage phone" class:classic={!fil} class:narrow={width <= 760} class:tiny={width <= 480} bind:clientWidth={width} data-home-stage data-phone-stage>
  <div class="h9-bar">
    <span class="h9-home"><i class="h9-dot" class:idle={!focusTask || focusTask.state !== "live"} aria-hidden="true"></i>HOME</span>
    <span class="h9-doing">{doing}</span>
  </div>
  <div class="h9-tabs" role="tablist" bind:this={tabsEl}>
    {#each row as t (t.id)}
      <button class="h9-tab" data-tab={t.id} class:on={focus.id === t.id} role="tab" aria-selected={focus.id === t.id} onclick={() => pick(t)} aria-label={t.view === "chat" ? "Open Home's chat" : undefined}>
        <Icon name={def(t.view).icon} size={13} /><span class="tn">{t.name}</span>
        {#if t.live}<i class="pulse" class:amber={t.needs > 0}></i>{/if}
        {#if t.needs > 0}<span class="cnt" aria-label="{t.needs} need you">{t.needs}</span>{/if}
        {#if focus.id === t.id && taskOf(t.id)}<!-- svelte-ignore a11y_click_events_have_key_events --><span class="h9-x" role="button" tabindex="-1" aria-label="Close this tab" onclick={(e) => (e.stopPropagation(), void close(taskOf(t.id)!))}>×</span>{/if}
      </button>
    {/each}
    <span class="sep"></span>
  </div>
  {#if focus.view !== "watch"}
    <div class="h9-body">
      {#key focus.id}
        <div class="h9-view">
          {#if focus.view === "brief"}
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
          {/if}
        </div>
      {/key}
    </div>
  {/if}
</div>
