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
  import { onDestroy, onMount, untrack } from "svelte";
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
  import { tasks, refreshTasks, closeTask, STALE_WORDS } from "../lib/homeStage/tasks.svelte";
  import { bag, def, keep, stage, type ViewId } from "../lib/homeStage/stageState.svelte";
  import { keepScroll } from "../lib/homeStage/keepScroll";
  import Btn from "../lib/homeStage/Btn.svelte";
  import Steps from "../lib/homeStage/Steps.svelte";
  import { rulesPass, foldDone, unfold, holdsHim, type FocusKept } from "../lib/homeStage/focus";
  import type { Ev } from "../lib/homeStage/steps";
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
    /** The view in focus and its task's name, for the header on his Tell Home message (846 §7 step 3). */
    where?: { view: string; task: string };
    onopen: (chat: string, project: string | null) => void;
    onnote: (text: string) => void;
  }
  let { client, home, scan, needs, fil, tick: bump = 0, watching = $bindable(true), where = $bindable({ view: "watch", task: "" }), onopen, onnote }: Props = $props();

  // The views ask this page for what they need (set before any view draws).
  let steps = $state<Ev[]>([]);
  setStageHost(phoneStageHost({ client: () => client, home: () => home, scan: () => scan, open: (c, p) => onopen(c, p), note: (t) => onnote(t), steps: () => steps }));

  // Item 898: "brief" too — a page Home wrote with update_task, drawn by the Brief view.
  const TASK_VIEWS = ["timeline", "todo", "triage", "browse", "run", "research", "brief"];
  const shown = $derived(tasks.rows.filter((t) => TASK_VIEWS.includes(t.view)));
  const taskOf = (id: string): HomeTask | undefined => shown.find((t) => `task:${t.id}` === id);
  const brief = $derived(phoneBrief(scan));
  const more = $derived<Tab[]>([
    ...(brief ? [{ id: "brief", view: "brief", name: "Morning brief", needs: 0, live: false } as Tab] : []),
    ...shown.map((t): Tab => ({ id: `task:${t.id}`, view: t.view as ViewId, name: t.name, needs: t.needs, live: t.state === "live" })),
  ]);
  const all = $derived(tabsFor({ blank: !home.chat, needs, more }));
  // The focus rules, ready marks and done folding (item 872): the Mac's own (`focus.ts`), kept in the phone's storage.
  // svelte-ignore state_referenced_locally
  const fk = bag("stage:focus", { follow: true, split: false, primed: false, ready: [] as string[], seen: {} as Record<string, number>, doneSeen: {} as Record<string, number>, folded: [] as string[] });
  const row = $derived(all.filter((t) => !fk.folded.includes(t.id)));
  // Chat is not a view on the phone: its tab opens Home's chat screen, so focus never rests on it.
  const focus = $derived(focusOf(row.filter((t) => t.view !== "chat"), stage.focus));
  const focusTask = $derived(taskOf(focus.id));
  const doing = $derived(focusTask ? (focusTask.state === "live" ? focusTask.doing || def(focusTask.view as ViewId).doing : `Done — ${focusTask.name}`) : def(focus.view).doing);
  $effect(() => {
    watching = focus.view === "watch";
    where = { view: focus.view, task: focusTask?.name ?? "" };
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
    fk.ready = fk.ready.filter((x) => x !== t.id);
    note = null;
    stage.focus = t.id;
  }

  // The rules (focus.ts): a task he asked for takes the screen at once unless he is typing; anything else only with
  // Follow on, after 10 s without his touch, over a lower rank — else its tab says "<View> ready →". A switch the
  // stage makes shows its note (Back / Stay here). Chat never takes focus here (it is a screen of its own).
  let note = $state<FocusKept["note"]>(null);
  let lastTouch = Date.now();
  let rootEl = $state<HTMLElement | null>(null);
  const asked = (id: string) => !!taskOf(id)?.why;
  const isDone = (id: string) => taskOf(id)?.state === "done";
  const typing = () => !!rootEl && rootEl.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
  function rules() {
    const now = Date.now();
    const views = all.filter((t) => t.view !== "chat");
    // The kept focus as it is (not as drawn): before the tasks are read its tab may not be there yet, and the rules move
    // focus only once they are.
    const r = rulesPass(fk, stage.focus, note, views, { now, lastTouch, busy: typing() }, asked, tasks.loaded);
    if (r.focus !== stage.focus) stage.focus = r.focus;
    note = r.note;
    if (tasks.loaded) foldDone(fk, views, isDone, focusOf(views, stage.focus).id, now, (t) => holdsHim(t, stage.ui[t.id]));
  }
  $effect(() => {
    void all;
    untrack(rules);
  });
  onMount(() => {
    const t = setInterval(() => untrack(rules), 1000);
    const touch = () => (lastTouch = Date.now());
    const evs = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"];
    for (const e of evs) window.addEventListener(e, touch, { passive: true, capture: true });
    return () => {
      clearInterval(t);
      for (const e of evs) window.removeEventListener(e, touch, { capture: true });
    };
  });

  // Home's steps (item 872), in a fold under a task's view: read from `GET /home/steps` when the fold opens, with the
  // tasks every 30 s while it is open, and when the page reads again. Folded by default; kept as he left it.
  // svelte-ignore state_referenced_locally
  const sf = bag("phone:steps", { open: false });
  async function readSteps() {
    if (!sf.open) return;
    try {
      steps = (await client.homeSteps()) as unknown as Ev[];
    } catch {
      // kept as last read; the fold says nothing new
    }
  }
  $effect(() => {
    if (sf.open) untrack(() => void readSteps());
  });
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
    timer = setInterval(() => (void refreshTasks(), void readSteps()), 30_000);
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
      untrack(() => void readSteps());
    }
  });
