<script lang="ts">
  /**
   * The phone page (nightshift backlog 091, Shape B; redesigned in item 246
   * toward the Claude app): a top bar (menu, the chat's title, new chat), a
   * drawer of projects and their chats, the transcript with the live turn
   * folded from the event stream, a pinned composer that grows, sheets for
   * a chat's actions and for the new chat's project, the three approval
   * cards, and a queue for messages typed while the Mac is unreachable.
   * Served by the listener in the desktop process at the Mac's tailnet
   * address; added to the home screen.
   *
   * First screen (item 246, blocker 576's default; before it blocker 174's
   * chat list): the chat the Mac has open — what the Mac is on — with the
   * list one tap away in the drawer; with no chat open, a new chat.
   */
  import { onMount, tick } from "svelte";
  import { fade, fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import {
    ApiError,
    Client,
    KEEP_PLANNING,
    Unreachable,
    backoffMs,
    cardKind,
    draftKey,
    emptyTurn,
    foldTurnEvent,
    loadDraft,
    loadQueue,
    loadToken,
    newQueued,
    questionAnswer,
    saveDraft,
    saveQueue,
    saveToken,
    shortWhen,
    tokenFromHash,
    transcriptRows,
    type ChatRow,
    type LiveTurn,
    type ProjectRow,
    type Queued,
    type RemoteState,
    type ToolRow,
  } from "./client";
  import { renderMarkdown } from "../lib/markdown";
  import { arrive, launch, reducedMotion } from "../lib/sendMotion";
  import type { ApprovalRequest, AskQuestion, SessionEvent, TurnEvent } from "../lib/types";

  // ---- the token and the connection --------------------------------------
  let token = $state<string | null>(null);
  let box = $state<HTMLTextAreaElement | null>(null);
  let paste = $state("");
  let client = $state<Client | null>(null);
  /** `online` while the event stream is open; `off` after the listener
   *  answered 401 (the token is wrong — a new scan is the way back). */
  let link = $state<"connecting" | "online" | "offline" | "off">("connecting");
  let failures = 0;
  let abort: AbortController | null = null;

  // ---- what the Mac says ---------------------------------------------------
  let remote = $state<RemoteState>({ project: null, active_chat: null, busy: false, connected: false, engine: null, pending: [] });
  let projects = $state<ProjectRow[]>([]);
  /** Chats by project id; `""` is the open project's when the Mac has
   *  none (its unfiled chats). */
  let chatsBy = $state<Record<string, ChatRow[]>>({});
  let expanded = $state<Record<string, boolean>>({});

  // ---- what the phone shows -------------------------------------------------
  /** The chat on screen, or `null` for a new chat. */
  let chatId = $state<string | null>(null);
  /** The project of the chat on screen when it is not the one open on the
   *  Mac (read-only here: sending would switch his desktop's project). */
  let chatProject = $state<string | null>(null);
  /** The project a new chat starts in; `null` is the Mac's open project. */
  let newProject = $state<string | null>(null);
  /** A new chat was sent and the Mac has not yet named its id. */
  let pendingNew = $state<{ before: string | null } | null>(null);
  /** Set once he picks a screen, so the first state read does not move him. */
  let chose = false;
  let events = $state<SessionEvent[]>([]);
  let live = $state<LiveTurn | null>(null);
  let toast = $state<string | null>(null);
  let error = $state<string | null>(null);
  let draft = $state("");
  let queue = $state<Queued[]>(loadQueue());
  let scroller = $state<HTMLElement | null>(null);
  /** Rows at or past this index arrived while he watched and rise in. */
  let enterFrom = $state(0);
  let drawer = $state(false);
  let search = $state("");
  let sheet = $state<null | "chat" | "rename" | "project">(null);
  let renameText = $state("");
  let openTools = $state<Record<string, boolean>>({});

  const activePid = $derived(projects.find((p) => p.active)?.id ?? "");
  const rows = $derived(transcriptRows(events));
  const currentChat = $derived.by(() => {
    if (!chatId) return null;
    const list = chatsBy[chatProject ?? activePid] ?? [];
    return list.find((c) => c.id === chatId) ?? null;
  });
  const title = $derived(chatId ? (currentChat?.label ?? "Chat") : "New chat");
  const projectName = (pid: string | null) =>
    pid === null || pid === activePid ? (remote.project ?? "Unfiled") : (projects.find((p) => p.id === pid)?.name ?? "project");
  const readOnly = $derived(chatProject !== null && chatProject !== activePid);
  /** The live turn belongs to the desktop's running (or open) chat; another
   *  chat's view shows nothing live and re-reads when the turn ends. */
  const liveHere = $derived(
    live !== null && !readOnly && ((chatId !== null && chatId === remote.active_chat) || (chatId === null && pendingNew !== null)),
  );
  const pendingHere = $derived(!readOnly && chatId !== null && chatId === remote.active_chat ? remote.pending : []);
  const busyHere = $derived(remote.busy && !readOnly && chatId !== null && chatId === remote.active_chat);
  const status = $derived(
    link === "off"
      ? "not paired"
      : link !== "online"
        ? "Mac unreachable"
        : remote.busy
          ? busyHere || pendingNew
            ? "working…"
            : "busy in another chat"
          : remote.connected
            ? "connected"
            : "no engine on the Mac",
  );

  function note(text: string) {
    toast = text;
    setTimeout(() => {
      if (toast === text) toast = null;
    }, 4000);
  }

  /** A wrong token ends the link; an unreachable Mac marks it offline; any
   *  other failure shows its sentence — unless `quiet`, for the background
   *  reads, whose failure the offline bar already says. */
  function fail(e: unknown, quiet = false) {
    if (e instanceof ApiError && e.status === 401) {
      link = "off";
      error = e.message;
      return;
    }
    if (e instanceof Unreachable) {
      if (link !== "off") link = "offline";
      return;
    }
    if (!quiet) error = String(e instanceof Error ? e.message : e);
  }

  async function refreshState() {
    if (!client) return;
    try {
      const was = remote.busy;
      remote = await client.state();
      // A new chat's id is the Mac's once its log exists (item 246).
      if (pendingNew && remote.active_chat && remote.active_chat !== pendingNew.before && chatId === null) {
        const id = remote.active_chat;
        const typed = draft;
        pendingNew = null;
        chatId = id;
        chatProject = null;
        // What he typed while it started stays his, under the new chat.
        if (typed.trim()) saveDraft(draftKey(id, null), typed);
        saveDraft(draftKey(null, newProject), "");
        await refreshChats();
      }
      if (was && !remote.busy) await turnEnded();
    } catch (e) {
      fail(e, true);
    }
  }

  async function refreshProjects() {
    if (!client) return;
    try {
      projects = await client.projects();
    } catch (e) {
      // A listener from before item 246 has no /projects: the drawer shows
      // the open project alone.
      if (!(e instanceof ApiError && e.status === 404)) fail(e, true);
    }
  }

  async function refreshChats() {
    if (!client) return;
    try {
      chatsBy = { ...chatsBy, [activePid]: await client.chats() };
      for (const p of projects) if (!p.active && expanded[p.id]) void loadProject(p.id);
    } catch (e) {
      fail(e, true);
    }
  }

  async function loadProject(pid: string) {
    if (!client) return;
    try {
      chatsBy = { ...chatsBy, [pid]: await client.chats(pid) };
    } catch (e) {
      fail(e, true);
    }
  }

  async function refreshTranscript(stick = false) {
    if (!client || !chatId) return;
    const id = chatId;
    try {
      const got = await client.transcript(id, readOnly ? chatProject : null);
      if (id !== chatId) return;
      const near = nearBottom();
      events = got;
      enterFrom = transcriptRows(got).length;
      // Only follow the end when he was already there (A12): a re-read
      // while he reads higher up leaves him where he is.
      if (stick || near) scrollToEnd();
    } catch (e) {
      fail(e, true);
    }
  }

  /** The turn is over: the log on disk is whole, the live fold can go, and
   *  anything held in the queue can leave. */
  async function turnEnded() {
    live = null;
    await refreshTranscript();
    await refreshChats();
    await drainQueue();
  }

  async function everything() {
    await refreshState();
    await refreshProjects();
    await refreshChats();
    if (!chose && chatId === null && !pendingNew && remote.active_chat) {
      // The first screen: the chat the Mac is on (blocker 576's default).
      chatId = remote.active_chat;
      draft = loadDraft(draftKey(chatId, null));
      await refreshTranscript(true);
      void grow();
      return;
    }
    if (chatId) await refreshTranscript();
    await drainQueue();
  }

  // ---- the event stream -----------------------------------------------------
  function onEvent(name: string, data: string) {
    switch (name) {
      case "hello":
        link = "online";
        failures = 0;
        void everything();
        break;
      case "turn-event": {
        let ev: TurnEvent;
        try {
          ev = JSON.parse(data);
        } catch {
          return;
        }
        // A turn is running: mark it before the next state poll does.
        if (!remote.busy) remote = { ...remote, busy: true };
        const near = nearBottom();
        live = foldTurnEvent(live ?? emptyTurn(), ev);
        if (near) scrollToEnd();
        break;
      }
      case "tool-approval": {
        try {
          const req: ApprovalRequest = JSON.parse(data);
          if (!remote.pending.some((p) => p.id === req.id)) remote = { ...remote, pending: [...remote.pending, req] };
        } catch {
          // A payload the phone cannot read is one it cannot answer.
        }
        break;
      }
      case "turn-notice":
        try {
          note(JSON.parse(data));
        } catch {
          note(data);
        }
        break;
      case "lagged":
        void everything();
        break;
      default:
        break;
    }
  }

  // A function, not the variable: `fail` sets `link` from under the loop,
  // and a direct read after the assignment is narrowed past that.
  const tokenRefused = () => link === "off";

  async function streamLoop() {
    for (;;) {
      if (!client || tokenRefused()) return;
      abort = new AbortController();
      link = failures === 0 ? "connecting" : "offline";
      try {
        await client.events(onEvent, abort.signal);
        // The stream ended cleanly: the listener went off. Try again.
      } catch (e) {
        fail(e, true);
      }
      if (tokenRefused()) return;
      failures += 1;
      link = "offline";
      await new Promise((r) => setTimeout(r, backoffMs(failures)));
    }
  }

  /** While a turn runs the stream carries no "done": the state is polled
   *  every three seconds and the flip of `busy` is the end. */
  function pollLoop() {
    setInterval(() => {
      if (link === "online" && (remote.busy || live !== null || queue.length > 0 || pendingNew)) void refreshState();
    }, 3000);
  }

  function start(t: string) {
    token = t;
    saveToken(t);
    client = new Client(t);
    error = null;
    failures = 0;
    void streamLoop();
  }

  function forget() {
    abort?.abort();
    token = null;
    client = null;
    saveToken(null);
    link = "connecting";
    error = null;
  }

  onMount(() => {
    const fromHash = tokenFromHash(location.hash);
    if (fromHash) {
      // Off the address bar the moment it is read: a token in the history
      // is a token in a screenshot.
      history.replaceState(null, "", location.pathname + location.search);
      start(fromHash);
    } else {
      const stored = loadToken();
      if (stored) start(stored);
    }
    pollLoop();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && client && link !== "off") void everything();
    });
  });

  // ---- the screens ----------------------------------------------------------
  /** Show `id` (of `project` when it is not the Mac's open one). */
  async function openChat(id: string, project: string | null = null) {
    chose = true;
    drawer = false;
    if (id === chatId && project === chatProject) return;
    chatId = id;
    chatProject = project && project !== activePid ? project : null;
    pendingNew = null;
    events = [];
    enterFrom = 0;
    draft = loadDraft(draftKey(id, null));
    void grow();
    await refreshTranscript(true);
  }

  function startNew(project: string | null = null) {
    chose = true;
    drawer = false;
    sheet = null;
    chatId = null;
    chatProject = null;
    newProject = project && project !== activePid ? project : null;
    pendingNew = null;
    live = null;
    events = [];
    enterFrom = 0;
    draft = loadDraft(draftKey(null, newProject));
    void grow();
    requestAnimationFrame(() => box?.focus());
  }

  function toggleProject(pid: string) {
    expanded = { ...expanded, [pid]: !expanded[pid] };
    if (expanded[pid] && !chatsBy[pid]) void loadProject(pid);
  }

  function openDrawer() {
    drawer = true;
    void refreshProjects();
    void refreshChats();
  }

  function nearBottom(): boolean {
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }

  /** After the DOM has the new rows (a tick, not a frame: a page in the
   *  background gets no frames, and it should still land at the end). */
  function scrollToEnd() {
    void tick().then(() => {
      if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
    });
  }

  /** The composer grows with its text to 40 % of the screen, then scrolls. */
  async function grow() {
    await tick();
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  function typed() {
    saveDraft(draftKey(chatId, chatId ? null : newProject), draft);
    void grow();
  }

  function setDraft(text: string) {
    draft = text;
    typed();
  }

  // ---- send, the queue, stop ------------------------------------------------
  async function sendNow() {
    const text = draft.trim();
    if (!text || readOnly) return;
    if (chatId === null) {
      await sendNew(text);
      return;
    }
    setDraft("");
    if (link !== "online" || remote.busy) {
      hold(text);
      return;
    }
    try {
      const status = await client!.send(chatId, text);
      remote = { ...remote, busy: true };
      if (status === "queued") {
        // The Mac has it behind the running turn (backlog 132): it lands
        // in the transcript when its own turn runs, so nothing is drawn
        // yet — a row drawn now would vanish on the re-read.
        note("The Mac is mid-turn — your message goes when it ends");
        return;
      }
      live = emptyTurn();
      // It flies up from the box (backlog 194); the box's words are gone
      // already, but it has not moved.
      launch("phone", box);
      // Drawn at once rather than after the log's re-read: his message is
      // the one thing on the page he already knows the text of.
      events = [...events, { event: "user_message", text, at: new Date().toISOString() }];
      scrollToEnd();
    } catch (e) {
      if (e instanceof Unreachable) hold(text);
      else {
        // A refusal (409, 401, a 5xx) is not a hold: the text goes back
        // into the composer rather than nowhere, so nothing typed is lost.
        fail(e);
        if (!draft) setDraft(text);
      }
    }
  }

  /** A new chat (item 246): the Mac opens the project, starts the chat and
   *  sends the first message. Nothing is held for a new chat — his text
   *  stays in the composer until the Mac can take it. */
  async function sendNew(text: string) {
    if (link !== "online") {
      note("The Mac is unreachable — your message stays here");
      return;
    }
    if (remote.busy) {
      note("The Mac is running a turn — start the new chat when it ends");
      return;
    }
    const before = remote.active_chat;
    try {
      const status = await client!.newChat(newProject, text);
      pendingNew = { before };
      setDraft("");
      remote = { ...remote, busy: true };
      if (status === "queued") return;
      live = emptyTurn();
      launch("phone", box);
      events = [{ event: "user_message", text, at: new Date().toISOString() }];
      scrollToEnd();
    } catch (e) {
      fail(e);
    }
  }

  function hold(text: string) {
    queue = [...queue, newQueued(chatId, text)];
    saveQueue(queue);
    note(link === "online" ? "Held — goes when the turn ends" : "Held — goes when the Mac is reachable");
  }

  function takeBack(id: string) {
    const q = queue.find((m) => m.id === id);
    queue = queue.filter((m) => m.id !== id);
    saveQueue(queue);
    if (q && !draft) setDraft(q.text);
  }

  /** The oldest held message goes when the Mac is reachable and idle; the
   *  next waits for that turn's end. */
  async function drainQueue() {
    if (!client || link !== "online" || remote.busy || queue.length === 0) return;
    const [next, ...rest] = queue;
    try {
      const status = await client.send(next.chat, next.text);
      queue = rest;
      saveQueue(queue);
      remote = { ...remote, busy: true };
      if (status === "queued") {
        note("The Mac is mid-turn — the held message goes when it ends");
        return;
      }
      if (next.chat === chatId) {
        live = emptyTurn();
        events = [...events, { event: "user_message", text: next.text, at: new Date().toISOString() }];
        scrollToEnd();
      }
    } catch (e) {
      fail(e);
    }
  }

  async function stop() {
    if (!client) return;
    sheet = null;
    try {
      // The chat this page shows (backlog 159, A3), not the Mac's screen.
      await client.cancel(chatId);
      remote = { ...remote, pending: [] };
    } catch (e) {
      fail(e);
    }
  }

  // ---- the chat's actions ------------------------------------------------------
  function beginRename() {
    renameText = currentChat?.label ?? "";
    sheet = "rename";
  }

  async function saveRename() {
    const t = renameText.trim();
    if (!client || !chatId || !t) return;
    try {
      await client.rename(chatId, t);
      sheet = null;
      note("Renamed");
      await refreshChats();
    } catch (e) {
      // The sheet stays open with his text in it.
      fail(e);
    }
  }

  async function openOnMac() {
    if (!client || !chatId) return;
    sheet = null;
    try {
      await client.open(chatId);
      note("Opened on the Mac");
    } catch (e) {
      fail(e);
    }
  }

  function chooseProject(pid: string) {
    const was = draft;
    newProject = pid === activePid ? null : pid;
    sheet = null;
    // The text typed before the switch travels with him to the new project.
    draft = loadDraft(draftKey(null, newProject)) || was;
    typed();
  }

  // ---- the cards --------------------------------------------------------------
  let notes = $state<Record<string, string>>({});
  let picks = $state<Record<string, Record<number, string[]>>>({});
  let others = $state<Record<string, Record<number, string>>>({});
  let planThen = $state<Record<string, "ask" | "auto">>({});

  async function answer(
    req: ApprovalRequest,
    decision: "allow" | "always" | "deny",
    answerPayload?: unknown,
    then?: "ask" | "auto",
    fallback?: string,
  ) {
    if (!client) return;
    const text = (notes[req.id] ?? "").trim();
    // The note rides as the deny reason; with an accepting button it is
    // the next message, as the desktop's card does it (`routeNote`).
    const reason = decision === "deny" ? text || fallback : undefined;
    remote = { ...remote, pending: remote.pending.filter((p) => p.id !== req.id) };
    try {
      await client.approve({ id: req.id, name: req.name, decision, reason, answer: answerPayload, then });
      if (decision !== "deny" && text) hold(text);
    } catch (e) {
      fail(e);
    }
  }

  function questions(req: ApprovalRequest): AskQuestion[] {
    const q = (req.input as { questions?: unknown } | null)?.questions;
    return Array.isArray(q) ? (q as AskQuestion[]) : [];
  }

  function toggle(id: string, i: number, label: string, multi: boolean) {
    const mine = picks[id] ?? {};
    const cur = mine[i] ?? [];
    mine[i] = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
    picks = { ...picks, [id]: mine };
  }

  function answered(req: ApprovalRequest): boolean {
    const qs = questions(req);
    return qs.length > 0 && qs.every((_, i) => (picks[req.id]?.[i]?.length ?? 0) > 0 || (others[req.id]?.[i] ?? "").trim() !== "");
  }

  function planOf(req: ApprovalRequest): string | null {
    const p = (req.input as { plan?: unknown } | null)?.plan;
    return typeof p === "string" ? p : null;
  }

  function fields(input: unknown): { key: string; value: string }[] {
    if (input === null || typeof input !== "object") return [];
    return Object.entries(input as Record<string, unknown>).map(([key, v]) => ({
      key,
      value: typeof v === "string" ? v : JSON.stringify(v, null, 1),
    }));
  }

  const matches = (c: ChatRow) => !search.trim() || c.label.toLowerCase().includes(search.trim().toLowerCase());
  const motion = (ms: number) => (reducedMotion() ? 0 : ms);
  /** Reduced motion, read once: no rise on arriving rows either. */
  const still = reducedMotion();
  const toolCount = (tools: ToolRow[]): number => tools.reduce((n, t) => n + 1 + toolCount(t.children), 0);
</script>

{#snippet icon(name: "menu" | "new" | "more" | "up" | "stop" | "chev" | "x" | "search" | "check" | "mac" | "pencil")}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
    {#if name === "menu"}<path d="M4 7h16M4 12h16M4 17h10" />
    {:else if name === "new"}<path d="M12 20h8M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    {:else if name === "more"}<circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" />
    {:else if name === "up"}<path d="M12 19V5M5 12l7-7 7 7" />
    {:else if name === "stop"}<rect x="7" y="7" width="10" height="10" rx="2" />
    {:else if name === "chev"}<path d="m9 6 6 6-6 6" />
    {:else if name === "x"}<path d="M6 6l12 12M18 6 6 18" />
    {:else if name === "search"}<circle cx="11" cy="11" r="6" /><path d="m20 20-4.3-4.3" />
    {:else if name === "check"}<path d="m5 12 5 5 9-10" />
    {:else if name === "mac"}<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />
    {:else if name === "pencil"}<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    {/if}
  </svg>
{/snippet}

{#snippet toolRows(tools: ToolRow[], depth: number)}
  {#each tools as t (t.id)}
    <div class="tool" style:padding-left="{depth * 14}px">
      <span class="tool-dot" class:ok={t.ok === true} class:bad={t.ok === false} class:run={t.ok === null}></span>
      <span class="tool-name">{t.name}</span>
      <span class="tool-sum">{t.summary}</span>
    </div>
    {#if t.children.length > 0}{@render toolRows(t.children, depth + 1)}{/if}
  {/each}
{/snippet}

{#snippet toolBox(tools: ToolRow[], key: string, running: boolean)}
  {@const n = toolCount(tools)}
  {#if n <= 3 || openTools[key]}
    <div class="tools">
      {@render toolRows(tools, 0)}
      {#if n > 3}<button class="tools-toggle" onclick={() => (openTools = { ...openTools, [key]: false })}>Hide steps</button>{/if}
    </div>
  {:else}
    <button class="tools tools-folded" onclick={() => (openTools = { ...openTools, [key]: true })}>
      <span class="tool-dot" class:run={running} class:ok={!running}></span>
      <span>{running ? "Working" : "Used"} · {n} steps</span>
      <span class="spacer"></span>
      {@render icon("chev")}
    </button>
  {/if}
{/snippet}

<div class="page">
  {#if !token}
    <div class="gate">
      <div class="gate-mark">N</div>
      <h1>Nightloom</h1>
      <p>Open the link from <b>Settings → Remote</b> on the Mac — scan its QR code with the camera — or paste the token here.</p>
      <input type="text" placeholder="Token" bind:value={paste} autocapitalize="off" autocomplete="off" spellcheck="false" />
      <button class="btn accent wide" disabled={!/^[0-9a-fA-F]{16,128}$/.test(paste.trim())} onclick={() => start(paste.trim().toLowerCase())}>
        Connect
      </button>
    </div>
  {:else}
    <header class="top">
      <button class="icon-btn" onclick={openDrawer} aria-label="Chats and projects">{@render icon("menu")}</button>
      <button class="title-btn" onclick={() => (chatId ? (sheet = "chat") : (sheet = "project"))} aria-label={chatId ? "Chat actions" : "Choose the project"}>
        <span class="title">{title}</span>
        <span class="sub">
          <span class="dot" class:ok={link === "online" && !remote.busy} class:run={link === "online" && remote.busy} class:bad={link !== "online"}></span>
          {chatId ? projectName(chatProject) : projectName(newProject)} · {status}
        </span>
      </button>
      {#if chatId}
        <button class="icon-btn" onclick={() => (sheet = "chat")} aria-label="Chat actions">{@render icon("more")}</button>
      {/if}
      <button class="icon-btn" onclick={() => startNew(chatProject ?? newProject)} aria-label="New chat">{@render icon("new")}</button>
    </header>

    {#if link === "off"}
      <div class="bar bad" transition:fly={{ y: -12, duration: motion(200) }}>
        <span>{error ?? "The token is wrong."}</span>
        <button class="btn small" onclick={forget}>Scan again</button>
      </div>
    {:else if link === "offline"}
      <div class="bar" transition:fly={{ y: -12, duration: motion(200) }}>
        <span>Can't reach the Mac — is Tailscale on, and Remote switched on? Messages you send are held.</span>
      </div>
    {/if}
    {#if error && link !== "off"}
      <div class="bar bad" transition:fly={{ y: -12, duration: motion(200) }}>
        <span>{error}</span>
        <button class="icon-btn small" onclick={() => (error = null)} aria-label="Dismiss">{@render icon("x")}</button>
      </div>
    {/if}

    <main class="chat" bind:this={scroller}>
      {#if chatId === null && rows.length === 0 && !liveHere}
        <div class="hello" in:fade={{ duration: motion(200) }}>
          <div class="hello-mark">N</div>
          <div class="hello-title">New chat</div>
          <button class="chip" onclick={() => (sheet = "project")}>
            in <b>{projectName(newProject)}</b>
            {@render icon("chev")}
          </button>
          <p class="hello-note">Your first message starts the chat on the Mac.</p>
        </div>
      {/if}
      {#each rows as r, i (i)}
        {#if r.kind === "user"}
          <div class="turn user" class:enter={i >= enterFrom && !still} use:arrive={{ channel: "phone" }}>
            <div class="bubble">{r.text}</div>
            <div class="stamp">{shortWhen(r.at)}</div>
          </div>
        {:else if r.kind === "assistant"}
          <div class="turn reply" class:enter={i >= enterFrom && !still}>
            {#if r.tools.length > 0}{@render toolBox(r.tools, `r${i}`, false)}{/if}
            {#if r.text}<div class="md">{@html renderMarkdown(r.text)}</div>{/if}
          </div>
        {:else}
          <div class="turn note">{r.text}</div>
        {/if}
      {/each}
      {#if liveHere && live}
        <div class="turn reply live" class:enter={!still}>
          {#if live.tools.length > 0}{@render toolBox(live.tools, "live", true)}{/if}
          {#if live.text}<div class="md">{@html renderMarkdown(live.text)}</div>{/if}
          {#if !live.text && live.tools.length === 0}<span class="thinking"><i></i><i></i><i></i></span>{/if}
        </div>
      {:else if busyHere}
        <div class="turn note">A turn is running on the Mac</div>
      {/if}

      {#each pendingHere as req (req.id)}
        {@const kind = cardKind(req)}
        <section class="card" in:fly={{ y: 16, duration: motion(260), easing: cubicOut }}>
          {#if kind === "question"}
            <div class="card-head">The model asks</div>
            {#each questions(req) as q, i (i)}
              <div class="q">
                <div class="q-text">{q.header ? `${q.header} — ` : ""}{q.question}</div>
                <div class="opts">
                  {#each q.options as o (o.label)}
                    <button class="opt" class:on={(picks[req.id]?.[i] ?? []).includes(o.label)} onclick={() => toggle(req.id, i, o.label, !!q.multiSelect)}>
                      <b>{o.label}</b>{#if o.description}<span>{o.description}</span>{/if}
                    </button>
                  {/each}
                </div>
                <input
                  type="text"
                  placeholder="Other…"
                  value={others[req.id]?.[i] ?? ""}
                  oninput={(e) => (others = { ...others, [req.id]: { ...(others[req.id] ?? {}), [i]: e.currentTarget.value } })}
                />
              </div>
            {/each}
            <input type="text" placeholder="A note (goes as your next message)" bind:value={notes[req.id]} />
            <div class="actions">
              <button class="btn accent" disabled={!answered(req)} onclick={() => answer(req, "allow", questionAnswer(req.input, picks[req.id] ?? {}, others[req.id] ?? {}))}>Answer</button>
              <button class="btn" onclick={() => answer(req, "deny", undefined, undefined, "the user skipped the question")}>Skip</button>
            </div>
          {:else if kind === "plan"}
            <div class="card-head">The plan</div>
            {#if planOf(req)}<div class="md plan">{@html renderMarkdown(planOf(req)!)}</div>{/if}
            <input type="text" placeholder="A note (why, or what to change)" bind:value={notes[req.id]} />
            <div class="seg" role="radiogroup" aria-label="After approval">
              <span>After approval</span>
              <button class:on={(planThen[req.id] ?? "ask") === "ask"} onclick={() => (planThen = { ...planThen, [req.id]: "ask" })}>Ask</button>
              <button class:on={planThen[req.id] === "auto"} onclick={() => (planThen = { ...planThen, [req.id]: "auto" })}>Auto</button>
            </div>
            <div class="actions">
              <button class="btn accent" onclick={() => answer(req, "allow", req.input, planThen[req.id] ?? "ask")}>Approve</button>
              <button class="btn" onclick={() => answer(req, "deny", undefined, undefined, KEEP_PLANNING)}>Keep planning</button>
            </div>
          {:else}
            <div class="card-head">Allow <b>{req.name}</b>?</div>
            <div class="args">
              {#each fields(req.input) as f (f.key)}
                <div class="arg"><span class="key">{f.key}</span><pre>{f.value}</pre></div>
              {/each}
            </div>
            <input type="text" placeholder="A note (the reason, if denied)" bind:value={notes[req.id]} />
            <div class="actions">
              <button class="btn accent" onclick={() => answer(req, "allow")}>Allow</button>
              <button class="btn" onclick={() => answer(req, "always")}>Allow for this chat</button>
              <button class="btn danger" onclick={() => answer(req, "deny")}>Deny</button>
            </div>
          {/if}
        </section>
      {/each}
    </main>

    <footer class="dock">
      {#if toast}<div class="toast" transition:fly={{ y: 8, duration: motion(180) }}>{toast}</div>{/if}
      {#if queue.length > 0}
        <div class="queue">
          {#each queue as q (q.id)}
            <div class="held" transition:fly={{ y: 8, duration: motion(180) }}>
              <span class="held-text">{q.text}</span>
              <span class="held-meta">{q.chat && q.chat !== chatId ? "another chat · " : ""}held</span>
              <button class="icon-btn small" onclick={() => takeBack(q.id)} aria-label="Take back into the composer">{@render icon("x")}</button>
            </div>
          {/each}
        </div>
      {/if}
      {#if readOnly}
        <div class="readonly">
          This chat is in <b>{projectName(chatProject)}</b>; the Mac has <b>{remote.project ?? "Unfiled"}</b> open. Read it here, or start a new chat in {projectName(chatProject)}.
          <button class="btn small" onclick={() => startNew(chatProject)}>New chat there</button>
        </div>
      {:else}
        <div class="composer">
          <textarea
            bind:this={box}
            rows="1"
            placeholder={chatId ? "Reply…" : `Message ${projectName(newProject)}…`}
            bind:value={draft}
            oninput={typed}
            onkeydown={(e) => {
              // A phone's Return is a new line; a hardware keyboard's
              // Return sends, as on the desktop.
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !matchMedia("(pointer: coarse)").matches) {
                e.preventDefault();
                void sendNow();
              }
            }}
          ></textarea>
          {#if busyHere && link === "online" && !draft.trim()}
            <button class="send stop" onclick={stop} aria-label="Stop the turn">{@render icon("stop")}</button>
          {:else}
            <button class="send" disabled={!draft.trim()} onclick={sendNow} aria-label={link === "online" && !remote.busy ? "Send" : "Hold until the Mac is free"}>
              {@render icon("up")}
            </button>
          {/if}
        </div>
      {/if}
    </footer>

    {#if drawer}
      <div class="scrim" transition:fade={{ duration: motion(220) }} onclick={() => (drawer = false)} role="presentation"></div>
      <nav class="drawer" transition:fly={{ x: -340, duration: motion(300), easing: cubicOut, opacity: 1 }} aria-label="Chats">
        <div class="drawer-head">
          <span class="drawer-title">Nightloom</span>
          <button class="icon-btn" onclick={() => (drawer = false)} aria-label="Close">{@render icon("x")}</button>
        </div>
        <label class="search">
          {@render icon("search")}
          <input type="search" placeholder="Search chats" bind:value={search} autocomplete="off" />
        </label>
        <button class="new-row" onclick={() => startNew(null)}>{@render icon("new")} New chat</button>
        <div class="drawer-list">
          {#each projects.length > 0 ? projects : [{ id: "", name: remote.project ?? "Unfiled", active: true }] as p (p.id)}
            {@const open = p.active || expanded[p.id]}
            <div class="proj">
              <button class="proj-head" onclick={() => (p.active ? null : toggleProject(p.id))} aria-expanded={open}>
                <span class="proj-name">{p.name}</span>
                {#if p.active}<span class="tag">on the Mac</span>{:else}<span class="chev" class:down={open}>{@render icon("chev")}</span>{/if}
              </button>
              {#if open}
                <div class="proj-chats" transition:fly={{ y: -6, duration: motion(180) }}>
                  {#each (chatsBy[p.active ? activePid : p.id] ?? []).filter(matches) as c (c.id)}
                    {@const here = c.id === chatId && (p.active ? chatProject === null : chatProject === p.id)}
                    <button class="chat-row" class:here onclick={() => openChat(c.id, p.active ? null : p.id)}>
                      <span class="chat-label">{c.label}</span>
                      <span class="chat-meta">
                        {#if p.active && c.id === remote.active_chat}<span class="live-dot" class:run={remote.busy}></span>{/if}
                        {shortWhen(c.modified)}{c.mode !== "normal" ? ` · ${c.mode}` : ""}
                      </span>
                    </button>
                  {:else}
                    <p class="empty">{chatsBy[p.active ? activePid : p.id] ? (search ? "No chats match." : "No chats yet.") : "Loading…"}</p>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
        <div class="drawer-foot">
          <span class="dot" class:ok={link === "online"} class:bad={link !== "online"}></span>
          {link === "online" ? `Connected to the Mac${remote.engine ? ` · ${remote.engine === "claude-code" ? "Claude Code" : remote.engine}` : ""}` : status}
        </div>
      </nav>
    {/if}

    {#if sheet}
      <div class="scrim" transition:fade={{ duration: motion(200) }} onclick={() => (sheet = null)} role="presentation"></div>
      <div class="sheet" transition:fly={{ y: 400, duration: motion(300), easing: cubicOut, opacity: 1 }} role="dialog" aria-modal="true">
        <div class="grabber"></div>
        {#if sheet === "chat"}
          <div class="sheet-title">{title}</div>
          <div class="sheet-sub">{projectName(chatProject)}{currentChat ? ` · ${currentChat.user_turns} messages · ${shortWhen(currentChat.modified)}` : ""}</div>
          <div class="menu">
            {#if !readOnly}
              <button onclick={beginRename}>{@render icon("pencil")} Rename</button>
              <button onclick={openOnMac} disabled={remote.busy && chatId !== remote.active_chat}>{@render icon("mac")} Open on the Mac</button>
            {/if}
            <button onclick={() => startNew(chatProject)}>{@render icon("new")} New chat{readOnly ? ` in ${projectName(chatProject)}` : ""}</button>
            {#if busyHere}
              <button class="danger" onclick={stop}>{@render icon("stop")} Stop the turn</button>
            {/if}
          </div>
        {:else if sheet === "rename"}
          <div class="sheet-title">Rename chat</div>
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" bind:value={renameText} autofocus onfocus={(e) => e.currentTarget.select()} onkeydown={(e) => e.key === "Enter" && void saveRename()} />
          <div class="actions end">
            <button class="btn" onclick={() => (sheet = "chat")}>Cancel</button>
            <button class="btn accent" disabled={!renameText.trim()} onclick={saveRename}>Save</button>
          </div>
        {:else}
          <div class="sheet-title">Start the chat in</div>
          <div class="menu">
            {#each projects as p (p.id)}
              <button onclick={() => chooseProject(p.id)}>
                <span class="grow">{p.name}</span>
                {#if p.active}<span class="tag">on the Mac</span>{/if}
                {#if (newProject ?? activePid) === p.id}{@render icon("check")}{/if}
              </button>
            {:else}
              <p class="empty">Only the Mac's open project ({remote.project ?? "Unfiled"}) is known.</p>
            {/each}
          </div>
          {#if newProject}<p class="sheet-note">Sending opens {projectName(newProject)} on the Mac.</p>{/if}
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* The desktop's palette A (app.css), and a light counterpart for a phone
     in light mode (item 246, blocker 577's default). */
  :global(:root) {
    --paper: #1b1916;
    --sheet: #232019;
    --well: #2c2822;
    --ink: #ece7dc;
    --ink2: #c9c2b3;
    --dim: #8d8676;
    --line: #332e27;
    --line2: #4a443a;
    --accent: #e0a458;
    --accent-ink: #f0c27a;
    --accent-soft: #3a2d1c;
    --on-accent: #1b1916;
    --done: #7cc48a;
    --failed: #e57373;
    --live: #7fb3f0;
    --bubble: color-mix(in srgb, var(--sheet) 88%, var(--ink));
    --scrim: rgba(0, 0, 0, 0.5);
    --sans: "IBM Plex Sans", -apple-system, system-ui, sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
    --ease: cubic-bezier(0.32, 0.72, 0, 1);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :global(:root) {
      --paper: #f6f2ea;
      --sheet: #fffdf8;
      --well: #ece6da;
      --ink: #2a251d;
      --ink2: #4a4337;
      --dim: #857d6e;
      --line: #e3dccd;
      --line2: #cfc6b4;
      --accent: #b8762a;
      --accent-ink: #9a5f1c;
      --accent-soft: #f3e3cc;
      --on-accent: #fffdf8;
      --done: #3f8f50;
      --failed: #c0453f;
      --live: #3b78c4;
      --bubble: color-mix(in srgb, var(--paper) 80%, var(--ink) 8%);
      --scrim: rgba(40, 30, 20, 0.28);
      color-scheme: light;
    }
  }
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: var(--paper);
    color: var(--ink);
    font: 16px/1.5 var(--sans);
    -webkit-text-size-adjust: 100%;
    -webkit-tap-highlight-color: transparent;
    overscroll-behavior: none;
    /* The page never scrolls sideways (his report, 2026-09-18): anything
       wider than the screen scrolls inside its own box, and the body clips
       the rest. */
    width: 100%;
    overflow-x: hidden;
  }
  :global(*) {
    box-sizing: border-box;
  }
  .ico {
    width: 22px;
    height: 22px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }
  .page {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    width: 100%;
    overflow: hidden;
    padding-top: env(safe-area-inset-top, 0px);
    padding-left: env(safe-area-inset-left, 0px);
    padding-right: env(safe-area-inset-right, 0px);
  }
  button {
    font: inherit;
    color: inherit;
  }

  /* ---- the gate ---- */
  .gate {
    margin: auto 0;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .gate-mark,
  .hello-mark {
    width: 52px;
    height: 52px;
    border-radius: 16px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    display: grid;
    place-items: center;
    font-weight: 600;
    font-size: 24px;
  }
  .gate h1 {
    font-size: 26px;
    font-weight: 600;
    margin: 4px 0 0;
  }
  .gate p {
    color: var(--ink2);
    margin: 0 0 8px;
  }

  /* ---- the top bar ---- */
  .top {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    min-height: 56px;
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--paper) 88%, transparent);
    -webkit-backdrop-filter: saturate(1.3) blur(14px);
    backdrop-filter: saturate(1.3) blur(14px);
    position: relative;
    z-index: 2;
  }
  .icon-btn {
    all: unset;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 12px;
    color: var(--ink2);
    cursor: pointer;
    flex: none;
    transition: background 0.15s;
  }
  .icon-btn:active {
    background: var(--well);
  }
  .icon-btn.small {
    width: 36px;
    height: 36px;
  }
  .icon-btn.small .ico {
    width: 18px;
    height: 18px;
  }
  .title-btn {
    all: unset;
    flex: 1;
    min-width: 0;
    min-height: 44px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    padding: 0 4px;
    cursor: pointer;
    border-radius: 12px;
  }
  .title-btn:active {
    background: var(--well);
  }
  .title {
    font-weight: 600;
    font-size: 16px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: 12px;
    color: var(--dim);
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
    flex: none;
  }
  .dot.ok {
    background: var(--done);
  }
  .dot.run {
    background: var(--live);
    animation: pulse 1.2s infinite;
  }
  .dot.bad {
    background: var(--failed);
  }

  /* ---- bars ---- */
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px 8px 16px;
    font-size: 14px;
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .bar span {
    flex: 1;
  }
  .bar.bad {
    background: color-mix(in srgb, var(--failed) 16%, var(--paper));
    color: var(--failed);
  }

  /* ---- the transcript ---- */
  .chat {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    padding: 16px 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .hello {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    text-align: center;
    padding-bottom: 8vh;
  }
  .hello-title {
    font-size: 22px;
    font-weight: 600;
  }
  .hello-note {
    color: var(--dim);
    font-size: 14px;
    margin: 0;
  }
  .chip {
    all: unset;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 40px;
    padding: 0 10px 0 14px;
    border-radius: 999px;
    background: var(--sheet);
    border: 1px solid var(--line);
    color: var(--ink2);
    font-size: 14px;
    cursor: pointer;
  }
  .chip b {
    color: var(--ink);
    font-weight: 600;
  }
  .chip .ico {
    width: 16px;
    height: 16px;
    transform: rotate(90deg);
  }
  .turn {
    max-width: 100%;
    /* A flex item's default `min-width: auto` lets a wide child (a code
       block) push the column past the screen; zero lets it shrink. */
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .turn.enter {
    animation: rise 0.28s var(--ease) both;
  }
  .turn.user {
    align-self: flex-end;
    max-width: 86%;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
  }
  .bubble {
    /* The desktop's rounded, borderless tint (backlog 126). */
    background: var(--bubble);
    border-radius: 20px;
    padding: 10px 16px;
    font-size: 15.5px;
    white-space: pre-wrap;
  }
  .stamp {
    font-size: 11px;
    color: var(--dim);
    padding-right: 6px;
  }
  .turn.reply {
    align-self: stretch;
    font-size: 16px;
  }
  .turn.note {
    align-self: center;
    font-size: 12px;
    color: var(--dim);
    font-style: italic;
  }
  .thinking {
    display: inline-flex;
    gap: 5px;
    padding: 6px 0;
  }
  .thinking i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
    animation: bounce 1.2s infinite ease-in-out;
  }
  .thinking i:nth-child(2) {
    animation-delay: 0.15s;
  }
  .thinking i:nth-child(3) {
    animation-delay: 0.3s;
  }
  .tools {
    all: unset;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
    padding: 10px 12px;
    border-radius: 14px;
    background: var(--sheet);
    border: 1px solid var(--line);
    font-size: 13px;
    color: var(--ink2);
    box-sizing: border-box;
    width: 100%;
  }
  .tools-folded {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    cursor: pointer;
  }
  .tools-folded .ico {
    width: 16px;
    height: 16px;
    color: var(--dim);
  }
  .tools-toggle {
    all: unset;
    align-self: flex-start;
    color: var(--accent-ink);
    font-size: 13px;
    padding: 8px 0 0;
    cursor: pointer;
  }
  .spacer {
    flex: 1;
  }
  .tool {
    display: flex;
    gap: 8px;
    align-items: baseline;
    white-space: nowrap;
    overflow: hidden;
  }
  .tool-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--line2);
    flex: none;
    align-self: center;
  }
  .tool-dot.ok {
    background: var(--done);
  }
  .tool-dot.bad {
    background: var(--failed);
  }
  .tool-dot.run {
    background: var(--live);
    animation: pulse 1.2s infinite;
  }
  .tool-name {
    font-weight: 600;
    flex: none;
    color: var(--ink);
  }
  .tool-sum {
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--dim);
  }
  .md :global(p) {
    margin: 0 0 0.7em;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3) {
    font-size: 1.08em;
    font-weight: 600;
    margin: 1em 0 0.4em;
  }
  .md :global(a) {
    color: var(--accent-ink);
  }
  .md :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    font-size: 14px;
    margin: 0 0 0.7em;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--line);
    padding: 6px 10px;
    text-align: left;
  }
  .md :global(th) {
    background: var(--sheet);
    font-weight: 600;
  }
  .md :global(img) {
    max-width: 100%;
    height: auto;
  }
  .md :global(pre) {
    overflow-x: auto;
    max-width: 100%;
    background: var(--sheet);
    border: 1px solid var(--line);
    padding: 10px 12px;
    border-radius: 12px;
    font-size: 12.5px;
    margin: 0 0 0.7em;
  }
  .md :global(code) {
    font-family: var(--mono);
    font-size: 0.88em;
  }
  .md :global(:not(pre) > code) {
    background: var(--well);
    padding: 1px 5px;
    border-radius: 5px;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.3em;
    margin: 0 0 0.7em;
  }
  .md :global(blockquote) {
    margin: 0 0 0.7em;
    padding-left: 12px;
    border-left: 3px solid var(--line2);
    color: var(--ink2);
  }

  /* ---- cards ---- */
  .card {
    border: 1px solid var(--line2);
    border-radius: 18px;
    padding: 14px;
    background: var(--sheet);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card-head {
    font-weight: 600;
  }
  .args {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 40dvh;
    overflow: auto;
  }
  .arg .key {
    font-size: 12px;
    color: var(--dim);
  }
  .arg pre {
    margin: 3px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--mono);
    font-size: 12.5px;
    background: var(--well);
    padding: 8px 10px;
    border-radius: 10px;
  }
  .plan {
    max-height: 55dvh;
    overflow: auto;
    font-size: 14px;
  }
  .q {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .q-text {
    font-size: 15px;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .opt {
    all: unset;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 44px;
    padding: 8px 12px;
    border: 1px solid var(--line2);
    border-radius: 12px;
    font-size: 15px;
    cursor: pointer;
    box-sizing: border-box;
    transition:
      border-color 0.15s,
      background 0.15s;
  }
  .opt span {
    font-size: 13px;
    color: var(--dim);
  }
  .opt.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .seg {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--dim);
  }
  .seg span {
    flex: 1;
  }
  .seg button {
    all: unset;
    min-height: 36px;
    min-width: 64px;
    text-align: center;
    border-radius: 10px;
    border: 1px solid var(--line2);
    color: var(--ink2);
    cursor: pointer;
  }
  .seg button.on {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  input[type="text"],
  input[type="search"],
  textarea {
    width: 100%;
    background: var(--well);
    color: inherit;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    font-size: 16px; /* under 16px iOS Safari zooms the page on focus */
    outline: none;
  }
  input:focus,
  textarea:focus {
    border-color: var(--line2);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .actions.end {
    justify-content: flex-end;
  }
  .btn {
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
    transition: transform 0.12s;
  }
  .btn:active:not(:disabled) {
    transform: scale(0.97);
  }
  .btn.small {
    min-height: 36px;
    padding: 0 12px;
    font-size: 14px;
    flex: none;
  }
  .btn.wide {
    width: 100%;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .btn.danger {
    color: var(--failed);
    border-color: color-mix(in srgb, var(--failed) 45%, transparent);
  }

  /* ---- the dock: toast, queue, composer ---- */
  .dock {
    position: relative;
    padding: 6px 10px calc(8px + env(safe-area-inset-bottom, 0px));
    background: var(--paper);
  }
  .toast {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    transform: translateX(-50%);
    background: var(--ink);
    color: var(--paper);
    padding: 8px 16px;
    border-radius: 999px;
    font-size: 13px;
    width: max-content;
    max-width: calc(100vw - 32px);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
    z-index: 3;
  }
  .queue {
    max-height: 24dvh;
    overflow: auto;
    margin-bottom: 6px;
  }
  .held {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 4px 2px 12px;
    font-size: 14px;
    border-radius: 12px;
    background: var(--sheet);
    margin-bottom: 4px;
  }
  .held-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .held-meta {
    font-size: 12px;
    color: var(--dim);
  }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 6px 6px 6px 4px;
    border: 1px solid var(--line2);
    border-radius: 24px;
    background: var(--sheet);
    box-shadow: 0 2px 14px rgba(0, 0, 0, 0.12);
  }
  .composer textarea {
    flex: 1;
    resize: none;
    border: none;
    background: transparent;
    padding: 9px 10px 9px 14px;
    min-height: 42px;
    max-height: 40dvh;
    line-height: 1.45;
  }
  .send {
    all: unset;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
    margin: 1px;
    transition:
      transform 0.15s var(--ease),
      opacity 0.15s;
  }
  .send .ico {
    width: 20px;
    height: 20px;
    stroke-width: 2.2;
  }
  .send:active:not(:disabled) {
    transform: scale(0.9);
  }
  .send:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .send.stop {
    background: var(--ink);
    color: var(--paper);
  }
  .send.stop .ico {
    fill: currentColor;
  }
  .readonly {
    font-size: 14px;
    color: var(--ink2);
    padding: 10px 12px;
    background: var(--sheet);
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }

  /* ---- the drawer and the sheets ---- */
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 10;
  }
  .drawer {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(86vw, 340px);
    z-index: 11;
    background: var(--paper);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    padding: env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    box-shadow: 8px 0 32px rgba(0, 0, 0, 0.3);
  }
  .drawer-head {
    display: flex;
    align-items: center;
    padding: 6px 6px 2px 18px;
    min-height: 56px;
  }
  .drawer-title {
    flex: 1;
    font-weight: 600;
    font-size: 18px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 14px 8px;
    padding: 0 12px;
    border-radius: 12px;
    background: var(--well);
    color: var(--dim);
  }
  .search .ico {
    width: 18px;
    height: 18px;
  }
  .search input {
    border: none;
    background: transparent;
    padding: 10px 0;
  }
  .new-row {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    margin: 0 8px;
    padding: 0 10px;
    border-radius: 12px;
    font-weight: 500;
    color: var(--accent-ink);
    cursor: pointer;
  }
  .new-row:active,
  .chat-row:active,
  .proj-head:active,
  .menu button:active:not(:disabled) {
    background: var(--well);
  }
  .drawer-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px 12px;
  }
  .proj-head {
    all: unset;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    padding: 0 10px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--dim);
    text-transform: uppercase;
  }
  .proj-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    font-size: 11px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    color: var(--accent-ink);
    background: var(--accent-soft);
    padding: 2px 8px;
    border-radius: 999px;
    flex: none;
  }
  .chev {
    display: grid;
    transition: transform 0.2s var(--ease);
  }
  .chev .ico {
    width: 16px;
    height: 16px;
  }
  .chev.down {
    transform: rotate(90deg);
  }
  .chat-row {
    all: unset;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    width: 100%;
    box-sizing: border-box;
    min-height: 52px;
    padding: 6px 10px;
    border-radius: 12px;
    cursor: pointer;
  }
  .chat-row.here {
    background: var(--sheet);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .chat-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
  }
  .chat-meta {
    font-size: 12px;
    color: var(--dim);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--done);
  }
  .live-dot.run {
    background: var(--live);
    animation: pulse 1.2s infinite;
  }
  .empty {
    color: var(--dim);
    font-size: 13px;
    padding: 6px 10px 10px;
    margin: 0;
  }
  .drawer-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid var(--line);
    font-size: 13px;
    color: var(--dim);
  }
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 12;
    background: var(--sheet);
    border-radius: 22px 22px 0 0;
    padding: 8px 16px calc(16px + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 80dvh;
    overflow-y: auto;
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.3);
  }
  .grabber {
    width: 36px;
    height: 5px;
    border-radius: 3px;
    background: var(--line2);
    margin: 0 auto 6px;
    flex: none;
  }
  .sheet-title {
    font-weight: 600;
    font-size: 17px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sheet-sub,
  .sheet-note {
    font-size: 13px;
    color: var(--dim);
    margin: -6px 0 0;
  }
  .menu {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
  }
  .menu button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 0 16px;
    cursor: pointer;
    font-size: 16px;
  }
  .menu button + button {
    border-top: 1px solid var(--line);
  }
  .menu button:disabled {
    opacity: 0.4;
  }
  .menu button.danger {
    color: var(--failed);
  }
  .menu .grow {
    flex: 1;
  }
  .menu .ico {
    color: var(--ink2);
  }
  .menu button.danger .ico {
    color: var(--failed);
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }
  @keyframes bounce {
    0%,
    80%,
    100% {
      transform: translateY(0);
      opacity: 0.5;
    }
    40% {
      transform: translateY(-5px);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(*),
    :global(*::before),
    :global(*::after) {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
      scroll-behavior: auto !important;
    }
  }
</style>
