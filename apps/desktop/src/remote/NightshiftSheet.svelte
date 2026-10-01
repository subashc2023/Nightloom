<script lang="ts">
  /**
   * Nightshift from the phone (item 246 wave 5; blocker 669's default as
   * the wave-3 spec narrows it): the queue in order and each item, the
   * morning pages newest first, the open blockers and his answers, and a
   * new item (a title and what he said). No diffs, no reverts, no launching
   * a shift — those stay on the Mac.
   *
   * Never loses his text (practices §7): a blocker's answer
   * (`BlockerAnswer.svelte`) and a new item are kept in localStorage on
   * every keystroke until Send/Create lands, or a confirmed Discard.
   */
  import { onMount, tick } from "svelte";
  import { renderMarkdown } from "../lib/markdown";
  import { shortWhen, type Client } from "./client";
  import BlockerAnswer from "./BlockerAnswer.svelte";
  import {
    NightshiftClient,
    answerDraftKey,
    discardNeedsConfirm,
    itemDraftKey,
    loadNsDraft,
    morningTitle,
    nsDraftKeys,
    nsProblem,
    saveNsDraft,
    statusTag,
    type NsBlocker,
    type NsBlockerRow,
    type NsItem,
    type NsItemRow,
    type NsMorningRow,
    type NsProject,
  } from "./nightshiftClient";

  interface Props {
    /** The host's client: its token and origin. */
    client: Pick<Client, "token" | "base">;
    /** The host lists `nightshift` in `features`. */
    available: boolean;
    /** `/api/state`'s `host`, for the sentence when it is missing. */
    host?: string | null;
    onnote: (text: string) => void;
    /** The sheet is taller while a page is open. */
    ontall?: (tall: boolean) => void;
  }
  let { client, available, host = null, onnote, ontall }: Props = $props();

  const ns = $derived(new NightshiftClient(client.token, client.base));

  type Tab = "queue" | "blockers" | "mornings";
  type View =
    | { v: "projects" }
    | { v: "home" }
    | { v: "item"; id: string }
    | { v: "blocker"; id: string }
    | { v: "morning"; name: string }
    | { v: "new" };

  let view = $state<View>({ v: "projects" });
  let tab = $state<Tab>("queue");
  let projects = $state<NsProject[] | null>(null);
  let project = $state<NsProject | null>(null);
  let queue = $state<NsItemRow[] | null>(null);
  let blockers = $state<NsBlockerRow[] | null>(null);
  let mornings = $state<NsMorningRow[] | null>(null);
  let item = $state<NsItem | null>(null);
  let blocker = $state<NsBlocker | null>(null);
  let page = $state<string | null>(null);
  let problem = $state<string | null>(null);
  let drafts = $state<string[]>(nsDraftKeys());
  /** The new item's form. */
  let title = $state("");
  let said = $state("");
  let busy = $state(false);
  let confirmDiscard = $state(false);
  let titleBox = $state<HTMLInputElement | null>(null);

  $effect(() => {
    ontall?.(view.v !== "projects" && view.v !== "home");
  });

  async function loadProjects() {
    problem = null;
    if (!available) {
      problem = host === "serve" ? "Nightshift is not on the away server yet." : "No project on this host has Nightshift.";
      return;
    }
    try {
      projects = await ns.projects();
      if (projects.length === 1) void openProject(projects[0]);
    } catch (e) {
      problem = nsProblem(e, host);
    }
  }

  async function openProject(p: NsProject) {
    project = p;
    view = { v: "home" };
    await showTab(p.open_blockers > 0 ? "blockers" : "queue");
  }

  async function showTab(t: Tab) {
    if (!project) return;
    tab = t;
    problem = null;
    drafts = nsDraftKeys();
    const id = project.id;
    try {
      if (t === "queue") queue = (await ns.queue(id)).items;
      else if (t === "blockers") blockers = await ns.blockers(id);
      else mornings = await ns.mornings(id);
    } catch (e) {
      problem = nsProblem(e, host);
    }
  }

  async function openItem(id: string) {
    if (!project) return;
    view = { v: "item", id };
    item = null;
    problem = null;
    try {
      item = await ns.item(project.id, id);
    } catch (e) {
      problem = nsProblem(e, host);
    }
  }

  async function openBlocker(id: string) {
    if (!project) return;
    view = { v: "blocker", id };
    blocker = null;
    problem = null;
    try {
      blocker = await ns.blocker(project.id, id);
    } catch (e) {
      problem = nsProblem(e, host);
    }
  }

  async function openMorning(name: string) {
    if (!project) return;
    view = { v: "morning", name };
    page = null;
    problem = null;
    try {
      page = (await ns.morning(project.id, name)).text;
    } catch (e) {
      problem = nsProblem(e, host);
    }
  }

  function answered(b: NsBlocker) {
    blocker = b;
    onnote(`Blocker ${b.id} answered on the ${host === "serve" ? "away server" : "Mac"}`);
    drafts = nsDraftKeys();
    if (project) project = { ...project, open_blockers: Math.max(0, project.open_blockers - 1) };
  }

  async function beginNew() {
    if (!project) return;
    const kept = loadNsDraft(itemDraftKey(project.id));
    title = kept?.title ?? "";
    said = kept?.text ?? "";
    confirmDiscard = false;
    problem = null;
    view = { v: "new" };
    await tick();
    titleBox?.focus();
  }

  function typedNew() {
    if (project) saveNsDraft(itemDraftKey(project.id), { title, text: said });
  }

  async function create() {
    if (!project || !title.trim() || busy) return;
    busy = true;
    problem = null;
    try {
      const id = await ns.newItem(project.id, title, said);
      // Written on the host: only now does the draft go.
      saveNsDraft(itemDraftKey(project.id), null);
      drafts = nsDraftKeys();
      onnote(`Item ${id} added to the queue`);
      title = "";
      said = "";
      view = { v: "home" };
      await showTab("queue");
    } catch (e) {
      // The draft stays; the sheet says why.
      problem = nsProblem(e, host);
    } finally {
      busy = false;
    }
  }

  function discardNew(force = false) {
    if (!project) return;
    if (discardNeedsConfirm({ title, text: said }) && !force) {
      confirmDiscard = true;
      return;
    }
    saveNsDraft(itemDraftKey(project.id), null);
    drafts = nsDraftKeys();
    title = "";
    said = "";
    confirmDiscard = false;
    view = { v: "home" };
  }

  /** Back one level; a page left keeps its draft (it is on disk already). */
  function back() {
    problem = null;
    confirmDiscard = false;
    if (view.v === "home") {
      project = null;
      view = { v: "projects" };
      void loadProjects();
      return;
    }
    view = { v: "home" };
    void showTab(tab);
  }

  const answerKey = (b: string) => (project ? answerDraftKey(project.id, b) : "");
  const latest = $derived(mornings?.[0]?.name ?? null);

  onMount(() => {
    void loadProjects();
  });
