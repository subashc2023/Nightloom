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
  import { homeNeedsNow } from "../needsBoard.svelte";
  import Btn from "./Btn.svelte";
  import HandledMenu from "./HandledMenu.svelte";
  import Watch from "./views/Watch.svelte";
  import Brief from "./views/Brief.svelte";
  import Timeline from "./views/Timeline.svelte";
  import Todo from "./views/Todo.svelte";
  import Triage from "./views/Triage.svelte";
  import Browse from "./views/Browse.svelte";
  import Run from "./views/Run.svelte";
  import Research from "./views/Research.svelte";
  import { tasks, refreshTasks, closeTask, STALE_WORDS, type HomeTask } from "./tasks.svelte";
  import { briefOf } from "./brief";
  import { bag, def, keep, stage, type ViewId } from "./stageState.svelte";
  import { rulesPass, foldDone, unfold, holdsHim, secondOf, type FocusKept } from "./focus";
  import { lastExchange, type Ev } from "./steps";
  import { tabsFor, focusOf, type Tab } from "./tabs";
  import { setStageHost, stageHost } from "./host";
  import { keepScroll } from "./keepScroll";
  import { desktopHost } from "./desktopHost";
  import { renderReply } from "../markdown";
  import TurnAskHost from "../TurnAskHost.svelte";
  import { hereAsk } from "../needsBoard.svelte";

  // The views ask the window for what they need (the phone's Home page sets its own host).
  setStageHost(desktopHost);

  let { blank, children }: { blank: boolean; children: Snippet } = $props();

  // Item 995: the one Needs-you number, as the top pill and Watching's line say it.
  const needs = $derived(homeNeedsNow().waiting);
  const brief = $derived(briefOf(app.events as unknown as Ev[], isScanMessage, app.busy));
  // The views a task of Home's may be drawn in.
  // Item 898: "brief" too — a page Home wrote with update_task, drawn by the Brief view.
  const TASK_VIEWS = ["timeline", "todo", "triage", "browse", "run", "research", "brief"];
  const shown = $derived(tasks.rows.filter((t) => TASK_VIEWS.includes(t.view)));
  const taskOf = (id: string): HomeTask | undefined => shown.find((t) => `task:${t.id}` === id);
  // The tabs live work adds: the morning brief once this chat holds a scan (its pulse while Home writes it), and one
  // tab per task Home shows with `update_task` (its pulse while live, its count of what waits on him).
  const more = $derived<Tab[]>([
    ...(brief ? [{ id: "brief", view: "brief", name: brief.writing ? "Writing the morning brief" : "Morning brief", needs: 0, live: brief.writing } as Tab] : []),
    ...shown.map((t): Tab => ({ id: `task:${t.id}`, view: t.view as ViewId, name: t.name, needs: t.needs, live: t.state === "live" })),
  ]);
  const all = $derived(tabsFor({ blank, needs, more }));
  // svelte-ignore state_referenced_locally
  const fk = bag("stage:focus", { follow: true, split: false, primed: false, ready: [] as string[], seen: {} as Record<string, number>, doneSeen: {} as Record<string, number>, folded: [] as string[] });
  // Done tasks he has seen and left fold away by themselves (item 872, focus.ts `foldDone`); "N done" brings them back.
  const row = $derived(all.filter((t) => !fk.folded.includes(t.id)));
  const focus = $derived(focusOf(row, stage.focus));
  // The focus rules (focus.ts; 809 round 6's engine): Follow Home, split, and tabs that wait "ready →". Kept with the
  // stage's state, so a restart neither forgets them nor makes old tabs new. Follow Home and Split are kind A.
  let note = $state<FocusKept["note"]>(null);
  let lastTouch = Date.now();
  let dragging = false;
  let rootEl = $state<HTMLElement | null>(null);
  const asked = (id: string) => !!taskOf(id)?.why;
  // He is mid-typing in a view's own field, or holding a card: a switch would break it.
  const busyHere = () => dragging || (!!rootEl && rootEl.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? ""));
  const isDone = (id: string) => taskOf(id)?.state === "done";
  function rules() {
    // The first read ever primes what is there as seen (no pulse storm) — `rulesPass` (focus.ts), shared with the phone.
    // The rules see every tab, folded ones too, so a tab brought back is not "new".
    const now = Date.now();
    const r = rulesPass(fk, stage.focus, note, all, { now, lastTouch, busy: busyHere() }, asked, tasks.loaded);
    if (r.focus !== stage.focus) stage.focus = r.focus; // a switch the stage makes is instant (see viewIn)
    note = r.note;
    if (tasks.loaded) foldDone(fk, all, isDone, focusOf(all, stage.focus).id, now, (t) => holdsHim(t, stage.ui[t.id]));
  }
  // Item 874: rerun on the row's content, not its identity — `row` is a fresh array whenever `fk.folded` is written,
  // and rules() itself may write it; keyed on identity this looped and froze the window.
  const rowKey = $derived(all.map((t) => `${t.id}:${t.needs}:${t.live ? 1 : 0}:${t.view}`).join("|") + "/" + fk.folded.join("|"));
  $effect(() => {
    void rowKey;
    untrack(rules);
  });
  $effect(() => {
    const t = setInterval(() => untrack(rules), 1000);
    const touch = () => (lastTouch = Date.now());
    const drag = (on: boolean) => () => ((dragging = on), touch());
    const on = drag(true);
    const off = drag(false);
    for (const e of ["pointerdown", "keydown", "wheel"]) window.addEventListener(e, touch, { passive: true, capture: true });
    window.addEventListener("dragstart", on, true);
    window.addEventListener("dragend", off, true);
    return () => {
      clearInterval(t);
      for (const e of ["pointerdown", "keydown", "wheel"]) window.removeEventListener(e, touch, { capture: true });
      window.removeEventListener("dragstart", on, true);
      window.removeEventListener("dragend", off, true);
    };
  });
  const last = $derived(lastExchange(app.events as unknown as Ev[], isScanMessage));
  // Item 991: the strip's reply ends on an <ask> he has not answered — its card (the chat's own) goes under it.
  const asking = $derived(!!last?.home && !app.busy && !!hereAsk());
  const focusTask = $derived(taskOf(focus.id));
  // 846 §7 step 3: the view in focus is written down (a small file, no model) so his next message to Home carries
  // where he was — the header rides on the wire only. Every change of focus, his or the stage's.
  // Written when the view or task changes (not on every re-read of the tasks — 845 review, (f)), and again each
  // minute while the stage shows (below), so a long stay on one view still counts as fresh.
  let focusSent = "";
  const sendFocus = (v: string, t: string) => {
    focusSent = `${v}\u0000${t}`;
    void stageHost.now.focus(v, t).catch(() => {});
  };
  $effect(() => {
    const v = focus.view;
    const t = focusTask?.name ?? "";
    untrack(() => {
      if (`${v}\u0000${t}` !== focusSent) sendFocus(v, t);
    });
  });
  const doing = $derived(focusTask ? (focusTask.state === "live" ? focusTask.doing || def(focusTask.view as ViewId).doing : `Done — ${focusTask.name}`) : focus.view === "brief" ? (brief?.writing ? "Writing your morning brief" : def("brief").doing) : app.busy && focus.view !== "chat" ? "Working on what you sent" : def(focus.view).doing);
  const chips: Record<string, HTMLElement> = $state({});
  // The view's width in CSS px (the body less the view's 14 px insets) — what .narrow and .tiny are set from, since
  // WebKit reads a container query at width × the page zoom (stage.css, fold.ts).
  let bodyW = $state(1200);
  const viewW = $derived(bodyW - 28);
  // Split needs room for two views (each at least ~540 px); on a narrower stage it is off without forgetting his choice.
  const roomy = $derived(viewW >= 1090);
  const second = $derived(roomy ? secondOf({ focus: focus.id, split: fk.split } as FocusKept, row) : undefined);
  // Item 874: whether there is anything to split with (a task tab besides the one in focus).
  const canSplit = $derived(!!secondOf({ focus: focus.id, split: true } as FocusKept, row));
  const secondTask = $derived(second ? taskOf(second.id) : undefined);
  // What .narrow and .tiny are set from: one view's width (half the stage when split).
  const oneW = $derived(secondTask ? (viewW - 10) / 2 : viewW);
  // Item 874: the view's height (the body less its 10 px insets). A short view (a 600 px window with the reply strip
  // open) cannot fit a column's two panels at their floors — Watch's Needs you shrank to a line and Handled ran under
  // the strip — so .short lets such a column scroll as a whole, each panel at its own height (stage.css).
  let bodyH = $state(800);
  const short = $derived(bodyH - 20 < 400);

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
    const t = setInterval(() => (read(), void refreshTasks(), untrack(() => sendFocus(focus.view, focusTask?.name ?? ""))), 60_000);
    return () => clearInterval(t);
  });
  // The tasks are re-read when the chat moves (a step landed — `update_task` may have written) and when a turn ends —
  // at most once a second while a reply streams (845 review, (f): a read per streamed event was hundreds a turn).
  let soon: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    void app.events.length;
    void app.busy;
    untrack(() => {
      if (soon) return;
      soon = setTimeout(() => {
        soon = null;
        void refreshTasks();
      }, 1000);
    });
  });
  $effect(() => () => {
    if (soon) clearTimeout(soon);
    soon = null;
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
    fk.ready = fk.ready.filter((x) => x !== id);
    note = null;
    stage.focus = id;
    setTimeout(() => (picked = false), 0);
  }
  async function close(t: HomeTask) {
    if (focus.id === `task:${t.id}`) pick("watch");
    await closeTask(t.id);
  }
</script>

<div class="h9-stage real" class:classic={classic()} class:blank class:narrow={oneW <= 760} class:tiny={oneW <= 480} class:short data-home-stage bind:this={rootEl}>
  <div class="h9-bar">
    <span class="h9-home"><i class="h9-dot" class:idle={!app.busy} aria-hidden="true"></i>HOME</span>
    {#key doing}<span class="h9-doing h9-stagein">{doing}</span>{/key}
    <span class="h9-grow"></span>
    <button class="ns-switch" class:on={fk.follow} aria-pressed={fk.follow} onclick={() => (fk.follow = !fk.follow)} use:tip={"Focus follows Home's tasks\nOnly after 10 s without your touch"}><i></i>Follow Home</button>
    <!-- Item 874: Split needs a second task to put beside this one; dimmed, and saying so, until there is one. -->
    {#if roomy}<Btn small icon="cols" on={fk.split && canSplit} waits={!canSplit} tip={canSplit ? "Two live tasks side by side\nThe newest beside the one in focus" : "Needs a second task\nSplit wakes once Home starts one"} onclick={() => (fk.split = !fk.split)}>Split</Btn>{/if}
    {#if home.info?.scan_words}<span class="h9-ms ns-mono" use:tip={"The morning scan's schedule\nChange it in Settings → Home"}>scan {home.info.scan_words.toLowerCase()}</span>{/if}
    <!-- Item 946: Handled — the feed as a notification list, behind one button in the bar's corner. -->
    <HandledMenu />
  </div>
  <div class="h9-tabs" role="tablist">
    {#each row as t (t.id)}
      {@const ready = fk.ready.includes(t.id) && focus.id !== t.id}
      <button class="h9-tab" class:on={focus.id === t.id} class:ready class:two={second?.id === t.id} role="tab" aria-selected={focus.id === t.id} bind:this={chips[t.id]} onclick={() => pick(t.id)} use:tip={`${t.name}\n${t.needs > 0 ? `${t.needs} need${t.needs === 1 ? "s" : ""} you` : `${def(t.view).name} view`}`}>
        <Icon name={def(t.view).icon} size={13} /><span class="tn">{t.name}</span>
        {#if t.live}<i class="pulse" class:amber={t.needs > 0}></i>{/if}
        {#if t.needs > 0}<span class="cnt" aria-label="{t.needs} need you">{t.needs}</span>{/if}
        {#if ready}<span class="rdy">{def(t.view).name} ready →</span>{/if}
        {#if focus.id === t.id && taskOf(t.id)}<!-- svelte-ignore a11y_click_events_have_key_events --><span class="h9-x" role="button" tabindex="-1" aria-label="Close this tab" use:tip={"Close this tab\nHome's work goes on; only the tab goes"} onclick={(e) => (e.stopPropagation(), void close(taskOf(t.id)!))}>×</span>{/if}
      </button>
    {/each}
    {#if fk.folded.length}<button class="h9-tab h9-folded" onclick={() => unfold(fk)} use:tip={"Done tasks you have seen\nShown again until you look and leave"}><Icon name="check" size={13} /><span class="tn">{fk.folded.length} done</span></button>{/if}
    <span class="sep"></span>
  </div>
  {#snippet taskView(t: HomeTask)}
    {#if t.view === "timeline"}<Timeline task={t} />
    {:else if t.view === "todo"}<Todo task={t} />
    {:else if t.view === "triage"}<Triage task={t} />
    {:else if t.view === "browse"}<Browse task={t} />
    {:else if t.view === "run"}<Run task={t} />
    {:else if t.view === "research"}<Research task={t} />
    {:else if t.view === "brief"}<Brief task={t} />{/if}
  {/snippet}
  <div class="h9-body" class:split={!!secondTask} bind:clientWidth={bodyW} bind:clientHeight={bodyH}>
    {#key focus.id}
      <div class="h9-view" class:chatview={focus.view === "chat"} use:keepScroll={focus.view === "chat" ? "" : focus.id} in:viewIn|global={{ anchor: chips[focus.id] }} out:viewOut|global>
        {#if focus.view === "chat"}
          <div class="h9-chat">{@render children()}</div>
        {:else if focus.view === "brief" && !focusTask}
          <Brief />
        {:else if focusTask && TASK_VIEWS.includes(focusTask.view)}
          {@render taskView(focusTask)}
        {:else}
          <Watch />
        {/if}
      </div>
    {/key}
    {#if secondTask}
      {#key secondTask.id}
        <div class="h9-view second" use:keepScroll={secondTask.id}>{@render taskView(secondTask)}</div>
      {/key}
    {/if}
    <!-- Item 894: a failed read of Home's tasks says so; the last rows stay drawn. -->
    {#if tasks.problem}<div class="h9-stale over" role="status">{STALE_WORDS}</div>{/if}
    {#if note && row.some((t) => t.id === note?.to)}
      {@const to = row.find((t) => t.id === note?.to)!}
      {@const from = row.find((t) => t.id === note?.from)}
      <div class="h9-note hud-m">
        <span class="hud-head">Switched to {to.name}</span>
        <span class="h9-note-why">{to.needs > 0 ? "It needs you" : asked(to.id) ? "You asked for it" : "Home started it, and you were away from the stage"}</span>
        <span class="h9-note-acts">
          {#if from}<Btn small onclick={() => pick(from.id)}>Back to {from.name}</Btn>{/if}
          <Btn small onclick={() => ((fk.follow = false), (note = null))}>Stay here</Btn>
        </span>
      </div>
    {/if}
  </div>
  {#if last && stage.strip === "open" && focus.view !== "chat"}
    {#key last.at}
      <div class="h9-strip">
        <div class="h9-strip-b">
          <span class="h9-him"><b>YOU</b>{last.him}</span>
          <!-- Item 991: Home's reply is the chat's markdown, drawn as the chat draws it (renderReply: lists, bold, a
               hand-off card, an <ask> block's question box); its question card sits under it while it waits on him. -->
          {#if last.home}<div class="h9-said"><div class="h9-said-tx md-block">{@html renderReply(last.home)}</div></div>
          {:else if app.busy}<div class="h9-said"><span class="h9-said-th live">Home is working on it…</span></div>{/if}
          {#if asking}<div class="h9-said-ask"><TurnAskHost /></div>{/if}
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
  /* Item 991: a strip holding a question card is as tall as the card needs (up to half the stage). */
  .h9-strip:has(.h9-said-ask) { max-height: min(50vh, 420px); }
  .h9-said-ask { margin: 6px 0 4px; }
  /* Classic: the rules shared with the phone's stage are in stage.css (845 batch 3). */
  .h9-stage.classic .h9-home { letter-spacing: 0.08em; }
  .h9-stage.classic .h9-view.chatview { box-shadow: none; }
</style>