</script>

<div class="h9-stage phone" class:classic={!fil} class:narrow={width <= 760} class:tiny={width <= 480} bind:clientWidth={width} data-home-stage data-phone-stage bind:this={rootEl}>
  <div class="h9-bar">
    <span class="h9-home"><i class="h9-dot" class:idle={!focusTask || focusTask.state !== "live"} aria-hidden="true"></i>HOME</span>
    <span class="h9-doing">{doing}</span>
    <Btn small on={fk.follow} label="Follow Home" onclick={() => (fk.follow = !fk.follow)}>Follow</Btn>
  </div>
  <div class="h9-tabs" role="tablist" bind:this={tabsEl}>
    {#each row as t (t.id)}
      {@const ready = fk.ready.includes(t.id) && focus.id !== t.id}
      <button class="h9-tab" data-tab={t.id} class:on={focus.id === t.id} class:ready role="tab" aria-selected={focus.id === t.id} onclick={() => pick(t)} aria-label={t.view === "chat" ? "Open Home's chat" : undefined}>
        <Icon name={def(t.view).icon} size={13} /><span class="tn">{t.name}</span>
        {#if t.live}<i class="pulse" class:amber={t.needs > 0}></i>{/if}
        {#if t.needs > 0}<span class="cnt" aria-label="{t.needs} need you">{t.needs}</span>{/if}
        {#if ready}<span class="rdy">{def(t.view).name} ready →</span>{/if}
        {#if focus.id === t.id && taskOf(t.id)}<!-- svelte-ignore a11y_click_events_have_key_events --><span class="h9-x" role="button" tabindex="-1" aria-label="Close this tab" onclick={(e) => (e.stopPropagation(), void close(taskOf(t.id)!))}>×</span>{/if}
      </button>
    {/each}
    {#if fk.folded.length}<button class="h9-tab h9-folded" onclick={() => unfold(fk)}><Icon name="check" size={13} /><span class="tn">{fk.folded.length} done</span></button>{/if}
    <span class="sep"></span>
  </div>
  <!-- Item 894: a failed read of Home's tasks (the Mac not answering) says so; the last rows stay drawn. -->
  {#if tasks.problem}<div class="h9-stale" role="status">{STALE_WORDS}</div>{/if}
  {#if note && row.some((t) => t.id === note?.to)}
    {@const to = row.find((t) => t.id === note?.to)!}
    {@const from = row.find((t) => t.id === note?.from)}
    <div class="h9-note hud-m">
      <span class="hud-head">Switched to {to.name}</span>
      <span class="h9-note-why">{to.needs > 0 ? "It needs you" : asked(to.id) ? "You asked for it" : "Home started it, and you were away from the stage"}</span>
      <span class="h9-note-acts">
        {#if from}<Btn small onclick={() => pick(from)}>Back to {from.name}</Btn>{/if}
        <Btn small onclick={() => ((fk.follow = false), (note = null))}>Stay here</Btn>
      </span>
    </div>
  {/if}
  {#if focus.view !== "watch"}
    <div class="h9-body">
      {#key focus.id}
        <!-- Item 947: each view keeps the place of its own scrolling boxes (the page's own scroll is kept by homeFirst). -->
        <div class="h9-view" use:keepScroll={focus.id}>
          {#if focus.view === "brief" && !focusTask}
            <Brief />
          {:else if focusTask && focusTask.view === "brief"}
            <Brief task={focusTask} />
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
      {#if focusTask}
        <div class="h9-phsteps" data-phone-steps>
          <button class="h9-phsteps-h" aria-expanded={sf.open} onclick={() => (sf.open = !sf.open)}><Icon name={sf.open ? "chev" : "chevr"} size={12} /><span>Home's steps</span>{#if sf.open && steps.length}<span class="h9-dim">· last {Math.min(3, steps.filter((e) => e.event === "user_message").length)} turns</span>{/if}</button>
          {#if sf.open}<div class="h9-phsteps-b"><Steps id={focusTask.id} /></div>{/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