</script>

{#if view.v === "projects"}
  <div class="nz-head"><span class="nz-title">Nightshift</span></div>
  {#if problem}<p class="nz-problem">{problem}</p>{/if}
  {#if available}
    {#if projects === null && !problem}
      <p class="nz-note">Asking…</p>
    {:else if projects}
      <div class="nz-list">
        {#each projects as p (p.id)}
          <button onclick={() => openProject(p)}>
            <span class="nz-grow">
              <span class="nz-name">{p.name}</span>
              <small>{p.items} item{p.items === 1 ? "" : "s"}{p.newest_morning ? ` · last morning ${morningTitle(p.newest_morning)}` : ""}{p.live ? " · shift running" : ""}</small>
            </span>
            {#if p.open_blockers > 0}<span class="nz-badge">{p.open_blockers}</span>{/if}
          </button>
        {:else}
          <p class="nz-empty">No project here has Nightshift.</p>
        {/each}
      </div>
    {/if}
  {/if}
{:else if view.v === "home" && project}
  <div class="nz-head">
    {#if (projects?.length ?? 0) > 1}<button class="nz-link" onclick={back}>‹ Projects</button>{/if}
    <span class="nz-title">{project.name}</span>
    <button class="nz-link" onclick={beginNew}>{drafts.includes(itemDraftKey(project.id)) ? "Add item · draft kept" : "Add item"}</button>
  </div>
  {#if project.live}<p class="nz-note">A shift is running: answers and new items wait until it ends.</p>{/if}
  <div class="nz-seg" role="tablist" aria-label="Nightshift">
    <button role="tab" aria-selected={tab === "queue"} class:on={tab === "queue"} onclick={() => showTab("queue")}>Queue</button>
    <button role="tab" aria-selected={tab === "blockers"} class:on={tab === "blockers"} onclick={() => showTab("blockers")}>
      Blockers{project.open_blockers > 0 ? ` · ${project.open_blockers}` : ""}
    </button>
    <button role="tab" aria-selected={tab === "mornings"} class:on={tab === "mornings"} onclick={() => showTab("mornings")}>Mornings</button>
  </div>
  {#if problem}<p class="nz-problem">{problem}</p>{/if}
  {#if tab === "queue"}
    {#if queue === null && !problem}
      <p class="nz-note">Asking…</p>
    {:else if queue}
      <div class="nz-list">
        {#each queue as it, i (it.id)}
          <button onclick={() => openItem(it.id)}>
            <span class="nz-num">{it.order === null ? "–" : i + 1}</span>
            <span class="nz-grow">
              <span class="nz-name">{it.title}</span>
              <small>{it.id} · {it.kind}</small>
            </span>
            {#if statusTag(it.status)}<span class="nz-tag">{statusTag(it.status)}</span>{/if}
          </button>
        {:else}
          <p class="nz-empty">The queue is empty.</p>
        {/each}
      </div>
    {/if}
  {:else if tab === "blockers"}
    {#if blockers === null && !problem}
      <p class="nz-note">Asking…</p>
    {:else if blockers}
      <div class="nz-list">
        {#each blockers as b (b.id)}
          <button onclick={() => openBlocker(b.id)}>
            <span class="nz-grow">
              <span class="nz-q">{b.question || `Blocker ${b.id}`}</span>
              <small>{drafts.includes(answerKey(b.id)) ? "draft kept · " : ""}{b.id}{b.item ? ` · item ${b.item}` : ""}{b.raised ? ` · ${b.raised}` : ""}</small>
            </span>
          </button>
        {:else}
          <p class="nz-empty">No open blockers.</p>
        {/each}
      </div>
    {/if}
  {:else}
    {#if mornings === null && !problem}
      <p class="nz-note">Asking…</p>
    {:else if mornings}
      <div class="nz-list">
        {#each mornings as m (m.name)}
          <button onclick={() => openMorning(m.name)}>
            <span class="nz-grow">
              <span class="nz-name">{morningTitle(m.name)}</span>
              <small>{m.name === latest ? "latest · " : ""}{shortWhen(m.modified)}</small>
            </span>
          </button>
        {:else}
          <p class="nz-empty">No morning page yet.</p>
        {/each}
      </div>
    {/if}
  {/if}
{:else if view.v === "item"}
  <div class="nz-head"><button class="nz-link" onclick={back}>‹ Queue</button></div>
  {#if problem}<p class="nz-problem">{problem}</p>{/if}
  {#if item === null && !problem}
    <p class="nz-note">Asking…</p>
  {:else if item}
    <div class="nz-title">{item.title}</div>
    <div class="nz-sub">{item.id} · {item.kind} · {item.status || "todo"}{item.created ? ` · ${item.created}` : ""}</div>
    <div class="nz-md">{@html renderMarkdown(item.body)}</div>
  {/if}
{:else if view.v === "blocker"}
  <div class="nz-head"><button class="nz-link" onclick={back}>‹ Blockers</button></div>
  {#if problem}<p class="nz-problem">{problem}</p>{/if}
  {#if blocker === null && !problem}
    <p class="nz-note">Asking…</p>
  {:else if blocker && project}
    <div class="nz-title">Blocker {blocker.id}</div>
    <div class="nz-sub">{blocker.status}{blocker.item ? ` · item ${blocker.item}` : ""}{blocker.raised ? ` · raised ${blocker.raised}` : ""}</div>
    <BlockerAnswer {ns} project={project.id} {blocker} live={project.live} {host} onanswered={answered} />
  {/if}
{:else if view.v === "morning"}
  {@const v = view}
  <div class="nz-head"><button class="nz-link" onclick={back}>‹ Mornings</button></div>
  <div class="nz-title">{morningTitle(v.name)}</div>
  {#if problem}<p class="nz-problem">{problem}</p>{/if}
  {#if page === null && !problem}
    <p class="nz-note">Asking…</p>
  {:else if page !== null}
    <div class="nz-md">{@html renderMarkdown(page)}</div>
  {/if}
{:else if view.v === "new" && project}
  <div class="nz-title">New item in {project.name}</div>
  <input class="nz-input" type="text" placeholder="Title" bind:this={titleBox} bind:value={title} oninput={typedNew} autocapitalize="sentences" />
  <textarea class="nz-box" bind:value={said} oninput={typedNew} placeholder="What you said — kept word for word under “What Swaraag said”"></textarea>
  {#if project.live}<p class="nz-note">A shift is running; the item can be added when it ends. Your draft is kept.</p>{/if}
  {#if problem}<p class="nz-problem">{problem}</p>{/if}
  {#if confirmDiscard}
    <p class="nz-note">Discard this item? The draft is gone after this.</p>
    <div class="nz-actions">
      <span class="nz-grow"></span>
      <button class="nz-btn" onclick={() => (confirmDiscard = false)}>Keep it</button>
      <button class="nz-btn danger" onclick={() => discardNew(true)}>Discard</button>
    </div>
  {:else}
    <div class="nz-actions">
      <button class="nz-btn" onclick={() => discardNew()}>Discard</button>
      <span class="nz-grow"></span>
      <button class="nz-btn accent" disabled={busy || project.live || !title.trim()} onclick={create}>{busy ? "Adding…" : "Add to queue"}</button>
    </div>
  {/if}
{/if}

<style>
  .nz-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
  }
  .nz-head .nz-title {
    flex: 1;
  }
  .nz-title {
    font-weight: 600;
    font-size: 17px;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .nz-sub,
  .nz-note {
    font-size: 13px;
    color: var(--dim);
    margin: -4px 0 0;
    overflow-wrap: anywhere;
  }
  .nz-note {
    margin: 0;
  }
  .nz-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 0;
  }
  .nz-link {
    all: unset;
    cursor: pointer;
    color: var(--accent-ink);
    font-size: 15px;
    padding: 8px 4px;
    white-space: nowrap;
  }
  .nz-seg {
    display: flex;
    background: var(--paper);
    border-radius: 12px;
    padding: 3px;
    gap: 3px;
  }
  .nz-seg button {
    all: unset;
    flex: 1;
    text-align: center;
    min-height: 36px;
    line-height: 36px;
    border-radius: 9px;
    font-size: 14px;
    cursor: pointer;
    color: var(--dim);
  }
  .nz-seg button.on {
    background: var(--well);
    color: var(--ink);
    font-weight: 600;
  }
  .nz-list {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
    flex: none;
  }
  .nz-list > button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 8px 16px;
    box-sizing: border-box;
    cursor: pointer;
  }
  .nz-list > button:active {
    background: var(--well);
  }
  .nz-list > * + * {
    border-top: 1px solid var(--line);
  }
  .nz-grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .nz-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nz-q {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 15px;
    line-height: 1.35;
  }
  .nz-num {
    width: 22px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--dim);
    font-size: 14px;
    flex: none;
  }
  .nz-badge {
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    box-sizing: border-box;
    border-radius: 11px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 13px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .nz-tag {
    font-size: 12px;
    color: var(--dim);
    border: 1px solid var(--line2);
    border-radius: 8px;
    padding: 2px 8px;
    flex: none;
    white-space: nowrap;
  }
  small {
    font-size: 12px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nz-empty {
    font-size: 14px;
    color: var(--dim);
    padding: 14px 16px;
    margin: 0;
  }
  .nz-md {
    font-size: 15px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .nz-md :global(pre) {
    overflow-x: auto;
    background: var(--well);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 13px;
  }
  .nz-md :global(code) {
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .nz-md :global(p),
  .nz-md :global(ul),
  .nz-md :global(ol) {
    margin: 0.5em 0;
  }
  .nz-md :global(h1),
  .nz-md :global(h2),
  .nz-md :global(h3) {
    font-size: 1.05em;
    margin: 0.9em 0 0.3em;
  }
  .nz-md :global(table) {
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .nz-md :global(td),
  .nz-md :global(th) {
    border: 1px solid var(--line);
    padding: 4px 8px;
  }
  .nz-input,
  .nz-box {
    width: 100%;
    box-sizing: border-box;
    background: var(--well);
    color: inherit;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    font-size: 16px; /* under 16px iOS Safari zooms the page on focus */
    outline: none;
  }
  .nz-box {
    min-height: 30dvh;
    resize: none;
    line-height: 1.45;
  }
  .nz-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .nz-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
  }
  .nz-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .nz-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .nz-btn.danger {
    color: var(--failed);
    border-color: color-mix(in srgb, var(--failed) 45%, transparent);
  }
</style>
