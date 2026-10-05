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
    fitSize,
    foldTurnEvent,
    hasFeature,
    imageFromDataUrl,
    rowTarget,
    loadDraft,
    loadQueue,
    newQueued,
    questionAnswer,
    saveDraft,
    saveQueue,
    shortWhen,
    tokenFromHash,
    transcriptRows,
    damp,
    dismissVerdict,
    foldAside,
    parseAsideEvent,
    pastAsides,
    searchGroupLabel,
    searchSummary,
    PULL_AT,
    type Aside,
    type AsideEvent,
    type CouncilSend,
    type NoteScope,
    type PastAside,
    type SearchResult,
    type SearchScope,
    type ChatAction,
    type ChatRow,
    type LiveTurn,
    type Rail,
    type RailPatch,
    type Row,
    type Running,
    type TextPart,
    type Usage,
    type ProjectRow,
    type Queued,
    type RemoteState,
    type ToolRow,
    budgetAction,
    budgetCard,
    budgetHeld,
    canOp,
    clock12,
    limitCard,
    nonceFor,
    resetMs,
    replyLine,
    replySizes,
    resumeAction,
    speakText,
    type ExtraOp,
    type Try,
  } from "./client";
  import { renderMarkdown } from "../lib/markdown";
  // Wave 8B F2 (item 300): replies in order, code blocks, the keyboard.
  import { liveSegments } from "./client";
  import { codeBlocks } from "./codeBlocks";
  import { trackViewport } from "./viewport";
  import { subagentCalls } from "../lib/subagent";
  import { arrive, launch, reducedMotion } from "../lib/sendMotion";
  import type { ApprovalRequest, AskQuestion, DocumentInput, ImageInput, SessionEvent, TurnEvent } from "../lib/types";
  import { badgeOf, extOf, looksLikeText, MAX_TEXT_BYTES, notebookText, routeOf } from "../lib/attachKinds";
  import MessageMenu from "./MessageMenu.svelte";
  import RailSheet from "./RailSheet.svelte";
  import ContextSheet from "./ContextSheet.svelte";
  import RunningSheet from "./RunningSheet.svelte";
  import UsageLine from "./UsageLine.svelte";
  import MicButton from "./voice/MicButton.svelte";
  import NotesSheet from "./NotesSheet.svelte";
  import NightshiftSheet from "./NightshiftSheet.svelte";
  import AsideSheet from "./AsideSheet.svelte";
  import CouncilSheet from "./CouncilSheet.svelte";
  import ChatMenu from "./ChatMenu.svelte";
  import { chatSheetSub, fitVisual } from "./sheetLayout";
  import Hosts from "./Hosts.svelte";
  // Item 300 (wave 8B F1): the drawer follows the finger; Recents and Projects.
  import { dragAxis, drawerX, fingerSpeed, settleOpen } from "./client";
  import { UNFILED, lastActive as chatWhen, projectSummaries, recentRows } from "./recents";
  import ProjectsSheet from "./ProjectsSheet.svelte";
  import ProjectPage from "./ProjectPage.svelte";
  import {
    PROBE_MS,
    chooseHost,
    forgetHost,
    guessRole,
    hostName,
    loadHosts,
    missingSentence,
    mixedBlocked,
    nextHeldFor,
    offlineLine,
    order,
    pair,
    pairLink,
    routeFor,
    saveHosts,
    settleRole,
    type HostEntry,
    type HostRole,
    type Hosts as HostMap,
    type Tried,
  } from "./hosts";
  import { heldTap, joinDraft, loadPlace, placeFromHash, placeHash, plainError, samePlace, savePlace, triable, type Place } from "./place";
  import { NO_PROJECT, callProject, notesProject, openedProject, placeProject } from "./screenProject";
  import { LATE_NOTICE_MS, NEW_CHAT_TURN, noticeFor, turnEndedFor, type EndedTurn } from "./turnNotice";
  import { writesInFlight } from "./client";
  import {
    atRisk,
    keptSheet,
    saveResume,
    schemeVerdict,
    scrollBy,
    scrollPlace,
    takeResume,
    unkeptText,
    type NotesPlace,
    type Resume,
    type RowBox,
    type Scheme,
    type ScrollPlace,
  } from "./schemeReload";

  // ---- the hosts and the connection (wave 3: the Mac and Away) ------------
  /** The page's own origin; empty outside a browser. */
  const origin = typeof location === "undefined" ? "" : location.origin;
  /** The paired hosts, each a base URL and its own token (`hosts.ts`). */
  let hosts = $state<HostMap>({});
  /** The host answering now: the state, the stream and the lists are its. */
  let active = $state<HostRole | null>(null);
  /** What the last host choice found on the hosts it did not take. */
  let tried = $state<Tried[]>([]);
  /** The host being tried right now, for the offline bar. */
  let trying = $state<HostRole | null>(null);
  const paired = $derived(order(hosts));
  /** Voice talks to the page's own host (its socket is built from the
   *  page's address), so the mic is offered only when that host answers. */
  const micToken = $derived(active && hosts[active]?.base === origin ? hosts[active]!.token : null);
  let box = $state<HTMLTextAreaElement | null>(null);
  let paste = $state("");
  /** One client per paired host. */
  const clients = $derived.by(() => {
    const out: Partial<Record<HostRole, Client>> = {};
    for (const r of paired) out[r] = new Client(hosts[r]!.token, hosts[r]!.base === origin ? "" : hosts[r]!.base);
    return out;
  });
  /** The active host's client. */
  const client = $derived(active ? (clients[active] ?? null) : null);
  /** `online` while the event stream is open; `off` after every paired
   *  host answered 401 (the token is wrong — a new scan is the way back). */
  let link = $state<"connecting" | "online" | "offline" | "off">("connecting");
  let failures = 0;
  let abort: AbortController | null = null;
  /** Bumped to end a stream loop (a new pairing, Try again). */
  let loopId = 0;
  /** Wakes the loop from its wait between tries (Try again). */
  let wake: (() => void) | null = null;
  /** The host the drawer's lists were last read from. */
  let lastActive: HostRole | null = null;
  /** When the preferred host was last probed while another answered. */
  let lastPreferProbe = 0;

  // ---- what the Mac says ---------------------------------------------------
  let remote = $state<RemoteState>({ project: null, active_chat: null, busy: false, connected: false, engine: null, pending: [] });
  /** The state of the host whose chat is on screen when that is not the
   *  answering host (wave 3 B2, 132 finding g): polled while one of its
   *  chats is shown, so its approval prompts and limit pause show here. */
  let otherState = $state<RemoteState | null>(null);
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
  /** The chat's own project, named on every call for it (item 300, A29;
   *  blocker 1092's default: the phone keeps its own place). `chatProject`
   *  above is the display's "not the host's active one"; this never
   *  follows the host. `null` only where the host lists no id (the Mac's
   *  unfiled chats). */
  let chatPid = $state<string | null>(null);
  /** The host whose chat is on screen (wave 3): a chat belongs to the host
   *  that listed it, and its sends, actions and reads go there even when
   *  the other host is the one answering. Null for a new chat. */
  let chatHost = $state<HostRole | null>(null);
  /** The chat's label as the drawer had it, for when its host's list is
   *  not the one loaded. */
  let chatLabel = $state<string | null>(null);
  /** The project a new chat starts in; `null` is the Mac's open project. */
  let newProject = $state<string | null>(null);
  /** A new chat was sent and the Mac has not yet named its id. */
  let pendingNew = $state<{ before: string | null } | null>(null);
  /** Set once he picks a screen, so the first state read does not move him. */
  let chose = false;
  let events = $state<SessionEvent[]>([]);
  let live = $state<LiveTurn | null>(null);
  /** The chat whose turn the page started (300 A16/B2): the turn-end toast
   *  asks this, not the host's current chat, which a send moves before the
   *  page reads it again. A turn started elsewhere (the Mac, a curl) leaves
   *  it null, and the host's current chat at the end names it. */
  let turnChat: string | null = null;
  /** 300 review 2: a turn the state read saw end before its notice came,
   *  and when a notice last came (one that came first leaves none). */
  let endedTurn: EndedTurn | null = null;
  let noticedAt = 0;
  let toast = $state<string | null>(null);
  /** The chat a toast opens on a tap (300 A16), or null. */
  let toastChat = $state<string | null>(null);
  let error = $state<string | null>(null);
  /** The host's full sentence behind `error`, shown on a tap (A14). */
  let errorDetail = $state<string | null>(null);
  let showDetail = $state(false);
  /** The held message whose ✕ asks where it goes (A36). */
  let heldAsk = $state<string | null>(null);
  let draft = $state("");
  let queue = $state<Queued[]>(loadQueue());
  let scroller = $state<HTMLElement | null>(null);
  /** Rows at or past this index arrived while he watched and rise in. */
  let enterFrom = $state(0);
  let drawer = $state(false);
  let search = $state("");
  let sheet = $state<
    | null
    | "chat"
    | "rename"
    | "project"
    | "message"
    | "rail"
    | "running"
    | "delete"
    | "notes"
    | "aside"
    | "council"
    | "newproject"
    | "hosts"
    | "compact"
    | "nightshift"
  >(null);
  // ---- wave 2C: notes, asides, council, new project, search, gestures ----
  /** The notes sheet opens on this note (a search hit), else its list. */
  let notesStart = $state<{ scope: NoteScope; name: string } | null>(null);
  /** The project the notes sheet works in, fixed when it opens (300 B1):
   *  the project on screen, never the host's open one, which a turn
   *  elsewhere moves while he types. `null`: the host lists no projects. */
  let notesPid = $state<string | null>(null);
  /** A note open or edited: the sheet takes more of the screen. */
  let sheetTall = $state(false);
  /** The aside asked from this page, per chat; folded from `aside-event`s. */
  let asides = $state<Record<string, Aside>>({});
  let asidePast = $state<PastAside[] | null>(null);
  /** Deltas whose exchange this page has not been told the number of yet
   *  (one can arrive a moment before the 202 does; 2A's note): kept a few
   *  seconds, then dropped — the end's whole answer heals any gap. */
  let asideEarly: { ev: AsideEvent; at: number }[] = [];
  let asideProblem = $state<string | null>(null);
  let councilProblem = $state<string | null>(null);
  let projName = $state(loadDraft("newproject:name"));
  let projInstructions = $state(loadDraft("newproject:instructions"));
  let projProblem = $state<string | null>(null);
  let projBusy = $state(false);
  let searchScope = $state<SearchScope>("all");
  let found = $state<SearchResult | null>(null);
  let searching = $state(false);
  let searchProblem = $state<string | null>(null);
  let searchTimer: number | null = null;
  let searchAbort: AbortController | null = null;
  /** A pull-to-refresh in progress: how far, and where. */
  let pullBy = $state(0);
  let pullWhere = $state<"chat" | "drawer">("chat");
  let refreshing = $state(false);
  /** A drag on the sheet (down, to dismiss). */
  let sheetDy = $state(0);
  /** What the message menu is open on (wave 1C). */
  let menuOn = $state<{ row: Row; part: TextPart | null; tool: ToolRow | null } | null>(null);
  /** The rail as the Mac last said, and why it could not be read. */
  let rail = $state<Rail | null>(null);
  /** The Context page (wave 2B), full screen over the chat. */
  let contextOn = $state(false);
  let railProblem = $state<string | null>(null);
  let running = $state<Running | null>(null);
  let runningProblem = $state<string | null>(null);
  let usage = $state<Usage | null>(null);
  /** Photos in the composer, scaled and base64'd (wave 1C). Page state
   *  only: a photo is too big for localStorage, so a reload drops it —
   *  his text, which is small, is the draft that persists. */
  let photos = $state<{ id: number; image?: ImageInput; doc?: DocumentInput; url: string }[]>([]);
  /** The wire halves of what is in the composer (item 277: files too). */
  const imagesOf = (list: typeof photos) => list.flatMap((p) => (p.image ? [p.image] : []));
  const docsOf = (list: typeof photos) => list.flatMap((p) => (p.doc ? [p.doc] : []));
  let photoSeq = 0;
  let picker = $state<HTMLInputElement | null>(null);
  /** The chat just moved to the trash, offered back until dismissed. */
  let trashed = $state<{ id: string; label: string; project: string | null; host: HostRole | null } | null>(null);
  let renameText = $state("");
  let openTools = $state<Record<string, boolean>>({});
  /** The gap the chat's pull opens above the first message (300 A6). */
  const pullGap = $derived(pullWhere === "chat" ? (refreshing ? 52 : Math.round(pullBy)) : 0);
  /** Agent cards whose subagent steps are open (300 A1), by call id. */
  let openSteps = $state<Record<string, boolean>>({});

  const activePid = $derived(projects.find((p) => p.active)?.id ?? "");
  /** The host lists No project as a project (serve, Away); the Mac's own
   *  listener does not, and refuses `unfiled` on its chat routes. */
  const listsUnfiled = $derived(projects.some((p) => p.id === NO_PROJECT));
  /** A chat in No project on a host that cannot address it while another
   *  project is open (300 review 1): read-only, no "new chat there". */
  const unaddressable = $derived(chatProject === NO_PROJECT && !listsUnfiled);
  const rows = $derived(transcriptRows(events));
  const currentChat = $derived.by(() => {
    if (!chatId) return null;
    const list = chatsBy[chatProject ?? activePid] ?? [];
    return list.find((c) => c.id === chatId) ?? null;
  });
  const title = $derived(chatId ? (currentChat?.label ?? chatLabel ?? "Chat") : "New chat");
  /** The chat on screen is the answering host's (or a new chat). */
  const sameHost = $derived(chatHost === null || chatHost === active);
  /** The host a chat-addressed call goes to, and its client. */
  const chatRole = $derived(routeFor(chatHost, active));
  const chatClient = $derived(chatRole ? (clients[chatRole] ?? null) : null);
  /** Item 300 (A3): the host a chat's words name — "the Mac" or "Away" —
   *  so the page never says "the Mac" while it talks to Away. */
  const hostWord = $derived(hostName(chatRole ?? active ?? "mac"));
  const HostWord = $derived(hostWord === "the Mac" ? "The Mac" : hostWord);
  const projectName = (pid: string | null) =>
    pid === null || pid === activePid ? (remote.project ?? projects.find((p) => p.active)?.name ?? "Unfiled") : (projects.find((p) => p.id === pid)?.name ?? (pid === NO_PROJECT ? "No project" : "project"));
  /** A wave-1 host takes actions and sends on any chat, opening it on the
   *  Mac first (blocker 665's default); an older one only reads a chat in
   *  another project. */
  const canAct = $derived(hasFeature(remote, "act"));
  const readOnly = $derived(unaddressable || (chatProject !== null && chatProject !== activePid && !hasFeature(remote, "send_project")));
  /** A host from before wave 1 would drop a photo without a word. */
  const canPhoto = $derived(hasFeature(remote, "images"));
  /** And one that takes documents (item 277): PDFs, text, office files. */
  const canFile = $derived(hasFeature(remote, "documents"));
  /** The chat's project to send with when the Mac has another open. */
  const sendProject = $derived(callProject(chatPid, chatProject, activePid, listsUnfiled));
  /** Why the log cannot be changed now: a turn running (the desktop's
   *  controls hide while one runs; the Mac refuses mid-turn, 665). */
  const actBlocked = $derived(
    link !== "online" ? `${HostWord} is unreachable.` : remote.busy ? `A turn is running on ${hostWord} — wait for it to end.` : null,
  );
  /** The live turn belongs to the desktop's running (or open) chat; another
   *  chat's view shows nothing live and re-reads when the turn ends. */
  const liveHere = $derived(
    live !== null &&
      !readOnly &&
      sameHost &&
      ((chatId !== null && chatId === remote.active_chat) || (chatId === null && pendingNew !== null)),
  );
  /** The state of the chat's own host: the answering host's, or the
   *  other's as last polled (null until read). */
  const chatState = $derived(sameHost ? remote : otherState);
  const pendingHere = $derived(
    readOnly || chatId === null || !chatState || chatId !== chatState.active_chat ? [] : chatState.pending,
  );
  /** The other host's turn may be waiting on an approval in a chat this
   *  page is not showing it for (132 g, "at the least" line). */
  const otherWaiting = $derived(!sameHost && otherState !== null && otherState.pending.length > 0 && pendingHere.length === 0);
  /** 300 A27: the chat on this host whose turn waits on his answer while
   *  he reads another — a bar names it and opens it. */
  const waitingIn = $derived.by(() => {
    if (!sameHost || readOnly || remote.pending.length === 0 || pendingHere.length > 0) return null;
    const id = remote.pending[0].chat ?? remote.active_chat;
    return id && id !== chatId ? id : null;
  });
  /** Wave B's buttons: the chat's own host serves the op (`canOp`). */
  const opOk = (op: ExtraOp) => canOp(chatState ?? remote, op);
  const opMissing = (op: ExtraOp, older: string) => (opOk(op) ? null : missingSentence((chatState ?? remote).host, older));
  /** A clock for the cards whose words change with time (the limit's
   *  reset, a held call's deadline). */
  let now = $state(Date.now());
  /** The limit pause on the chat shown (item 164), from its host. */
  const limitHere = $derived(
    chatId !== null && chatState?.limit_pause && chatState.limit_pause.chat === chatId ? chatState.limit_pause : null,
  );
  /** Resume was asked before the reset and the host holds it (per chat). */
  let limitSet = $state<Record<string, number>>({});
  let limitBusy = $state(false);
  let budgetBusy = $state(false);
  const sizes = $derived(replySizes(events));
  const busyHere = $derived(remote.busy && !readOnly && sameHost && chatId !== null && chatId === remote.active_chat);
  /** The budget hook holds a call in the running chat on screen. */
  const heldHere = $derived(busyHere ? budgetHeld(running?.budget, now) : null);
  const status = $derived(
    link === "off"
      ? "not paired"
      : link !== "online"
        ? paired.length > 1
          ? "no host answering"
          : `${active === "away" || paired[0] === "away" ? "Away" : "Mac"} unreachable`
        : remote.busy
          ? busyHere || pendingNew
            ? "working…"
            : "busy in another chat"
          : remote.connected
            ? "connected"
            : `no engine on ${hostWord}`,
  );

  function note(text: string, open: string | null = null) {
    toast = text;
    toastChat = open;
    setTimeout(() => {
      if (toast === text) toast = null;
    }, 4000);
  }

  /** The host's "the turn ended" (300 A16): nothing when the reply is on
   *  screen; when it ended in another chat, a toast naming it that opens
   *  it on a tap. */
  function turnEndedNotice() {
    // A late notice is for the turn the read saw end, not the one a held
    // message has started since (300 review 2).
    const n = noticeFor(endedTurn, turnChat, remote.active_chat, Date.now());
    endedTurn = null;
    noticedAt = Date.now();
    const ran = turnEndedFor(n.turn, n.host, chatId, pendingNew !== null);
    if (!n.late || turnChat === n.turn) turnChat = null;
    if (!ran) return;
    const label = Object.values(chatsBy)
      .flatMap((l) => l ?? [])
      .find((c) => c.id === ran)?.label;
    note(label ? `Reply ready in “${label}”` : "Reply ready in another chat", ran);
  }

  /** A wrong token ends the link; an unreachable Mac marks it offline; any
   *  other failure shows its sentence — unless `quiet`, for the background
   *  reads, whose failure the offline bar already says. */
  function fail(e: unknown, quiet = false, doing: string | null = null) {
    // A host other than the one answering (a chat of the other host's) does
    // not change the link: its call fails with its own sentence, or holds.
    const other = (e instanceof ApiError || e instanceof Unreachable) && client !== null && e.base !== client.base;
    if (e instanceof ApiError && e.status === 401 && !other) {
      // The answering host refused its token: try the other, if paired.
      if (active) tried = [...tried.filter((t) => t.role !== active), { role: active, base: hosts[active]?.base ?? "", why: "refused", message: e.message }];
      showError(e.message, doing);
      abort?.abort();
      return;
    }
    if (e instanceof Unreachable) {
      if (other) {
        if (!quiet) error = `${chatRole === "away" ? "Away" : "The Mac"} is unreachable.`;
        return;
      }
      if (link !== "off") link = "offline";
      return;
    }
    if (!quiet) showError(String(e instanceof Error ? e.message : e), doing);
  }

  /** The banner's line in plain words; the host's sentence behind a tap (A14). */
  function showError(message: string, doing: string | null = null) {
    const p = plainError(message, doing);
    error = p.text;
    errorDetail = p.detail;
    showDetail = false;
  }

  async function refreshState() {
    if (!client) return;
    try {
      const was = remote.busy;
      const wasProject = remote.project;
      remote = await client.state();
      // The host's active project moved (a turn elsewhere, another phone):
      // the drawer's active group is read for it now, not on a pull (A28).
      if (projects.length > 0 && remote.project !== wasProject) {
        await refreshProjects();
        await refreshChats();
      }
      // A new chat's id is the Mac's once its log exists (item 246).
      if (pendingNew && remote.active_chat && remote.active_chat !== pendingNew.before && chatId === null) {
        const id = remote.active_chat;
        const typed = draft;
        pendingNew = null;
        chatId = id;
        chatHost = active;
        chatProject = null;
        chatPid = newProject ?? (activePid || null);
        if (turnChat === NEW_CHAT_TURN) turnChat = id;
        place();
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
      // By its id when the host names one, so the list and its key agree
      // even when the host's active project moved since `projects` was read.
      const pid = activePid;
      chatsBy = { ...chatsBy, [pid]: await client.chats(pid || null) };
      for (const p of projects) if (!p.active && expanded[p.id]) void loadProject(p.id);
      // 300 retest: the chat on screen's own project is re-read too, so its
      // title follows a rename or a turn (F1's Recents dropped the expanded
      // groups this used to ride on).
      if (chatPid && chatPid !== pid) await loadProject(chatPid);
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
    if (!chatClient || !chatId) return;
    const id = chatId;
    try {
      const got = await chatClient.transcript(id, sendProject);
      if (id !== chatId) return;
      const near = nearBottom();
      events = got;
      enterFrom = transcriptRows(got).length;
      // Only follow the end when he was already there (A12): a re-read
      // while he reads higher up leaves him where he is.
      if (stick) pinToEnd();
      else if (near) scrollToEnd();
    } catch (e) {
      fail(e, true);
    }
  }

  /** The turn is over: the log on disk is whole, the live fold can go, and
   *  anything held in the queue can leave. */
  async function turnEnded() {
    live = null;
    // The notice may come after the state read that saw the turn end; a
    // chat remembered for a turn whose notice never came is dropped soon.
    const was = turnChat;
    setTimeout(() => {
      if (turnChat === was) turnChat = null;
    }, 5000);
    // Its notice, if it has not come yet, is for this turn (300 review 2).
    if (Date.now() - noticedAt > LATE_NOTICE_MS) endedTurn = { turn: was, host: remote.active_chat, at: Date.now() };
    await refreshTranscript();
    await refreshChats();
    await drainQueue();
  }

  async function everything() {
    await refreshState();
    await refreshProjects();
    await refreshChats();
    const back = startPlace;
    startPlace = null;
    if (!chose && chatId === null && !pendingNew && back) {
      // Item 300 (A21, A37): the screen he was on — a reload, a
      // home-screen launch — not the host's last chat.
      const host = back.host && clients[back.host] ? back.host : active;
      if (back.chat) await openChat(back.chat, back.project, host);
      else startNew(back.project);
      await applyResume();
      return;
    }
    if (!chose && chatId === null && !pendingNew && remote.active_chat) {
      // The first screen: the chat the Mac is on (blocker 576's default).
      chatId = remote.active_chat;
      chatHost = active;
      chatPid = activePid || null;
      place();
      draft = loadDraft(draftKey(chatId, null));
      await refreshTranscript(true);
      void grow();
      await applyResume();
      return;
    }
    if (chatId) await refreshTranscript();
    await applyResume();
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
        const first = live === null;
        live = foldTurnEvent(live ?? emptyTurn(), ev);
        if (near) scrollToEnd();
        // 300 A31: a turn sent from another device — its message is on
        // disk before the first event; read it so it shows above the reply.
        if (first && chatId !== null && chatId === remote.active_chat) void refreshTranscript();
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
      case "turn-notice": {
        let said: string;
        try {
          said = JSON.parse(data);
        } catch {
          said = data;
        }
        if (said === "the turn ended") turnEndedNotice();
        else note(said);
        break;
      }
      case "pass-event":
        // The Mac's dream or capture pass (wave 3 B1): its own toast on the end.
        try {
          const p = JSON.parse(data) as { kind?: string; state?: string; text?: string | null };
          if ((p.state === "done" || p.state === "failed") && p.text) note(p.text);
        } catch {
          /* a malformed event says nothing */
        }
        break;
      case "lagged":
        void everything();
        break;
      case "aside-event":
      case "aside-delta": {
        // Wave 2C: an aside's answer streaming in (patch note 2C→2A).
        const ev = parseAsideEvent(data);
        if (!ev) break;
        if (!Object.values(asides).some((a) => a.seq === ev.seq)) {
          // Not ours yet (the 202 is on its way), or another aside's.
          const now = Date.now();
          asideEarly = [...asideEarly.filter((e) => now - e.at < 5000).slice(-200), { ev, at: now }];
          break;
        }
        let ended: Aside | null = null;
        const next: Record<string, Aside> = {};
        for (const [chat, a] of Object.entries(asides)) {
          const b = foldAside(a, ev);
          if (a.state === "asking" && b.state !== "asking") ended = b;
          next[chat] = b;
        }
        asides = next;
        if (ended && sheet !== "aside") note(ended.state === "done" ? "The aside answered — open it from the chat's ⋯" : "The aside stopped");
        break;
      }
      default:
        break;
    }
  }

  /**
   * Choose the host (wave 3): the Mac first with a 1.5 s deadline, then
   * Away; a host this page cannot call at all (mixed content) is skipped
   * and said. The host that answers carries the state, the stream and the
   * lists; its own word on what it is (`host`) settles which role it is.
   */
  async function choose(run: number): Promise<boolean> {
    const roles = order(hosts);
    if (roles.length === 0) return false;
    const got = await chooseHost(
      roles,
      hosts,
      (role, signal) => clients[role]!.state(signal),
      (role) => mixedBlocked(origin, hosts[role]!.base),
      PROBE_MS,
      (role, sofar) => {
        if (run !== loopId) return;
        trying = role;
        tried = sofar;
      },
    );
    if (run !== loopId) return false;
    trying = null;
    tried = got.tried;
    if (got.role === null) {
      active = null;
      link = got.tried.length > 0 && got.tried.every((t) => t.why === "refused") ? "off" : "offline";
      if (link === "off") error = got.tried.find((t) => t.message)?.message ?? "The token is wrong.";
      return false;
    }
    const settled = settleRole(hosts, got.role, got.state.host);
    if (settled.hosts !== hosts) {
      hosts = settled.hosts;
      saveHosts(hosts, origin);
    }
    active = settled.role;
    if (lastActive !== settled.role) {
      const was = lastActive;
      // The chat on screen keeps its name though its host's list goes.
      if (chatId) chatLabel = currentChat?.label ?? chatLabel;
      lastActive = settled.role;
      // Another host's lists: the drawer reloads from the one answering.
      projects = [];
      chatsBy = {};
      expanded = {};
      if (was !== null) note(`Now on ${hostName(settled.role)}`);
    }
    remote = got.state;
    return true;
  }

  // A function, not the variable: `fail` sets `link` from under the loop,
  // and a direct read after the assignment is narrowed past that.
  const tokenRefused = () => link === "off";

  async function streamLoop() {
    const run = ++loopId;
    for (;;) {
      if (run !== loopId) return;
      // Item 300 (A34): a page out of sight holds no stream — Safari gives
      // a host six connections, and tabs left open used them all up. It
      // waits here until shown (the visibility handler wakes it).
      while (document.visibilityState === "hidden" && run === loopId) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, 60000);
          wake = () => {
            clearTimeout(t);
            r();
          };
        });
        wake = null;
      }
      if (run !== loopId) return;
      link = failures === 0 ? "connecting" : "offline";
      const ok = await choose(run);
      if (run !== loopId) return;
      if (tokenRefused()) return;
      if (ok && client) {
        abort = new AbortController();
        try {
          await client.events(onEvent, abort.signal);
          // The stream ended cleanly: the listener went off. Try again.
        } catch (e) {
          fail(e, true);
        }
        if (run !== loopId) return;
      }
      failures += 1;
      link = "offline";
      // A host that dropped: the other is tried at once; only when neither
      // answered does the page wait before the next round.
      if (ok && failures <= 1) continue;
      await new Promise<void>((r) => {
        const t = setTimeout(r, backoffMs(failures));
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = null;
    }
  }

  /** Try every host again now (the offline bar's button). */
  function retry() {
    failures = 0;
    error = null;
    abort?.abort();
    if (wake) wake();
    else void streamLoop();
  }

  /** While a turn runs the stream carries no "done": the state is polled
   *  every three seconds and the flip of `busy` is the end. While a host
   *  other than the preferred one answers, the preferred one is asked
   *  every 30 s, and the page moves back when it answers. */
  function pollLoop() {
    setInterval(() => {
      if (link === "online" && (remote.busy || live !== null || queue.length > 0 || pendingNew)) void refreshState();
      // Wave 3 B2: the other host's state while one of its chats is shown
      // (its approvals, its limit pause), and the running turn's budget
      // ledger while a turn runs in the chat on screen.
      if (link === "online" && !sameHost && chatClient) void refreshOther();
      if (link === "online" && busyHere && hasFeature(remote, "running") && sheet !== "running") void refreshBudget();
      const prefer = paired[0];
      if (link === "online" && prefer && active !== prefer && !mixedBlocked(origin, hosts[prefer]!.base) && Date.now() - lastPreferProbe > 30000) {
        lastPreferProbe = Date.now();
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), PROBE_MS);
        clients[prefer]
          ?.state(ctl.signal)
          .then(() => {
            clearTimeout(t);
            if (active !== prefer) retry();
          })
          .catch(() => clearTimeout(t));
      }
    }, 3000);
  }

  /** Pair `entry` as `role` (a scanned link, a paste) and connect. */
  function pairHost(role: HostRole, entry: HostEntry) {
    hosts = pair(hosts, role, entry);
    saveHosts(hosts, origin);
    tried = tried.filter((t) => t.role !== role);
    error = null;
    failures = 0;
    abort?.abort();
    void streamLoop();
  }

  function start(t: string) {
    pairHost(guessRole(origin), { base: origin, token: t });
  }

  /** Forget `role`'s token (the hosts sheet, or Scan again on a refusal). */
  function forgetRole(role: HostRole) {
    hosts = forgetHost(hosts, role);
    saveHosts(hosts, origin);
    tried = tried.filter((t) => t.role !== role);
    if (active === role) active = null;
    error = null;
    failures = 0;
    abort?.abort();
    if (paired.length > 0) void streamLoop();
    else {
      loopId += 1;
      link = "connecting";
    }
  }

  /** Scan again after a refusal: every refused token goes. */
  function forget() {
    const refused = tried.filter((t) => t.why === "refused").map((t) => t.role);
    for (const r of refused.length > 0 ? refused : paired) hosts = forgetHost(hosts, r);
    saveHosts(hosts, origin);
    tried = [];
    active = null;
    abort?.abort();
    error = null;
    failures = 0;
    if (paired.length > 0) void streamLoop();
    else {
      loopId += 1;
      link = "connecting";
    }
  }

  onMount(() => {
    hosts = loadHosts(origin);
    const fromHash = tokenFromHash(location.hash);
    // Where he was (A21): the hash's place on a reload, the stored one on
    // a launch — read before the token's hash is cleared.
    startPlace = (fromHash ? null : placeFromHash(location.hash)) ?? loadPlace();
    // Item 302: what the page kept when it reloaded for a scheme change.
    pendingResume = fromHash ? null : takeResume(Date.now());
    window.addEventListener("popstate", onPopState);
    if (fromHash) {
      // Off the address bar the moment it is read: a token in the history
      // is a token in a screenshot.
      history.replaceState(null, "", location.pathname + location.search);
      start(fromHash);
    } else if (paired.length > 0) void streamLoop();
    pollLoop();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        // Let the stream go while out of sight (A34); the loop waits.
        abort?.abort();
        return;
      }
      // Item 302: shown again after a scheme change while away — reload
      // now, before the stream and reads start, if nothing is at risk.
      if (considerReload()) return;
      if (link === "off") return;
      failures = 0;
      if (wake) wake();
      if (client) void everything();
    });
    // Leaving or going into the back-forward cache: the stream goes too.
    window.addEventListener("pagehide", () => abort?.abort());
    window.addEventListener("pageshow", () => void considerReload());
    const clock = setInterval(() => (now = Date.now()), 15000);
    // The phone's own light or dark decides which (blocker 577): read here
    // rather than by a media query, so the palette blocks key on one
    // attribute; a change of the phone's setting follows at once.
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const scheme = () => {
      document.documentElement.dataset.scheme = mq.matches ? "light" : "dark";
      // Item 302: Safari's bars keep the scheme the page loaded in.
      considerReload();
    };
    loadedScheme = mq.matches ? "light" : "dark";
    document.documentElement.dataset.scheme = loadedScheme;
    mq.addEventListener?.("change", scheme);
    // 300 A15: the page fits what the keyboard leaves (viewport.ts); when
    // it shrinks, the transcript moves up by as much, so the messages he
    // was reading stay above the composer.
    const unfit = trackViewport((fit, was) => {
      if (fit && was && scroller && fit.height < was.height) scroller.scrollTop += was.height - fit.height;
    });
    return () => {
      clearInterval(clock);
      window.removeEventListener("popstate", onPopState);
      mq.removeEventListener?.("change", scheme);
      unfit();
    };
  });

  // ---- item 302: a reload on a scheme change, with everything kept ----------
  /** The scheme the page loaded in: the one Safari's bars show. */
  let loadedScheme: Scheme | null = null;
  let reloading = false;
  /** What the page kept before its scheme reload, put back once. */
  let pendingResume: Resume | null = null;
  /** The Notes sheet's tab and note now, and the ones to open on. */
  let notesPlace: NotesPlace | null = null;
  let notesResume = $state<NotesPlace | null>(null);

  const phoneScheme = (): Scheme => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

  /** Whether a reload now would lose something (`schemeReload.atRisk`). */
  function reloadRisk(): boolean {
    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input")].map((el) => ({
      type: el instanceof HTMLTextAreaElement ? "textarea" : (el.getAttribute("type") ?? ""),
      value: el.value,
      kept: el.hasAttribute("data-kept"),
    }));
    return atRisk({
      attachments: photos.length,
      writes: writesInFlight(),
      unkept: unkeptText(fields),
      held: document.querySelector("[data-reload-hold]") !== null,
    });
  }

  /** Reload for the phone's scheme when the verdict says now; `true` when
   *  the page is reloading. */
  function considerReload(): boolean {
    if (reloading) return true;
    if (!loadedScheme) return false;
    const v = schemeVerdict({ loaded: loadedScheme, now: phoneScheme(), visible: document.visibilityState === "visible", atRisk: reloadRisk() });
    if (v !== "now") return false;
    reloadKeeping();
    return true;
  }

  /** The transcript's rows, by where they sit in the view. */
  function rowBoxes(): RowBox[] {
    if (!scroller) return [];
    const top = scroller.getBoundingClientRect().top;
    return [...scroller.querySelectorAll<HTMLElement>("[data-row]")].map((el) => {
      const b = el.getBoundingClientRect();
      return { row: Number(el.dataset.row), top: b.top - top, bottom: b.bottom - top };
    });
  }

  /** Keep the screen, the scroll and the sheet, then reload. */
  function reloadKeeping() {
    reloading = true;
    place(true);
    const notes = sheet === "notes";
    saveResume({
      at: Date.now(),
      chat: chatId,
      scroll: chatId && scroller ? scrollPlace(rowBoxes(), nearBottom()) : null,
      drawer,
      sheet: keptSheet(sheet),
      projects: projectsView ? { page: projectsView.page } : null,
      context: contextOn,
      notesPid: notes ? notesPid : null,
      notes: notes ? notesPlace : null,
    });
    abort?.abort();
    location.reload();
  }

  /** The transcript back where he was reading: the kept row at its offset,
   *  again as the rows settle, until he touches the list. */
  function restoreScroll(p: ScrollPlace) {
    if (p.atEnd) return;
    const gen = ++pinGen;
    const el = scroller;
    let mine = true;
    const stop = () => (mine = false);
    el?.addEventListener("touchstart", stop, { once: true, passive: true });
    el?.addEventListener("wheel", stop, { once: true, passive: true });
    const put = () => {
      if (!mine || gen !== pinGen || !el || scroller !== el) return;
      const row = el.querySelector<HTMLElement>(`[data-row="${p.row}"]`);
      if (!row) return;
      el.scrollTop += scrollBy(p, row.getBoundingClientRect().top - el.getBoundingClientRect().top);
    };
    void tick().then(() => {
      put();
      requestAnimationFrame(put);
      for (const ms of [120, 400, 900, 1500]) setTimeout(put, ms);
    });
  }

  /** After the reload: the scroll, the drawer, the Projects page, Context
   *  and the sheet, as kept. Once. */
  async function applyResume() {
    const r = pendingResume;
    pendingResume = null;
    if (!r) return;
    if (r.scroll && r.chat !== null && r.chat === chatId) restoreScroll(r.scroll);
    if (r.drawer) drawer = true;
    if (r.projects) openProjects(r.projects.page);
    if (r.context && chatId) contextOn = true;
    switch (r.sheet) {
      case null:
        break;
      case "rail":
        void openRail();
        break;
      case "running":
        void openRunning();
        break;
      case "aside":
        void openAside();
        break;
      case "council":
        void openCouncil();
        break;
      case "nightshift":
        openNightshift();
        break;
      case "newproject":
        openNewProject();
        break;
      case "notes":
        await openNotes(null, r.notesPid);
        notesResume = r.notes;
        break;
      case "chat":
        if (chatId) sheet = "chat";
        break;
      default:
        sheet = r.sheet;
    }
  }

  // A card that appears at the foot (the limit's, the budget's) is
  // brought into view when he was already at the end, as a reply is.
  let cardsSeen = "";
  // Before the DOM changes: "at the end" is judged without the new card.
  $effect.pre(() => {
    const key = `${limitHere ? "L" : ""}${heldHere ? "B" : ""}`;
    if (key && key !== cardsSeen && nearBottom()) void tick().then(scrollToEnd);
    cardsSeen = key;
  });

  // 300 A31: an approval that arrives is brought into view — it waits on
  // him, wherever he was reading. 300 A35: a held message's row shrinks
  // the list from below; at the end, the end stays in view.
  let asksSeen = new Set<string>();
  let heldSeen = 0;
  $effect.pre(() => {
    const ids = pendingHere.map((r) => r.id);
    const fresh = ids.find((id) => !asksSeen.has(id));
    asksSeen = new Set(ids);
    if (fresh)
      void tick().then(() =>
        scroller
          ?.querySelector(`[data-approval="${CSS.escape(fresh)}"]`)
          ?.scrollIntoView({ block: "end", behavior: reducedMotion() ? "auto" : "smooth" }),
      );
    const held = queue.length;
    if (held > heldSeen && nearBottom()) void tick().then(scrollToEnd);
    heldSeen = held;
  });

  // The desktop's palette (blocker 577, `/api/state.palette` from B1): B–D
  // as an attribute the style blocks select; A, none or an unknown id is
  // the default. Serve sends none, so Away draws palette A.
  $effect(() => {
    const p = remote.palette;
    if (p === "B" || p === "C" || p === "D") document.documentElement.dataset.palette = p;
    else delete document.documentElement.dataset.palette;
  });

  // ---- the screens ----------------------------------------------------------
  /** Where to start: the hash's place (a reload), else the stored one (a
   *  home-screen launch). Used once, by the first `everything`. */
  let startPlace: Place | null = null;
  /** Set while Back or Forward moves the page, so it adds no entry. */
  let navigating = false;

  /** Item 300 (A21, A37): the screen in the URL's hash — a history entry
   *  per chat, so Back returns to the chat before — and in storage. */
  function place(replace = false) {
    const p: Place = chatId
      ? { chat: chatId, project: placeProject(chatPid, projects.length > 0), host: chatHost }
      : { chat: null, project: newProject ?? (activePid || null), host: null };
    savePlace(p);
    if (navigating) return;
    const cur = placeFromHash(location.hash);
    if (samePlace(cur, p)) return;
    const url = location.pathname + location.search + placeHash(p);
    try {
      if (cur === null || replace) history.replaceState(p, "", url);
      else history.pushState(p, "", url);
    } catch {
      // A history the browser will not write (rate-limited): the screen still changes.
    }
  }

  /** Back or Forward: show the place the entry names. */
  function onPopState() {
    const p = placeFromHash(location.hash);
    if (!p || !client) return;
    navigating = true;
    try {
      if (p.chat) void openChat(p.chat, p.project, p.host && clients[p.host] ? p.host : active);
      else startNew(p.project);
    } finally {
      navigating = false;
    }
  }

  // The chat's own project wins over the display's guess: when the host's
  // active project moves, `chatProject` says whether this chat is in it.
  $effect(() => {
    const pid = activePid;
    if (chatId === null || projects.length === 0) return;
    // A chat with no project id (the Mac's unfiled ones): not the open
    // project while one is open (300 review 1).
    if (chatPid === null && listsUnfiled) return;
    const want = chatPid === null ? (pid ? NO_PROJECT : null) : chatPid !== pid ? chatPid : null;
    if (chatProject !== want) chatProject = want;
  });

  /** Show `id` (of `project` when it is not the Mac's open one). */
  async function openChat(id: string, project: string | null = null, host: HostRole | null = active) {
    chose = true;
    drawer = false;
    if (id === chatId && project === chatProject && chatHost === host) return;
    chatId = id;
    // Listed by the host answering now: it is that host's chat — or, an
    // Undo of a delete, the host it was deleted on (132 f), set before the
    // transcript is read so the read goes there.
    chatHost = host;
    otherState = null;
    chatLabel = (chatsBy[project ?? activePid] ?? []).find((c) => c.id === id)?.label ?? null;
    // Named now, while the host's active project is the drawer's (A29);
    // `unfiled` from a saved place stays No project (300 review 1).
    const opened = openedProject(project, activePid, listsUnfiled);
    chatProject = opened.other;
    chatPid = opened.pid;
    // Its list, for the title, when the drawer has not read it (a reload, Back).
    if (project && opened.pid && !chatsBy[opened.pid]) void loadProject(opened.pid);
    place();
    pendingNew = null;
    events = [];
    enterFrom = 0;
    draft = loadDraft(draftKey(id, null));
    void grow();
    await refreshTranscript(true);
    if (chatHost !== active) void refreshOther();
  }

  function startNew(project: string | null = null) {
    chose = true;
    drawer = false;
    sheet = null;
    chatId = null;
    chatHost = null;
    chatLabel = null;
    chatProject = null;
    chatPid = null;
    newProject = project && project !== activePid && !(project === NO_PROJECT && !listsUnfiled) ? project : null;
    place();
    pendingNew = null;
    live = null;
    events = [];
    enterFrom = 0;
    draft = loadDraft(draftKey(null, newProject));
    void grow();
    requestAnimationFrame(() => box?.focus());
  }

  function openDrawer() {
    drawer = true;
    void loadDrawer();
  }

  // ---- item 300 (wave 8B F1): the drawer, Recents and Projects -----------------------
  /** The drawer's left edge while a finger drags it (0 open, `-drawerW`
   *  closed); null when no finger is on it and it rests open or closed. */
  let dragX = $state<number | null>(null);
  let drawerW = $state(340);
  /** The Projects list, or one project's page (blocker 1090's default). */
  let projectsView = $state<{ page: string | null } | null>(null);
  /** Every chat newest first with its project tag (A23: one stable order,
   *  not groups that move when the host's open project changes). */
  const recents = $derived(recentRows(projects, chatsBy));
  /** Recents has read at least one project's chats. */
  const recentsRead = $derived(Object.keys(chatsBy).length > 0);
  const drawerShown = $derived(drawer || dragX !== null);
  /** How far open the drawer is, 0 to 1, for the scrim. */
  const drawerOpenness = $derived(dragX !== null ? (dragX + drawerW) / drawerW : drawer ? 1 : 0);

  /** Everything the drawer lists, read fresh: every project's chats by its
   *  id (A28: no group waits on a read nobody started). */
  async function loadDrawer() {
    void refreshUsage();
    await refreshProjects();
    await refreshRecents();
  }

  async function refreshRecents() {
    if (!client) return;
    if (projects.length === 0) return refreshChats();
    const c = client;
    const got = await Promise.all(
      projects.map(async (p) => {
        try {
          return [p.id, await c.chats(p.id)] as const;
        } catch (e) {
          fail(e, true);
          return null;
        }
      }),
    );
    const next = { ...chatsBy };
    for (const g of got) if (g) next[g[0]] = g[1];
    // The host's open project is also read as `activePid` by the chat
    // screen: the same list, so both stay one.
    chatsBy = next;
  }

  function openProjects(page: string | null = null) {
    drawer = false;
    projectsView = { page };
    void loadDrawer();
  }

  function openProjectChat(id: string, pid: string) {
    projectsView = null;
    void openChat(id, pid);
  }

  function newChatIn(pid: string) {
    projectsView = null;
    startNew(pid === UNFILED && !projects.some((p) => p.id === UNFILED) ? null : pid);
  }

  /** Project rename and forget go through the host's routes once the
   *  page's client has them (F3 owns client.ts; patch note 300w8-patch-F1-to-F3). */
  type ProjectOps = { renameProject?: (id: string, name: string) => Promise<unknown>; forgetProject?: (id: string) => Promise<unknown> };
  const projectOps = $derived(client as unknown as ProjectOps | null);

  async function renameProject(pid: string, name: string): Promise<string | null> {
    if (!projectOps?.renameProject) return "This host cannot rename a project yet.";
    try {
      await projectOps.renameProject(pid, name);
      await refreshProjects();
      return null;
    } catch (e) {
      return e instanceof Unreachable ? `${active ? hostName(active) : "The host"} is unreachable — try again.` : "Couldn't rename the project — try again.";
    }
  }

  async function forgetProject(pid: string): Promise<string | null> {
    if (!projectOps?.forgetProject) return "This host cannot forget a project yet.";
    try {
      await projectOps.forgetProject(pid);
      await refreshProjects();
      projectsView = { page: null };
      return null;
    } catch (e) {
      return e instanceof Unreachable ? `${active ? hostName(active) : "The host"} is unreachable — try again.` : "Couldn't forget the project — try again.";
    }
  }

  /** The latest pin of the transcript's scroll; an earlier one stops. */
  let pinGen = 0;

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

  /** A chat just opened lands on its latest message (300 A33: a long one
   *  opened at the top on the phone — a smooth scroll over the whole log,
   *  cut short while the rows were still laying out). Instant, and again
   *  as the rows settle, until he touches the list himself. */
  function pinToEnd() {
    const gen = ++pinGen;
    let mine = true;
    const stop = () => (mine = false);
    const el = scroller;
    el?.addEventListener("touchstart", stop, { once: true, passive: true });
    el?.addEventListener("wheel", stop, { once: true, passive: true });
    const pin = () => {
      if (mine && gen === pinGen && scroller === el && el) el.scrollTop = el.scrollHeight;
    };
    void tick().then(() => {
      pin();
      requestAnimationFrame(pin);
      for (const ms of [120, 400, 900]) setTimeout(pin, ms);
      setTimeout(() => {
        el?.removeEventListener("touchstart", stop);
        el?.removeEventListener("wheel", stop);
      }, 1000);
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
  /** The last message tried and not known to have landed (wave 4 C1): when
   *  its text went back into the box and he sends it again, the try
   *  carries the same nonce, so a first try whose reply was lost is not
   *  run twice. Cleared when a try lands, or when a held copy takes the
   *  nonce with it. */
  let lastTry: Try | null = null;

  async function sendNow() {
    const text = draft.trim();
    if (!text || readOnly) return;
    if (chatId === null) {
      await sendNew(text);
      return;
    }
    const images = imagesOf(photos);
    const documents = docsOf(photos);
    const attempt = nonceFor(lastTry, `send:${chatId}\n${text}`);
    lastTry = attempt;
    if (!sameHost) {
      await sendElsewhere(text, images, attempt.nonce, documents);
      return;
    }
    if ((link !== "online" || remote.busy) && images.length + documents.length > 0) {
      // A photo is too big to hold on the phone: the message stays in the
      // composer, photos and all, until the Mac can take it.
      note(link !== "online" ? "The Mac is unreachable — your message and photos stay here" : "A turn is running — send the photos when it ends");
      return;
    }
    setDraft("");
    if (link !== "online" || remote.busy) {
      hold(text, attempt.nonce);
      return;
    }
    const project = sendProject;
    const sentPhotos = photos;
    photos = [];
    try {
      const status = await chatClient!.send(chatId, text, { project, images, documents, nonce: attempt.nonce });
      lastTry = null;
      remote = { ...remote, busy: true };
      if (status !== "queued") turnChat = chatId;
      // The Mac opened the chat's project to send (blocker 665).
      if (project) void refreshProjects();
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
      events = [
        ...events,
        {
          event: "user_message",
          text,
          at: new Date().toISOString(),
          ...(images.length > 0 ? { images } : {}),
          ...(documents.length > 0 ? { documents } : {}),
        },
      ];
      scrollToEnd();
    } catch (e) {
      // Nothing sent: the photos go back into the composer.
      photos = [...sentPhotos, ...photos];
      if (e instanceof Unreachable && images.length + documents.length === 0) hold(text, attempt.nonce);
      else if (e instanceof Unreachable) {
        note("The Mac is unreachable — your message and photos stay here");
        if (!draft) setDraft(text);
      } else {
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
    const images = imagesOf(photos);
    const documents = docsOf(photos);
    const attempt = nonceFor(lastTry, `new:${newProject}\n${text}`);
    lastTry = attempt;
    try {
      const status = await client!.newChat(newProject, text, images, attempt.nonce, documents);
      lastTry = null;
      pendingNew = { before };
      setDraft("");
      photos = [];
      remote = { ...remote, busy: true };
      if (status === "queued") return;
      turnChat = NEW_CHAT_TURN;
      live = emptyTurn();
      launch("phone", box);
      events = [
        {
          event: "user_message",
          text,
          at: new Date().toISOString(),
          ...(images.length > 0 ? { images } : {}),
          ...(documents.length > 0 ? { documents } : {}),
        },
      ];
      scrollToEnd();
    } catch (e) {
      fail(e);
    }
  }

  /** Hold `text` for later; `nonce` is its first try's, when it had one
   *  (the held copy is that message, not another). */
  function hold(text: string, nonce: string | null = null) {
    if (nonce && lastTry?.nonce === nonce) lastTry = null;
    queue = [...queue, newQueued(chatId, text, new Date(), sendProject, chatRole, nonce)];
    saveQueue(queue);
    const who = chatRole === "away" ? "Away" : "the Mac";
    note(link === "online" && sameHost ? "Held — goes when the turn ends" : `Held — goes when ${who} is reachable`);
  }

  /**
   * A message in a chat of the host not answering now (wave 3): it goes to
   * that chat's own host, never the answering one. When that host cannot
   * be reached it is held for it (photos stay in the composer).
   */
  async function sendElsewhere(text: string, images: ImageInput[], nonce: string, documents: DocumentInput[] = []) {
    if (!chatClient || !chatId) return;
    const sentPhotos = photos;
    setDraft("");
    photos = [];
    try {
      const status = await chatClient.send(chatId, text, { project: sendProject, images, documents, nonce });
      lastTry = null;
      note(status === "queued" ? `Sent to ${chatRole === "away" ? "Away" : "the Mac"} — it goes when its turn ends` : `Sent to ${chatRole === "away" ? "Away" : "the Mac"}`);
      events = [
        ...events,
        {
          event: "user_message",
          text,
          at: new Date().toISOString(),
          ...(images.length > 0 ? { images } : {}),
          ...(documents.length > 0 ? { documents } : {}),
        },
      ];
      scrollToEnd();
    } catch (e) {
      photos = [...sentPhotos, ...photos];
      if (e instanceof Unreachable && images.length + documents.length === 0) hold(text, nonce);
      else {
        if (!(e instanceof Unreachable)) fail(e);
        else note(`${chatRole === "away" ? "Away" : "The Mac"} is unreachable — your message and photos stay here`);
        if (!draft) setDraft(text);
      }
    }
  }

  function takeBack(id: string) {
    const q = queue.find((m) => m.id === id);
    if (!q) return;
    // Held for another chat: ask where it goes (A36).
    if (heldTap(q, chatId) === "ask") {
      heldAsk = id;
      return;
    }
    queue = queue.filter((m) => m.id !== id);
    saveQueue(queue);
    // Into the box, beside anything already there — never over it.
    setDraft(joinDraft(draft, q.text));
  }

  /** A held message for another chat goes back to that chat's composer,
   *  and that chat opens (A36): the text is never lost, nor sent here. */
  async function editHeldInItsChat(id: string) {
    const q = queue.find((m) => m.id === id);
    heldAsk = null;
    if (!q) return;
    queue = queue.filter((m) => m.id !== id);
    saveQueue(queue);
    const key = draftKey(q.chat, q.chat ? null : (q.project ?? null));
    saveDraft(key, joinDraft(loadDraft(key), q.text));
    if (q.chat) await openChat(q.chat, q.project ?? null, q.host ?? active);
    else startNew(q.project ?? null);
  }

  function discardHeld(id: string) {
    heldAsk = null;
    queue = queue.filter((m) => m.id !== id);
    saveQueue(queue);
    note("Held message discarded");
  }

  /** Try a refused held message again (A30). */
  function retryHeld(id: string) {
    queue = queue.map((q) => (q.id === id ? { ...q, failed: undefined } : q));
    saveQueue(queue);
    void drainQueue();
  }

  /** The oldest held message goes when the Mac is reachable and idle; the
   *  next waits for that turn's end. */
  async function drainQueue() {
    if (!client || link !== "online" || remote.busy || queue.length === 0) return;
    // Only the answering host's held messages: one for the other host
    // waits for it (a chat from Away is never sent to the Mac).
    const next = nextHeldFor(triable(queue), active);
    if (!next) return;
    try {
      const status = await client.send(next.chat, next.text, { project: next.project ?? null, nonce: next.nonce ?? next.id });
      queue = queue.filter((q) => q.id !== next.id);
      saveQueue(queue);
      remote = { ...remote, busy: true };
      if (status !== "queued") turnChat = next.chat;
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
      // Refused (A30): the row says so and offers Retry; it is not tried
      // again at every turn's end, nor shown as a banner with a path.
      if (e instanceof ApiError && e.status !== 401) {
        const why = plainError(e.message, "send").text;
        queue = queue.map((q) => (q.id === next.id ? { ...q, failed: why } : q));
        saveQueue(queue);
      } else fail(e);
    }
  }

  async function stop() {
    if (!client) return;
    sheet = null;
    try {
      // The chat this page shows (backlog 159, A3), not the Mac's screen.
      await (chatClient ?? client).cancel(chatId);
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
    if (!chatClient || !chatId || !t) return;
    try {
      await chatClient.rename(chatId, t, sendProject);
      sheet = null;
      note("Renamed");
      await refreshChats();
    } catch (e) {
      // The sheet stays open with his text in it.
      fail(e, false, "rename the chat");
    }
  }

  async function openOnMac() {
    if (!chatClient || !chatId) return;
    sheet = null;
    try {
      await chatClient.open(chatId, sendProject);
      note("Opened on the Mac");
    } catch (e) {
      fail(e, false, "open it on the Mac");
    }
  }

  // ---- wave 1C: the Mac's actions on a chat (design §4 `act`) ------------------
  /**
   * Run `actions` in order on `chat` and draw what the Mac answers: the
   * log after, and — a fork, an Edit and send — the new chat it switched
   * to. `starts`: the action starts a turn (Continue, Edit and send), so
   * the live fold opens. A refusal (409: a turn running, blocker 665) is
   * the Mac's sentence in the error bar, and nothing on the page changes.
   */
  async function actOn(
    chat: string,
    project: string | null,
    actions: ChatAction[],
    label: string,
    starts = false,
    role: HostRole | null = chatRole,
  ): Promise<boolean> {
    // The chat's own host (wave 3), never the other.
    const via = role ? clients[role] : null;
    if (!via) return false;
    try {
      let reply = null;
      for (const a of actions) reply = await via.act(chat, a, project);
      // The Mac opened the chat's project to act on it (665).
      if (project) await refreshProjects();
      if (reply && chat === chatId) {
        if (reply.chat && reply.chat !== chatId) {
          chatId = reply.chat;
          chatProject = null;
          place();
          draft = loadDraft(draftKey(reply.chat, null));
          void grow();
          void refreshChats();
        } else if (project) chatProject = null;
        if (Array.isArray(reply.events) && reply.events.length > 0) {
          events = reply.events;
          enterFrom = transcriptRows(reply.events).length;
        } else await refreshTranscript();
      }
      // The Mac opened the chat to act on it (design §4): it is the Mac's
      // open chat now, until the next state read says otherwise.
      if (reply && chat === chatId && reply.chat) remote = { ...remote, active_chat: reply.chat };
      if (starts) {
        live = emptyTurn();
        turnChat = reply?.chat ?? chat;
        remote = { ...remote, busy: true };
        scrollToEnd();
      }
      note(label);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  async function act(actions: ChatAction[], label: string, starts = false): Promise<boolean> {
    if (!chatId) return false;
    return actOn(chatId, sendProject, actions, label, starts);
  }

  /** The project whose list holds `chat`, as far as the drawer has read
   *  (the Mac's running rows carry no project); null is the open one. */
  function projectOf(chat: string): string | null {
    for (const [pid, list] of Object.entries(chatsBy)) if (pid !== activePid && list.some((c) => c.id === chat)) return pid;
    return null;
  }

  function openMenu(row: Row, part: TextPart | null = null, tool: ToolRow | null = null) {
    if (!chatId || row.kind === "note") return;
    error = null;
    menuOn = { row, part, tool };
    sheet = "message";
  }

  /** Copy without the Clipboard API, which a page served over plain HTTP
   *  (the tailnet listener, blocker 660) does not get. */
  function copy(text: string) {
    const done = () => note("Copied");
    try {
      if (window.isSecureContext && navigator.clipboard) {
        void navigator.clipboard.writeText(text).then(done, () => copyByHand(text));
        return;
      }
    } catch {
      // fall through
    }
    copyByHand(text);
  }
  function copyByHand(text: string) {
    const t = document.createElement("textarea");
    t.value = text;
    t.setAttribute("readonly", "");
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    t.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    t.remove();
    note(ok ? "Copied" : "Could not copy on this phone");
  }

  /**
   * Long-press (wave 1C): 450 ms held still opens the menu; a move of
   * more than 8 px is a scroll and cancels it. The inner press (a block of
   * a reply) stops the outer (the reply) from starting. A right-click, for
   * the harness and a desktop browser, opens it at once.
   */
  function press(node: HTMLElement, fn: () => void) {
    let run = fn;
    let timer: number | null = null;
    let x = 0;
    let y = 0;
    let fired = false;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      fired = false;
      x = e.clientX;
      y = e.clientY;
      cancel();
      timer = window.setTimeout(() => {
        timer = null;
        fired = true;
        navigator.vibrate?.(10);
        run();
      }, 450);
    };
    const move = (e: PointerEvent) => {
      if (timer !== null && Math.hypot(e.clientX - x, e.clientY - y) > 8) cancel();
    };
    const click = (e: MouseEvent) => {
      // The click that ends a long-press is not a tap on what is under it.
      if (fired) {
        e.preventDefault();
        e.stopPropagation();
        fired = false;
      }
    };
    const ctx = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      run();
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", cancel);
    node.addEventListener("pointercancel", cancel);
    node.addEventListener("pointerleave", cancel);
    node.addEventListener("click", click, true);
    node.addEventListener("contextmenu", ctx);
    return {
      update(next: () => void) {
        run = next;
      },
      destroy() {
        cancel();
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", cancel);
        node.removeEventListener("pointercancel", cancel);
        node.removeEventListener("pointerleave", cancel);
        node.removeEventListener("click", click, true);
        node.removeEventListener("contextmenu", ctx);
      },
    };
  }

  // ---- wave 1C: the chat sheet's new rows ----------------------------------------
  async function deleteChat() {
    if (!chatId) return;
    const id = chatId;
    const label = currentChat?.label ?? "Chat";
    const project = sendProject;
    const host = chatRole;
    // The new chat after the delete is in the deleted chat's project, not
    // the host's open one (300 B4); No project where the host lists it.
    const home = chatPid ?? (projects.some((p) => p.id === NO_PROJECT) ? NO_PROJECT : null);
    const ok = await actOn(id, project, [{ op: "delete" }], "Moved to the trash");
    if (!ok) {
      sheet = "chat";
      return;
    }
    sheet = null;
    trashed = { id, label, project, host };
    startNew(home);
    void refreshChats();
  }

  async function undeleteChat() {
    const t = trashed;
    if (!t) return;
    const ok = await actOn(t.id, t.project, [{ op: "undelete" }], "Restored", false, t.host);
    if (!ok) return;
    trashed = null;
    await refreshProjects();
    await refreshChats();
    await openChat(t.id, t.project, t.host ?? active);
  }

  async function continueTurn() {
    sheet = null;
    await act([{ op: "continue" }], `Continuing on ${hostWord}`, true);
  }

  async function switchKind() {
    const next = currentChat?.kind === "build" ? "chat" : "build";
    sheet = null;
    if (await act([{ op: "kind", kind: next }], next === "build" ? "Now a build chat" : "Now a plain chat")) void refreshChats();
  }

  // ---- wave 3 B2: the other host's state, the cards, Compact, Speak it --------
  /** The state of the chat's host when it is not the one answering. */
  async function refreshOther() {
    const via = chatClient;
    const id = chatId;
    if (!via || sameHost || !id) return;
    try {
      const st = await via.state();
      if (id === chatId && !sameHost) otherState = st;
    } catch {
      // Unreachable: no cards from it; the send path says the rest.
      if (id === chatId) otherState = null;
    }
  }

  /** `/api/running` for its budget ledger only (quiet on failure). */
  async function refreshBudget() {
    if (!client) return;
    try {
      running = await client.running();
    } catch {
      // The card stays as it was; the Mac's own card still answers.
    }
  }

  /** Resume a turn the usage limit paused: the host's own resume, which
   *  before the reset is scheduled there for the reset — the page sends
   *  nothing sooner (item 164). Pressed once: the Mac's resume cancels a
   *  scheduled one on a second press, so the button holds after. */
  async function resumeLimit() {
    const p = limitHere;
    const id = chatId;
    if (!p || !id || limitBusy) return;
    const card = limitCard(p, Date.now());
    limitBusy = true;
    const ok = await act([resumeAction()], card.early && card.at ? `Resume set for ${clock12(card.at)}` : "Resuming", !card.early);
    limitBusy = false;
    if (ok && card.early && card.at) limitSet = { ...limitSet, [id]: card.at };
  }

  /** The budget card's answer, as the Mac's card sends it. */
  async function answerBudget(decision: "continue" | "wrap" | "stop") {
    if (budgetBusy) return;
    budgetBusy = true;
    const words = { continue: "Continuing past the line", wrap: "Wrapping up", stop: "Stopped here" }[decision];
    if (await act([budgetAction(decision)], words)) await refreshBudget();
    budgetBusy = false;
  }

  async function compactChat() {
    sheet = null;
    if (await act([{ op: "compact" }], `Compacted on ${hostWord}`)) void refreshChats();
  }

  /** The chat's last reply, read again, for voice mode's "Speak it"; null
   *  while a turn still runs in it or it ends with his message. */
  async function lastReply(): Promise<string | null> {
    await refreshState();
    await refreshTranscript();
    if (busyHere) return null;
    return speakText(events);
  }

  // ---- wave 1C: the rail, running tasks, usage ---------------------------------
  async function openRail() {
    sheet = "rail";
    if (!client) return;
    if (!hasFeature(remote, "rail")) {
      railProblem = missingSentence(remote.host, "This Mac's Nightloom is older than the phone page: update it to change the model from here.");
      return;
    }
    railProblem = null;
    try {
      rail = await client.rail();
    } catch (e) {
      railProblem = e instanceof Unreachable ? "The Mac is unreachable." : String(e instanceof Error ? e.message : e);
    }
  }

  async function patchRail(patch: RailPatch): Promise<boolean> {
    if (!client) return false;
    try {
      rail = { ...(rail ?? {}), ...(await client.setRail(patch)) };
      railProblem = null;
      note(`Set on ${hostWord}`);
      return true;
    } catch (e) {
      // The sheet says it: the error bar is under the scrim.
      railProblem = e instanceof Unreachable ? "The Mac is unreachable." : String(e instanceof Error ? e.message : e);
      return false;
    }
  }

  async function openRunning() {
    drawer = false;
    sheet = "running";
    await refreshRunning();
  }

  async function refreshRunning() {
    if (!client) return;
    if (!hasFeature(remote, "running")) {
      runningProblem = missingSentence(remote.host, "This Mac's Nightloom is older than the phone page: update it to see running tasks here.");
      return;
    }
    runningProblem = null;
    try {
      running = await client.running();
    } catch (e) {
      runningProblem = e instanceof Unreachable ? "The Mac is unreachable." : String(e instanceof Error ? e.message : e);
    }
  }

  async function refreshUsage() {
    if (!client || !hasFeature(remote, "usage")) return;
    try {
      usage = await client.usage();
    } catch {
      // The line stays as it was; the drawer's link line says the rest.
    }
  }

  // ---- wave 2C: notes, asides, council, new project ---------------------------------
  async function openNotes(start: { scope: NoteScope; name: string } | null = null, project: string | null = null) {
    drawer = false;
    notesResume = null;
    // Notes opened in the first moment after a load: the projects are read
    // first, so the sheet names the project on screen, not the host's open
    // one (300 review 4). An older host without them stays as it was.
    if (project === null && projects.length === 0) await refreshProjects();
    notesStart = start;
    notesPid =
      project ??
      notesProject(
        { chatId, chatPid, newProject, activePid, hasProjects: projects.length > 0 },
        hasFeature(remote, "notes_project"),
      );
    sheetTall = false;
    sheet = "notes";
  }

  // ---- wave 3 B1: the Nightshift sheet, the Mac's dream and capture passes ----
  function openNightshift() {
    drawer = false;
    sheetTall = false;
    sheet = "nightshift";
  }

  async function startPass(kind: "dream" | "capture") {
    drawer = false;
    try {
      await client!.pass(kind);
      note(kind === "dream" ? `Dreaming on ${hostWord}` : `Capturing on ${hostWord}`);
    } catch (e) {
      note(String(e instanceof Error ? e.message : e));
    }
  }

  async function openAside() {
    if (!chatId) return;
    asideProblem = null;
    asidePast = null;
    sheet = "aside";
    if (!chatClient || !hasFeature(remote, "aside")) return;
    try {
      asidePast = pastAsides(await chatClient.asides(chatId), asides[chatId]?.seq ?? null);
    } catch {
      // A host without the list: the sheet leaves "Earlier asides" out.
    }
  }

  /** Ask an aside on the chat on screen; true when the Mac took it. */
  async function askAside(text: string): Promise<boolean> {
    if (!chatClient || !chatId) return false;
    if (link !== "online") {
      asideProblem = "The Mac is unreachable — your question stays here.";
      return false;
    }
    const chat = chatId;
    asideProblem = null;
    try {
      const started = await chatClient.aside(chat, text, sendProject);
      if (started.seq === null) {
        asideProblem = `${HostWord} took the question but did not say which answer is its — look on ${hostWord}.`;
        return true;
      }
      let a: Aside = { chat, seq: started.seq, thread: started.thread, question: text, answer: "", state: "asking" };
      // What streamed before the 202 arrived.
      for (const e of asideEarly) a = foldAside(a, e.ev);
      asideEarly = asideEarly.filter((e) => e.ev.seq !== started.seq);
      asides = { ...asides, [chat]: a };
      return true;
    } catch (e) {
      asideProblem = e instanceof Unreachable ? "The Mac is unreachable — your question stays here." : String(e instanceof Error ? e.message : e);
      return false;
    }
  }

  async function stopAside() {
    const a = chatId ? asides[chatId] : null;
    if (!chatClient || !a || a.state !== "asking") return;
    try {
      await chatClient.stopAside(a.chat, a.seq);
    } catch (e) {
      asideProblem = e instanceof ApiError && (e.status === 404 || e.status === 501) ? "Stop is not available on this Mac." : String(e instanceof Error ? e.message : e);
    }
  }

  async function openCouncil() {
    councilProblem = null;
    // The seats start from the Mac's rail when it has not been read yet
    // (read before the sheet opens: the sheet takes its seats once).
    if (!rail && client && hasFeature(remote, "rail")) {
      try {
        rail = await client.rail();
      } catch {
        // The sheet starts from his last seats, or two defaults.
      }
    }
    sheet = "council";
  }

  /** Send the composer's text as a council turn. It is never held: a
   *  council cannot wait in the phone's queue, so the text stays in the
   *  box until the Mac can take it. */
  async function sendCouncil(council: CouncilSend): Promise<boolean> {
    const text = draft.trim();
    if (!chatClient || !chatId || !text) return false;
    const project = sendProject;
    councilProblem = null;
    const attempt = nonceFor(lastTry, `council:${chatId}\n${text}`);
    lastTry = attempt;
    try {
      const status = await chatClient.send(chatId, text, { project, council, nonce: attempt.nonce });
      lastTry = null;
      if (status !== "queued") turnChat = chatId;
      setDraft("");
      sheet = null;
      remote = { ...remote, busy: true };
      if (project) void refreshProjects();
      if (status === "queued") {
        note("The Mac is mid-turn — the council goes when it ends");
        return true;
      }
      live = emptyTurn();
      events = [...events, { event: "user_message", text, at: new Date().toISOString() }];
      scrollToEnd();
      note(`Asked ${council.seats.length} seats`);
      return true;
    } catch (e) {
      councilProblem = e instanceof Unreachable ? "The Mac is unreachable — your message stays in the box." : String(e instanceof Error ? e.message : e);
      return false;
    }
  }

  function openNewProject() {
    drawer = false;
    projProblem = null;
    sheet = "newproject";
  }

  async function createProject() {
    const name = projName.trim();
    if (!client || !name) return;
    projBusy = true;
    projProblem = null;
    try {
      const row = await client.newProject(name, projInstructions.trim() || null);
      // Made on the Mac: only now do the drafts go.
      projName = "";
      projInstructions = "";
      saveDraft("newproject:name", "");
      saveDraft("newproject:instructions", "");
      await refreshProjects();
      note(`“${row.name}” created on ${hostWord}`);
      startNew(row.id);
    } catch (e) {
      projProblem = e instanceof Unreachable ? "The Mac is unreachable — what you typed stays here." : String(e instanceof Error ? e.message : e);
    } finally {
      projBusy = false;
    }
  }

  // ---- wave 2C: search everywhere ----------------------------------------------------
  /** As he types (after a pause): the Mac's search over chats and notes. A
   *  host without `/api/search` keeps the title filter. */
  function searchTyped() {
    if (searchTimer !== null) clearTimeout(searchTimer);
    if (!hasFeature(remote, "search")) return;
    const q = search.trim();
    if (q.length < 2) {
      searchAbort?.abort();
      found = null;
      searchProblem = null;
      searching = false;
      return;
    }
    searchTimer = window.setTimeout(() => void runSearch(), 300);
  }

  async function runSearch() {
    const q = search.trim();
    if (!client || q.length < 2) return;
    searchAbort?.abort();
    const ctl = new AbortController();
    searchAbort = ctl;
    searching = true;
    searchProblem = null;
    try {
      const r = await client.search(q, searchScope, ctl.signal);
      if (searchAbort === ctl) found = r;
    } catch (e) {
      if (searchAbort === ctl && !ctl.signal.aborted) searchProblem = e instanceof Unreachable ? "The Mac is unreachable." : String(e instanceof Error ? e.message : e);
    } finally {
      if (searchAbort === ctl) searching = false;
    }
  }

  function setSearchScope(s: SearchScope) {
    searchScope = s;
    void runSearch();
  }

  function clearSearch() {
    search = "";
    searchTyped();
  }

  const searchOn = $derived(hasFeature(remote, "search") && search.trim().length >= 2);

  // ---- wave 2C: gestures (pass 1's leftovers) -----------------------------------------
  /**
   * Pull-to-refresh on a scroller: a drag down that starts at its top shows
   * the pull, and letting go past `PULL_AT` runs `fn`. Touch events, not
   * pointer events: the phone's own overscroll would cancel a pointer.
   */
  function pull(node: HTMLElement, opts: { where: "chat" | "drawer"; fn: () => Promise<void> }) {
    let o = opts;
    let y0: number | null = null;
    const y = (e: TouchEvent) => e.touches?.[0]?.clientY ?? 0;
    const start = (e: TouchEvent) => {
      y0 = node.scrollTop <= 0 && !refreshing && (e.touches?.length ?? 1) === 1 ? y(e) : null;
    };
    const move = (e: TouchEvent) => {
      if (y0 === null) return;
      if (node.scrollTop > 0) {
        y0 = null;
        pullBy = 0;
        return;
      }
      pullWhere = o.where;
      pullBy = damp(y(e) - y0);
    };
    const end = async () => {
      // A pull that ended any way at all leaves nothing drawn (300 A6: a
      // "Pull to refresh" pill stayed under the bar).
      if (y0 === null) {
        if (pullWhere === o.where) pullBy = 0;
        return;
      }
      y0 = null;
      const go = pullBy >= PULL_AT;
      pullBy = 0;
      if (!go) return;
      pullWhere = o.where;
      refreshing = true;
      try {
        await o.fn();
      } finally {
        refreshing = false;
      }
    };
    node.addEventListener("touchstart", start, { passive: true });
    node.addEventListener("touchmove", move, { passive: true });
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", end);
    return {
      update(next: typeof opts) {
        o = next;
      },
      destroy() {
        node.removeEventListener("touchstart", start);
        node.removeEventListener("touchmove", move);
        node.removeEventListener("touchend", end);
        node.removeEventListener("touchcancel", end);
      },
    };
  }

  async function pullChat() {
    await everything();
    note("Up to date");
  }

  async function pullDrawer() {
    await Promise.all([refreshProjects(), refreshUsage()]);
    await refreshChats();
    for (const p of projects) if (!p.active && expanded[p.id]) await loadProject(p.id);
  }

  type DragOpts = {
    axis: "x" | "y";
    onmove: (d: number, x0: number, dx: number, dy: number) => void;
    /** `v`: the finger's speed along `axis` as it let go, px/ms (item 300). */
    onend: (d: number, ms: number, x0: number, dx: number, dy: number, v?: number) => void;
  };

  /**
   * A horizontal or downward drag that follows the finger: `onmove` gets
   * the distance, `onend` the distance and the time, and a click that ends
   * a drag is swallowed so the row under the finger does not open.
   */
  function drag(node: HTMLElement, opts: DragOpts) {
    let o = opts;
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    let id: number | null = null;
    let moved = false;
    let trail: { t: number; x: number }[] = [];
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      id = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      t0 = performance.now();
      moved = false;
      trail = [{ t: t0, x: o.axis === "x" ? x0 : y0 }];
    };
    const move = (e: PointerEvent) => {
      if (id !== e.pointerId) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (!moved && Math.hypot(dx, dy) > 8) moved = true;
      trail.push({ t: performance.now(), x: o.axis === "x" ? e.clientX : e.clientY });
      if (trail.length > 12) trail.shift();
      if (moved) o.onmove(o.axis === "x" ? dx : dy, x0, dx, dy);
    };
    const up = (e: PointerEvent) => {
      if (id !== e.pointerId) return;
      id = null;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      trail.push({ t: performance.now(), x: o.axis === "x" ? e.clientX : e.clientY });
      o.onend(moved ? (o.axis === "x" ? dx : dy) : 0, performance.now() - t0, x0, moved ? dx : 0, moved ? dy : 0, moved ? fingerSpeed(trail) : 0);
    };
    const cancel = () => {
      if (id === null) return;
      id = null;
      o.onend(0, 0, x0, 0, 0);
    };
    const click = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", cancel);
    node.addEventListener("click", click, true);
    return {
      update(next: DragOpts) {
        o = next;
      },
      destroy() {
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", cancel);
        node.removeEventListener("click", click, true);
      },
    };
  }

  /** Item 300 (A8): the drawer's edge follows the finger 1:1 from its first
   *  point, both ways, and on letting go settles open or closed by where it
   *  is and how fast the finger was going (the Claude app's sidebar). */
  let edgeAxis: "x" | "y" | null = null;
  /** The left edge: a swipe right pulls the drawer out with the finger. */
  const edgeDrag: DragOpts = {
    axis: "x",
    onmove: (_d, _x0, dx, dy) => {
      if (drawer) return;
      if (edgeAxis === null) {
        edgeAxis = dragAxis(dx, dy);
        if (edgeAxis === "x") void loadDrawer();
      }
      if (edgeAxis === "x") dragX = drawerX(dx, drawerW, false);
    },
    onend: (_d, _ms, _x0, _dx, _dy, v = 0) => {
      const was = edgeAxis;
      edgeAxis = null;
      const x = dragX;
      dragX = null;
      if (was === "x" && x !== null && settleOpen(x, drawerW, v)) drawer = true;
    },
  };
  let navAxis: "x" | "y" | null = null;
  /** The drawer follows a swipe left and settles the same way. */
  const drawerDrag: DragOpts = {
    axis: "x",
    onmove: (_d, _x0, dx, dy) => {
      if (!drawer) return;
      if (navAxis === null) navAxis = dragAxis(dx, dy);
      if (navAxis === "x") dragX = drawerX(dx, drawerW, true);
    },
    onend: (_d, _ms, _x0, _dx, _dy, v = 0) => {
      const was = navAxis;
      navAxis = null;
      const x = dragX;
      dragX = null;
      if (was === "x" && x !== null && !settleOpen(x, drawerW, v)) drawer = false;
    },
  };
  /** The sheet follows its grabber down and goes past the mark or on a
   *  flick. Everything typed in a sheet is kept as a draft, so a dismissal
   *  loses nothing (practices §7). */
  const sheetDrag: DragOpts = {
    axis: "y",
    onmove: (d) => (sheetDy = Math.max(0, d)),
    onend: (d, ms) => {
      sheetDy = 0;
      if (dismissVerdict(d, ms)) closeSheet();
    },
  };

  function closeSheet() {
    sheet = null;
    menuOn = null;
    sheetTall = false;
  }

  // ---- wave 1C: photos --------------------------------------------------------------
  /** A photo from the camera or Photos, scaled to `PHOTO_EDGE` and
   *  re-encoded as JPEG (which also turns an iPhone's HEIC into something
   *  every engine reads). */
  function scalePhoto(file: File): Promise<ImageInput> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const { w, h } = fitSize(img.naturalWidth, img.naturalHeight);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        URL.revokeObjectURL(url);
        if (!g || w === 0) return reject(new Error("no canvas"));
        g.drawImage(img, 0, 0, w, h);
        const out = imageFromDataUrl(c.toDataURL("image/jpeg", 0.85));
        if (out) resolve(out);
        else reject(new Error("not an image"));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("unreadable"));
      };
      img.src = url;
    });
  }

  /** A file that is not a photo (item 277): a PDF as it is, an office
   *  file as it is (the server reads its text — no converter there), a
   *  text file as text. Anything else is not something the phone can
   *  send; the Mac's composer can, on the Claude Code engine. */
  async function addFile(f: File): Promise<boolean> {
    const route = routeOf(f.name, f.type);
    const bytes = new Uint8Array(await f.arrayBuffer());
    // The send body's limit is 32 MB, and base64 is 4/3 of the file.
    if (bytes.length > 20 * 1024 * 1024) {
      note(`${f.name} is too big to send from the phone (20 MB)`);
      return true;
    }
    let bin = "";
    const b64 = (b: Uint8Array) => {
      bin = "";
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    let doc: DocumentInput | null = null;
    if (route === "pdf") doc = { media_type: "application/pdf", name: f.name, data: b64(bytes) };
    else if (route === "office") doc = { media_type: f.type || "application/octet-stream", name: f.name, data: b64(bytes) };
    else if (route === "text" || route === "maybe-text") {
      if (!looksLikeText(bytes) || bytes.length > MAX_TEXT_BYTES) {
        note(`${f.name}: the phone sends photos, PDFs, office files and text — this one needs ${hostWord}`);
        return true;
      }
      const text = extOf(f.name) === "ipynb" ? notebookText(new TextDecoder().decode(bytes)) : null;
      doc = { media_type: "text/plain", name: f.name, data: b64(text === null ? bytes : new TextEncoder().encode(text)) };
    } else return false;
    photoSeq += 1;
    photos = [...photos, { id: photoSeq, doc, url: "" }];
    return true;
  }

  async function addPhotos(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      try {
        if (canFile && routeOf(f.name, f.type) !== "image" && !f.type.startsWith("image/") && (await addFile(f))) continue;
        const image = await scalePhoto(f);
        photoSeq += 1;
        photos = [...photos, { id: photoSeq, image, url: `data:${image.media_type};base64,${image.data}` }];
      } catch {
        note("That photo could not be read");
      }
    }
    if (picker) picker.value = "";
  }

  function chooseProject(pid: string) {
    const was = draft;
    newProject = pid === activePid ? null : pid;
    sheet = null;
    // The text typed before the switch travels with him to the new project.
    draft = loadDraft(draftKey(null, newProject)) || was;
    typed();
    // A reload keeps the project he chose (300 A21/B3); the same screen,
    // so it replaces the history entry rather than adding one for Back.
    place(true);
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
    // The chat's own host (132 g): an approval for Away's turn goes to Away.
    const via = sameHost ? client : chatClient;
    if (!via) return;
    const text = (notes[req.id] ?? "").trim();
    // The note rides as the deny reason; with an accepting button it is
    // the next message, as the desktop's card does it (`routeNote`).
    const reason = decision === "deny" ? text || fallback : undefined;
    if (sameHost) remote = { ...remote, pending: remote.pending.filter((p) => p.id !== req.id) };
    else if (otherState) otherState = { ...otherState, pending: otherState.pending.filter((p) => p.id !== req.id) };
    try {
      await via.approve({ id: req.id, name: req.name, decision, reason, answer: answerPayload, then });
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

{#snippet icon(name: "menu" | "new" | "more" | "up" | "stop" | "chev" | "x" | "search" | "check" | "mac" | "pencil" | "sliders" | "plus" | "trash" | "play" | "swap" | "pulse" | "note" | "aside" | "council" | "folder" | "compact" | "flag" | "moon")}
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
    {:else if name === "sliders"}<path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
    {:else if name === "plus"}<path d="M12 5v14M5 12h14" />
    {:else if name === "trash"}<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    {:else if name === "play"}<path d="M7 5v14l11-7Z" />
    {:else if name === "swap"}<path d="M7 7h12l-3-3M17 17H5l3 3" />
    {:else if name === "pulse"}<path d="M3 12h4l2-6 4 12 2-6h6" />
    {:else if name === "note"}<path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5M9 13h7M9 17h5" />
    {:else if name === "aside"}<path d="M4 5h16v10H9l-5 4Z" /><path d="M8 9h8" />
    {:else if name === "council"}<circle cx="7" cy="9" r="2.5" /><circle cx="17" cy="9" r="2.5" /><circle cx="12" cy="6" r="2.5" /><path d="M3 19c0-3 2-5 4-5M21 19c0-3-2-5-4-5M8 19c0-3 2-5 4-5s4 2 4 5" />
    {:else if name === "folder"}<path d="M3 6h6l2 2h10v11H3Z" /><path d="M12 11v5M9.5 13.5h5" />
    {:else if name === "compact"}<path d="M4 9h16M4 15h16M12 3v4l-2-2M12 7l2-2M12 21v-4l-2 2M12 17l2 2" />
    {:else if name === "flag"}<path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    {:else if name === "moon"}<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    {/if}
  </svg>
{/snippet}

{#snippet toolRows(tools: ToolRow[], depth: number, row: Row | null = null)}
  {#each tools as t (t.id)}
    <div class="tool" class:removed={t.removed} style:padding-left="{depth * 14}px" use:press={() => row && t.index != null && openMenu(row, null, t)}>
      <span class="tool-dot" class:ok={t.ok === true} class:bad={t.ok === false} class:run={t.ok === null}></span>
      <span class="tool-name">{t.name}</span>
      <span class="tool-sum">{t.summary}</span>
      {#if t.steps}
        <!-- 300 A1: a subagent's steps fold under its Agent card. -->
        <button class="steps-toggle" onclick={(e) => (e.stopPropagation(), (openSteps = { ...openSteps, [t.id]: !openSteps[t.id] }))} aria-expanded={!!openSteps[t.id]}>
          {subagentCalls(t.steps)} {subagentCalls(t.steps) === 1 ? "step" : "steps"}{@render icon("chev")}
        </button>
      {/if}
    </div>
    {#if t.steps && openSteps[t.id]}
      <div class="steps" style:margin-left="{depth * 14 + 15}px">
        {#each t.steps.split("\n") as line, k (k)}
          {#if line.startsWith("▸ ")}<div class="step-call"><b>{line.slice(2).split(" ")[0]}</b> {line.slice(2).split(" ").slice(1).join(" ")}</div>
          {:else if line.startsWith("↳ ")}<div class="step-out">{line.slice(2)}</div>
          {:else if line.trim()}<div class="step-said">{line}</div>{/if}
        {/each}
      </div>
    {/if}
    {#if t.children.length > 0}{@render toolRows(t.children, depth + 1, row)}{/if}
  {/each}
{/snippet}

{#snippet toolBox(tools: ToolRow[], key: string, running: boolean, row: Row | null = null)}
  {@const n = toolCount(tools)}
  {#if n <= 3 || openTools[key]}
    <div class="tools">
      {@render toolRows(tools, 0, row)}
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
  {#if paired.length === 0}
    <div class="gate">
      <div class="gate-mark">N</div>
      <h1>Nightloom</h1>
      <p>Open the link from <b>Settings → Remote</b> on the Mac — scan its QR code with the camera — or paste the token or the link here.</p>
      <input type="text" placeholder="Token or link" bind:value={paste} autocapitalize="off" autocomplete="off" spellcheck="false" />
      <button
        class="btn accent wide"
        disabled={!pairLink(paste, origin)}
        onclick={() => {
          const e = pairLink(paste, origin);
          if (e) pairHost(guessRole(e.base), e);
          paste = "";
        }}
      >
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
          <span class="sub-text">{chatId ? projectName(chatProject) : projectName(newProject)} · {status}</span>
        </span>
      </button>
      <Hosts mode="chip" {hosts} {active} {link} onopen={() => (sheet = "hosts")} />
      <!-- One button in this slot (wave 3 B2): the title had lost the
           sliders' width. With a chat open, Model and settings is the
           first row of its ⋯ sheet. -->
      {#if chatId}
        <button class="icon-btn" onclick={() => (sheet = "chat")} aria-label="Chat actions">{@render icon("more")}</button>
      {:else}
        <button class="icon-btn" onclick={openRail} aria-label="Model and settings">{@render icon("sliders")}</button>
      {/if}
      <button class="icon-btn" onclick={() => startNew(chatProject ?? newProject)} aria-label="New chat">{@render icon("new")}</button>
    </header>

    {#if link === "off"}
      <div class="bar bad" transition:fly={{ y: -12, duration: motion(200) }}>
        <span>{error ?? "The token is wrong."}</span>
        <button class="btn small" onclick={forget}>Scan again</button>
      </div>
    {:else if link === "offline" || (link === "connecting" && trying !== null && tried.length > 0)}
      <!-- Item 154's page half: the address tried, the host, what next. -->
      <div class="bar" transition:fly={{ y: -12, duration: motion(200) }}>
        <span class="offline-line">
          {offlineLine(tried, trying, paired)}
          {#if trying === null}Messages you send are held.{/if}
        </span>
        {#if trying === null}<button class="btn small" onclick={retry}>Try again</button>{/if}
      </div>
    {/if}
    {#if trashed}
      <div class="bar" transition:fly={{ y: -12, duration: motion(200) }}>
        <span>“{trashed.label}” is in the trash.</span>
        <button class="btn small" onclick={undeleteChat}>Restore</button>
        <button class="icon-btn small" onclick={() => (trashed = null)} aria-label="Dismiss">{@render icon("x")}</button>
      </div>
    {/if}
    {#if error && link !== "off"}
      <div class="bar bad" transition:fly={{ y: -12, duration: motion(200) }}>
        <span class="bar-text">
          {error}
          {#if errorDetail}
            <button class="detail-btn" onclick={() => (showDetail = !showDetail)}>{showDetail ? "Hide details" : "Details"}</button>
            {#if showDetail}<span class="bar-detail">{errorDetail}</span>{/if}
          {/if}
        </span>
        <button class="icon-btn small" onclick={() => (error = null)} aria-label="Dismiss">{@render icon("x")}</button>
      </div>
    {/if}

    {#if paired.length > 0 && !drawer && !sheet}
      <!-- Wave 2C: a swipe right from the left edge opens the drawer. -->
      <div class="edge" use:drag={edgeDrag} aria-hidden="true"></div>
    {/if}
    <main class="chat" bind:this={scroller} use:pull={{ where: "chat", fn: pullChat }}>
      <!-- 300 A6: the transcript moves down with the finger and the
           spinner sits in the gap it opens (iOS's own pull, `inferred`),
           then the gap closes and nothing is left under the bar. -->
      <div class="pull-gap" class:held={pullWhere === "chat" && pullBy > 0} style:height="{pullGap}px" aria-live="polite">
        {#if pullGap > 0}
          <span class="pull-ring" class:ready={pullBy >= PULL_AT} class:spin={refreshing} style:opacity={Math.min(pullGap / 36, 1)} style:--turn={Math.min(pullBy / PULL_AT, 1)}></span>
          <span class="sr-only">{refreshing ? "Refreshing…" : pullBy >= PULL_AT ? "Release to refresh" : "Pull to refresh"}</span>
        {/if}
      </div>
      {#if waitingIn}
        {@const label = (chatsBy[activePid] ?? []).find((c) => c.id === waitingIn)?.label}
        {@const go = waitingIn}
        <button class="wait-bar" transition:fly={{ y: -8, duration: motion(180) }} onclick={() => void openChat(go)}>
          <span class="dot run"></span>
          <span class="wait-text">{label ? `“${label}”` : "Another chat"} is waiting for your approval</span>
          <b>Open</b>
        </button>
      {/if}
      {#if chatId === null && rows.length === 0 && !liveHere}
        <!-- 300 A17: a greeting, not a letter tile that read as a broken
             avatar (the Claude app's empty chat, `inferred`). -->
        {@const hour = new Date(now).getHours()}
        <div class="hello" in:fade={{ duration: motion(200) }}>
          <div class="hello-title">How can I help you this {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}?</div>
          <button class="chip" onclick={() => (sheet = "project")}>
            in <b>{projectName(newProject)}</b>
            {@render icon("chev")}
          </button>
          <p class="hello-note">Your first message starts the chat on {active === "away" ? "Away" : "the Mac"}.</p>
        </div>
      {/if}
      {#each rows as r, i (i)}
        {#if r.kind === "user"}
          <div class="turn user" data-row={i} class:enter={i >= enterFrom && !still} class:removed={r.removed} use:arrive={{ channel: "phone" }}>
            <div class="bubble" use:press={() => openMenu(r)}>
              {#if r.images > 0}<span class="pics">{r.images} photo{r.images === 1 ? "" : "s"}</span>{/if}{r.text}
            </div>
            <div class="stamp">
              {#if r.removed}{"removed from the context · "}{:else if r.edited}{"edited · "}{/if}{shortWhen(r.at)}
            </div>
          </div>
        {:else if r.kind === "assistant"}
          <div class="turn reply" data-row={i} class:enter={i >= enterFrom && !still} class:removed={r.removed} use:press={() => openMenu(r)}>
            <!-- 300 A2: words and calls in the order they happened. -->
            {#each r.seq as s, k (s.kind === "text" ? `${s.part.index}.${s.part.block}` : `t${k}.${s.tools[0]?.id}`)}
              {#if s.kind === "tools"}{@render toolBox(s.tools, `r${i}.${k}`, false, r)}
              {:else if s.part.removed}
                <div class="part-gone" use:press={() => openMenu(r, s.part)}>[text removed]</div>
              {:else if s.part.text}
                <div class="md" use:press={() => openMenu(r, s.part)} use:codeBlocks={copy}>{@html renderMarkdown(s.part.text, { breaks: true })}</div>
              {/if}
            {/each}
            {#if r.removed}<div class="stamp">removed from the context — long-press to restore</div>
            {:else}{@const line = replyLine(events, r, sizes)}{#if line}<div class="stamp reply-line">{line}</div>{/if}{/if}
          </div>
        {:else}
          <div class="turn note" data-row={i}>{r.text}</div>
        {/if}
      {/each}
      {#if liveHere && live}
        <div class="turn reply live" class:enter={!still}>
          {#each liveSegments(live) as s, k (k)}
            {#if s.kind === "tools"}{@render toolBox(s.tools, `live${k}`, true)}
            {:else}<div class="md" use:codeBlocks={copy}>{@html renderMarkdown(s.text, { breaks: true })}</div>{/if}
          {/each}
          {#if !live.text && live.tools.length === 0}<span class="thinking"><i></i><i></i><i></i></span>{/if}
        </div>
      {:else if busyHere}
        <div class="turn note">A turn is running on {hostWord}</div>
      {/if}

      {#if limitHere}
        <!-- Item 164 on the phone: the turn the usage limit paused. -->
        {@const lc = limitCard(limitHere, now)}
        {@const set = (chatId ? limitSet[chatId] : undefined) ?? resetMs(limitHere.resume_at) ?? undefined}
        <section class="card" data-card="limit" in:fly={{ y: 16, duration: motion(260), easing: cubicOut }}>
          <div class="card-head">{lc.label}</div>
          {#if set}
            <p class="card-note">Resume is set on the {chatRole === "away" ? "away server" : "Mac"} for {clock12(set)} — it goes then, never sooner.</p>
          {:else if lc.early}
            <p class="card-note">Resume now and it waits on the {chatRole === "away" ? "away server" : "Mac"} until the window opens.</p>
          {/if}
          {#if opMissing("resume_limit", "This Mac's Nightloom is older than the phone page: press Resume on the Mac.")}
            <p class="card-note">{opMissing("resume_limit", "This Mac's Nightloom is older than the phone page: press Resume on the Mac.")}</p>
          {/if}
          <div class="actions end">
            <button class="btn accent" data-act="resume" disabled={!opOk("resume_limit") || !!set || limitBusy || link !== "online"} onclick={resumeLimit}>
              {set ? `Set for ${clock12(set)}` : lc.button}
            </button>
          </div>
        </section>
      {/if}
      {#if heldHere}
        <!-- The Mac's stop card (backlog 189) on the phone: a call is held
             at the stop line for his answer. -->
        {@const bc = budgetCard(heldHere, now)}
        <section class="card" data-card="budget" in:fly={{ y: 16, duration: motion(260), easing: cubicOut }}>
          <div class="card-head">{bc.title}</div>
          {#if bc.detail}<p class="card-note">{bc.detail}</p>{/if}
          <p class="card-note">A call is waiting for your answer. Continue lets this chat run past the line while you are here; Wrap up has it finish and write its hand-off; Stop refuses the call.</p>
          {#if opMissing("budget", "This Mac's Nightloom is older than the phone page: answer on the Mac.")}
            <p class="card-note">{opMissing("budget", "This Mac's Nightloom is older than the phone page: answer on the Mac.")}</p>
          {/if}
          <div class="actions">
            <button class="btn" data-act="budget-stop" disabled={!opOk("budget") || budgetBusy} onclick={() => answerBudget("stop")}>Stop here</button>
            <button class="btn" data-act="budget-wrap" disabled={!opOk("budget") || budgetBusy} onclick={() => answerBudget("wrap")}>Wrap up</button>
            <button class="btn accent" data-act="budget-continue" disabled={!opOk("budget") || budgetBusy} onclick={() => answerBudget("continue")}>Continue anyway</button>
          </div>
        </section>
      {/if}
      {#if otherWaiting}
        <div class="turn note">{chatRole === "away" ? "The away server" : "The Mac"} may be waiting for you in another chat — open it from the drawer.</div>
      {/if}
      {#each pendingHere as req (req.id)}
        {@const kind = cardKind(req)}
        <section class="card" data-approval={req.id} in:fly={{ y: 16, duration: motion(260), easing: cubicOut }}>
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
      {#if toast && toastChat}
        {@const go = toastChat}
        <button class="toast toast-go" transition:fly={{ y: 8, duration: motion(180) }} onclick={() => ((toast = null), void openChat(go))}>{toast} ›</button>
      {:else if toast}<div class="toast" transition:fly={{ y: 8, duration: motion(180) }}>{toast}</div>{/if}
      {#if queue.length > 0}
        <div class="queue">
          {#each queue as q (q.id)}
            <div class="held" class:failed={!!q.failed} transition:fly={{ y: 8, duration: motion(180) }}>
              <span class="held-text">{q.text}</span>
              {#if heldAsk === q.id}
                <span class="held-ask">
                  <button class="btn small" onclick={() => void editHeldInItsChat(q.id)}>Edit in its chat</button>
                  <button class="btn small danger" onclick={() => discardHeld(q.id)}>Discard</button>
                  <button class="btn small" onclick={() => (heldAsk = null)}>Keep</button>
                </span>
              {:else if q.failed}
                <span class="held-meta" title={q.failed}>Couldn't send</span>
                <button class="btn small" onclick={() => retryHeld(q.id)}>Retry</button>
                <button class="icon-btn small" onclick={() => takeBack(q.id)} aria-label="Take it back">{@render icon("x")}</button>
              {:else}
                <span class="held-meta">{q.chat && q.chat !== chatId ? "another chat · " : ""}held</span>
                <button class="icon-btn small" onclick={() => takeBack(q.id)} aria-label={q.chat === chatId ? "Take back into the composer" : "Edit or discard"}>{@render icon("x")}</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      {#if readOnly}
        <div class="readonly">
          This chat is in <b>{projectName(chatProject)}</b>; the Mac has <b>{remote.project ?? "Unfiled"}</b> open. Read it here, or start a new chat in {projectName(chatProject)}.
          {#if !unaddressable}<button class="btn small" onclick={() => startNew(chatProject)}>New chat there</button>{/if}
        </div>
      {:else}
        {#if photos.length > 0}
          <div class="photos">
            {#each photos as p (p.id)}
              <div class="photo">
                {#if p.doc}
                  <span class="photo-file"><b>{badgeOf({ kind: "document", ...p.doc })}</b>{p.doc.name}</span>
                {:else}
                  <img src={p.url} alt="" />
                {/if}
                <button class="photo-x" onclick={() => (photos = photos.filter((q) => q.id !== p.id))} aria-label="Remove the photo">{@render icon("x")}</button>
              </div>
            {/each}
          </div>
        {/if}
        <div class="composer">
          <input bind:this={picker} class="picker" type="file" accept={canFile ? "*/*" : "image/*"} multiple onchange={(e) => void addPhotos(e.currentTarget.files)} />
          {#if canPhoto}
            <button class="attach" onclick={() => picker?.click()} aria-label="Attach a photo">{@render icon("plus")}</button>
          {/if}
          <textarea
            data-kept
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
          <!-- Voice (item 246 wave 3B, its patch note): the orb, or keyboard
               dictation with auto-send; shown while the box is empty. -->
          <MicButton
            token={micToken}
            chat={chatId}
            {title}
            voice={remote.voice ?? null}
            {draft}
            {box}
            {still}
            send={() => void sendNow()}
            onkeep={(t) => setDraft(draft.trim() ? `${draft}\n${t}` : t)}
            reply={lastReply}
          />
          {#if busyHere && link === "online" && !draft.trim()}
            <button class="send stop" onclick={stop} aria-label="Stop the turn">{@render icon("stop")}</button>
          {:else}
            <button class="send" disabled={!draft.trim()} onclick={sendNow} aria-label={link === "online" && !remote.busy ? "Send" : `Hold until ${hostWord} is free`}>
              {@render icon("up")}
            </button>
          {/if}
        </div>
      {/if}
    </footer>

    <!-- Item 300 (A7, A8): the drawer stays in the page, painted, and slides
         as one layer: a finger moves it 1:1, letting go settles it. -->
    <div
      class="scrim drawer-scrim"
      class:shown={drawerShown}
      class:dragging={dragX !== null}
      class:still
      style:opacity={drawerOpenness}
      onclick={() => (drawer = false)}
      role="presentation"
    ></div>
    <nav
      class="drawer"
      class:dragging={dragX !== null}
      class:closed={!drawerShown}
      class:still
      style:transform={dragX !== null ? `translate3d(${dragX}px, 0, 0)` : drawer ? "translate3d(0, 0, 0)" : null}
      bind:offsetWidth={drawerW}
      inert={!drawerShown}
      aria-label="Chats"
      aria-hidden={!drawerShown}
      use:drag={drawerDrag}
    >
        <div class="drawer-head">
          <span class="drawer-title">Nightloom</span>
          <button class="icon-btn" onclick={() => (drawer = false)} aria-label="Close">{@render icon("x")}</button>
        </div>
        <label class="search">
          {@render icon("search")}
          <input
            type="search"
            placeholder={hasFeature(remote, "search") ? "Search chats and notes" : "Search chats"}
            bind:value={search}
            oninput={searchTyped}
            autocomplete="off"
          />
          {#if search}<button class="icon-btn small" onclick={clearSearch} aria-label="Clear the search">{@render icon("x")}</button>{/if}
        </label>
        {#if searchOn}
          <div class="scopes" role="tablist" aria-label="Search in">
            {#each [["this", "This project"], ["all", "All chats"], ["notes", "Notes"]] as [k, label] (k)}
              <button role="tab" aria-selected={searchScope === k} class:on={searchScope === k} onclick={() => setSearchScope(k as SearchScope)}>{label}</button>
            {/each}
          </div>
        {:else}
          <button class="new-row" onclick={() => startNew(null)}>{@render icon("new")} New chat</button>
          {#if projects.length > 0 || hasFeature(remote, "projects")}
            <button class="new-row quiet" onclick={() => openProjects()}>{@render icon("folder")} Projects</button>
          {/if}
          {#if hasFeature(remote, "running")}
            <button class="new-row quiet" onclick={openRunning}>{@render icon("pulse")} Running tasks</button>
          {/if}
          {#if hasFeature(remote, "notes")}
            <button class="new-row quiet" onclick={() => openNotes()}>{@render icon("note")} Notes</button>
          {/if}
          {#if hasFeature(remote, "nightshift")}
            <button class="new-row quiet" onclick={openNightshift}>{@render icon("moon")} Nightshift</button>
          {/if}
          {#if hasFeature(remote, "dream")}
            <button class="new-row quiet" onclick={() => startPass("dream")}>{@render icon("pulse")} Dream</button>
          {/if}
          {#if hasFeature(remote, "capture")}
            <button class="new-row quiet" onclick={() => startPass("capture")}>{@render icon("pulse")} Capture</button>
          {/if}
        {/if}
        {#if searchOn}
          <div class="drawer-list found">
            {#if searchProblem}
              <p class="empty">{searchProblem}</p>
            {:else if !found}
              <p class="empty">Searching…</p>
            {:else}
              <p class="found-sum">{searchSummary(found)}{searching ? " · searching…" : ""}</p>
              {#each found.groups as g (g.id)}
                <button class="hit" onclick={() => ((search = ""), (found = null), void openChat(g.id, g.project?.id ?? null))}>
                  <span class="hit-head">
                    <span class="chat-label">{searchGroupLabel(g)}</span>
                    {#if g.project && g.project.id !== UNFILED}<span class="tag">{g.project.name}</span>{/if}
                  </span>
                  {#each g.rows.slice(0, 2) as h (h.index)}
                    <span class="hit-row">{h.before}<mark>{h.matched}</mark>{h.after}</span>
                  {/each}
                  {#if g.hits > 2}<span class="hit-more">{g.hits} matches</span>{/if}
                </button>
              {/each}
              {#each found.notes as n (`${n.scope}/${n.name}`)}
                <button class="hit" onclick={() => openNotes({ scope: n.scope as NoteScope, name: n.name })}>
                  <span class="hit-head">
                    {@render icon("note")}
                    <span class="chat-label">{n.name.replace(/\.md$/i, "")}</span>
                    <span class="tag">{n.scope === "knowledge" ? "vault" : "note"}</span>
                  </span>
                  {#each n.rows.slice(0, 2) as h (h.line)}
                    <span class="hit-row">{h.before}<mark>{h.matched}</mark>{h.after}</span>
                  {/each}
                </button>
              {/each}
            {/if}
          </div>
        {:else}
        <div class="drawer-list" use:pull={{ where: "drawer", fn: pullDrawer }}>
          {#if pullWhere === "drawer" && (pullBy > 0 || refreshing)}
            <div class="pull">
              <span class="pull-pill" class:ready={pullBy >= PULL_AT} class:spin={refreshing} style:transform="translateY({refreshing ? PULL_AT * 0.6 : pullBy * 0.6}px)">
                {refreshing ? "Refreshing…" : pullBy >= PULL_AT ? "Release to refresh" : "Pull to refresh"}
              </span>
            </div>
          {/if}
          <p class="recents-head">Recents</p>
          {#each recents.filter((r) => matches(r.chat)) as r (r.pid + "/" + r.chat.id)}
            {@const here = r.chat.id === chatId && (chatProject ?? activePid) === r.pid}
            <button class="chat-row" class:here onclick={() => openChat(r.chat.id, r.pid || null)}>
              <span class="chat-label">{r.chat.label}</span>
              <span class="chat-meta">
                {#if r.pid === activePid && r.chat.id === remote.active_chat}<span class="live-dot" class:run={remote.busy}></span>{/if}
                <span>{shortWhen(chatWhen(r.chat))}{r.chat.mode !== "normal" ? ` · ${r.chat.mode}` : ""}</span>
                {#if r.project}<span class="tag">{r.project}</span>{/if}
              </span>
            </button>
          {:else}
            <p class="empty">{recentsRead ? (search ? "No chats match." : "No chats yet.") : "Loading…"}</p>
          {/each}
        </div>
        {/if}
        <UsageLine {usage} />
        <div class="drawer-foot">
          <span class="dot" class:ok={link === "online"} class:bad={link !== "online"}></span>
          {link === "online" ? `Connected to ${active ? hostName(active) : "the host"}${remote.engine ? ` · ${remote.engine === "claude-code" ? "Claude Code" : remote.engine}` : ""}` : status}
        </div>
      </nav>

    {#if projectsView}
      {#if projectsView.page === null}
        <ProjectsSheet
          projects={projectSummaries(projects, chatsBy)}
          canNew={hasFeature(remote, "projects")}
          onopen={(id) => (projectsView = { page: id })}
          onnew={() => ((projectsView = null), openNewProject())}
          onclose={() => (projectsView = null)}
        />
      {:else}
        {@const pid = projectsView.page}
        {@const p = projects.find((x) => x.id === pid)}
        {#key pid}
          <ProjectPage
            id={pid}
            name={p?.name ?? "Project"}
            chats={chatsBy[pid] ?? null}
            here={chatProject === pid || (chatProject === null && activePid === pid) ? chatId : null}
            instructions={hasFeature(remote, "notes") && (pid === activePid || hasFeature(remote, "notes_project")) ? () => {
                    // Read before the page closes: `pid` is derived from `projectsView`.
                    const id = pid;
                    projectsView = null;
                    openNotes({ scope: "instructions", name: "AGENTS.md" }, id);
                  } : null}
            onrename={projectOps?.renameProject ? (name) => renameProject(pid, name) : null}
            onforget={projectOps?.forgetProject ? () => forgetProject(pid) : null}
            onchat={(id) => openProjectChat(id, pid)}
            onnew={() => newChatIn(pid)}
            onback={() => (projectsView = { page: null })}
          />
        {/key}
      {/if}
    {/if}

    {#if contextOn && chatId && chatClient}
      {#key chatId}
        <ContextSheet
          api={chatClient}
          chat={chatId}
          project={chatProject}
          {title}
          engine={remote.engine}
          busy={busyHere}
          canLayers={hasFeature(remote, "layers")}
          host={remote.host}
          onclose={() => (contextOn = false)}
        />
      {/key}
    {/if}

    {#if sheet}
      <div class="scrim" transition:fade={{ duration: motion(200) }} onclick={closeSheet} role="presentation"></div>
      <div
        class="sheet"
        class:tall={sheetTall}
        class:dragging={sheetDy !== 0}
        style:transform={sheetDy ? `translateY(${sheetDy}px)` : null}
        transition:fly={{ y: 400, duration: motion(300), easing: cubicOut, opacity: 1 }}
        use:fitVisual
        role="dialog"
        aria-modal="true"
      >
        <!-- Wave 2C: drag the grabber down to dismiss (drafts are kept). -->
        <div class="grab" use:drag={sheetDrag}><div class="grabber"></div></div>
        {#if sheet === "chat"}
          <div class="sheet-title">{title}</div>
          <div class="sheet-sub">{chatSheetSub(projectName(chatProject), currentChat ? currentChat.user_turns : null, currentChat ? shortWhen(chatWhen(currentChat)) : null)}</div>
          <ChatMenu
            {icon}
            {readOnly}
            {canAct}
            {busyHere}
            blocked={actBlocked}
            newLabel={["No project", "Unfiled"].includes(projectName(chatProject)) ? "New chat" : `New chat in ${projectName(chatProject)}`}
            macRow={remote.host !== "serve"}
            macDisabled={remote.busy && chatId !== remote.active_chat}
            aside={hasFeature(remote, "aside")}
            asideTag={chatId && asides[chatId]?.state === "asking" ? "answering" : chatId && asides[chatId] ? "answered" : null}
            council={hasFeature(remote, "council")}
            kind={currentChat?.kind}
            compact={opOk("compact")}
            context={hasFeature(remote, "context")}
            onrail={openRail}
            onrename={beginRename}
            onmac={openOnMac}
            onnew={() => startNew(chatProject)}
            onaside={openAside}
            oncouncil={openCouncil}
            oncontinue={continueTurn}
            onkind={switchKind}
            oncompact={() => (sheet = "compact")}
            oncontext={() => (closeSheet(), (contextOn = true))}
            onstop={stop}
            ondelete={() => (sheet = "delete")}
          />
          {#if error}<p class="sheet-note bad">{error}</p>{:else if actBlocked && canAct}<p class="sheet-note">{actBlocked}</p>{/if}
        {:else if sheet === "rename"}
          <div class="sheet-title">Rename chat</div>
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" bind:value={renameText} autofocus onfocus={(e) => e.currentTarget.select()} onkeydown={(e) => e.key === "Enter" && void saveRename()} />
          <div class="actions end">
            <button class="btn" onclick={() => (sheet = "chat")}>Cancel</button>
            <button class="btn accent" disabled={!renameText.trim()} onclick={saveRename}>Save</button>
          </div>
        {:else if sheet === "compact"}
          <div class="sheet-title">Compact “{title}”?</div>
          <p class="sheet-note">The Mac summarises the earlier turns for the model, as its own Compact does; the log keeps every message.</p>
          <div class="actions end">
            <button class="btn" onclick={() => (sheet = "chat")}>Cancel</button>
            <button class="btn accent" data-act="compact-go" disabled={!!actBlocked} onclick={compactChat}>Compact</button>
          </div>
        {:else if sheet === "delete"}
          <div class="sheet-title">Delete “{title}”?</div>
          <p class="sheet-note">It moves to the trash; Restore brings it back.</p>
          <div class="actions end">
            <button class="btn" onclick={() => (sheet = "chat")}>Cancel</button>
            <button class="btn danger" onclick={deleteChat}>Move to trash</button>
          </div>
        {:else if sheet === "message" && menuOn && chatId}
          {@const target = rowTarget(events, menuOn.row)}
          <MessageMenu
            chat={chatId}
            row={menuOn.row}
            part={menuOn.part}
            tool={menuOn.tool}
            rewind={target.rewind}
            fork={target.fork}
            {canAct}
            host={(chatState ?? remote).host}
            checkpoint={opOk("checkpoint")}
            blocked={actBlocked}
            problem={error}
            onact={(actions, label, starts) => act(actions, label, starts)}
            oncopy={copy}
            onwhole={() => menuOn && (menuOn = { row: menuOn.row, part: null, tool: null })}
            onclose={() => ((sheet = null), (menuOn = null))}
          />
        {:else if sheet === "rail"}
          <RailSheet {rail} problem={railProblem} busy={remote.busy} onpatch={patchRail} />
        {:else if sheet === "notes" && client}
          <NotesSheet {client} where={hostName(active ?? "mac")} host={remote.host} available={hasFeature(remote, "notes")} start={notesStart} onnote={note} ontall={(t) => (sheetTall = t)} project={notesPid} projectLabel={notesPid === null ? null : notesPid === NO_PROJECT ? "No project" : (projects.find((x) => x.id === notesPid)?.name ?? null)} resume={notesResume} onview={(v) => (notesPlace = v)} />
        {:else if sheet === "nightshift" && client}
          <NightshiftSheet {client} host={remote.host} available={hasFeature(remote, "nightshift")} onnote={note} ontall={(t) => (sheetTall = t)} />
        {:else if sheet === "aside" && chatId}
          <AsideSheet
            chat={chatId}
            {title}
            available={hasFeature(remote, "aside")}
            host={remote.host}
            aside={asides[chatId] ?? null}
            past={asidePast}
            problem={asideProblem}
            onask={askAside}
            onstop={stopAside}
            oncopy={copy}
          />
        {:else if sheet === "council"}
          <CouncilSheet
            available={hasFeature(remote, "council") && chatId !== null}
            host={remote.host}
            initial={rail?.council ?? null}
            text={draft}
            blocked={link !== "online" ? "The Mac is unreachable." : busyHere ? "A turn is running in this chat — wait for it to end." : null}
            problem={councilProblem}
            onsend={sendCouncil}
          />
        {:else if sheet === "newproject"}
          <div class="sheet-title">New project</div>
          <p class="sheet-note">Made in {hostWord}'s projects folder.{remote.host !== "serve" ? " A different folder is chosen on the Mac." : ""}</p>
          <input
            type="text"
            placeholder="Name"
            data-kept
            bind:value={projName}
            oninput={() => saveDraft("newproject:name", projName)}
            onkeydown={(e) => e.key === "Enter" && void createProject()}
          />
          <textarea
            class="proj-inst"
            data-kept
            rows="4"
            placeholder="Instructions for its chats (optional)"
            bind:value={projInstructions}
            oninput={() => saveDraft("newproject:instructions", projInstructions)}
          ></textarea>
          {#if projProblem}<p class="sheet-note bad">{projProblem}</p>{/if}
          <div class="actions end">
            <button class="btn" onclick={closeSheet}>Cancel</button>
            <button class="btn accent" disabled={!projName.trim() || projBusy} onclick={createProject}>Create</button>
          </div>
        {:else if sheet === "hosts"}
          <Hosts
            mode="sheet"
            {hosts}
            {active}
            {link}
            {tried}
            {origin}
            onpair={(role, entry) => pairHost(role, entry)}
            onforget={forgetRole}
            onretry={() => {
              sheet = null;
              retry();
            }}
          />
        {:else if sheet === "running"}
          <RunningSheet
            {running}
            problem={runningProblem}
            onrefresh={refreshRunning}
            where={hostName(active ?? "mac")}
            onopen={(id, project) => ((sheet = null), void openChat(id, project ?? projectOf(id)))}
          />
        {:else}
          <div class="sheet-title">Start the chat in</div>
          <div class="menu">
            {#each projects as p (p.id)}
              <button onclick={() => chooseProject(p.id)}>
                <span class="grow">{p.name}</span>
                {#if (newProject ?? activePid) === p.id}{@render icon("check")}{/if}
              </button>
            {:else}
              <p class="empty">Only the open project ({remote.project ?? "Unfiled"}) is known.</p>
            {/each}
          </div>
          {#if newProject}<p class="sheet-note">The chat starts in {projectName(newProject)}.</p>{/if}
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* The desktop's palette A (app.css), and a light counterpart for a phone
     in light mode (item 246, blocker 577's default). Wave 3 B2: the
     desktop's chosen palette (`/api/state.palette`) as `data-palette`, its
     dark tokens as app.css has them and a light counterpart of each; the
     phone's own light/dark decides which, as `data-scheme` (set from
     `prefers-color-scheme` in onMount — one attribute, so a palette's
     light block need not repeat inside a media query). */
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
  /* B–D dark: app.css's surfaces and accent; status colours are shared. */
  :global(:root[data-palette="B"]) {
    --paper: #15181d;
    --sheet: #1c2027;
    --well: #252a33;
    --ink: #e6e9ee;
    --ink2: #c0c6cf;
    --dim: #7f8794;
    --line: #2a3039;
    --line2: #3c434e;
    --accent: #d38b5d;
    --accent-ink: #e8a87c;
    --accent-soft: #3a2a1f;
    --on-accent: #15181d;
  }
  :global(:root[data-palette="C"]) {
    --paper: #131313;
    --sheet: #1b1b1b;
    --well: #242424;
    --ink: #e9e9e6;
    --ink2: #bebebb;
    --dim: #7e7e7a;
    --line: #2b2b2b;
    --line2: #3e3e3e;
    --accent: #5fc4c0;
    --accent-ink: #8fdcd8;
    --accent-soft: #193233;
    --on-accent: #131313;
  }
  :global(:root[data-palette="D"]) {
    --paper: #1a1412;
    --sheet: #221a17;
    --well: #2c2320;
    --ink: #f0e6dc;
    --ink2: #cbbfb3;
    --dim: #9a8b80;
    --line: #352a26;
    --line2: #4a3b35;
    --accent: #d4a24c;
    --accent-ink: #e8bd6e;
    --accent-soft: #3c2e17;
    --on-accent: #1a1412;
  }
  :global(:root[data-scheme="light"]) {
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
  /* Light counterparts (inferred, after 577's A: paper and ink stay warm-
     neutral per palette, the accent darkened to read on paper). */
  :global(:root[data-scheme="light"][data-palette="B"]) {
    --paper: #f3f5f8;
    --sheet: #fcfdfe;
    --well: #e6eaf0;
    --ink: #1f242c;
    --ink2: #3e4652;
    --dim: #6f7885;
    --line: #dde2e9;
    --line2: #c5ccd6;
    --accent: #b0663a;
    --accent-ink: #934f28;
    --accent-soft: #f2e1d5;
    --on-accent: #fcfdfe;
    --bubble: color-mix(in srgb, var(--paper) 80%, var(--ink) 8%);
  }
  :global(:root[data-scheme="light"][data-palette="C"]) {
    --paper: #f5f5f3;
    --sheet: #fdfdfc;
    --well: #e8e8e5;
    --ink: #1f1f1e;
    --ink2: #40403e;
    --dim: #767673;
    --line: #e0e0dc;
    --line2: #c9c9c4;
    --accent: #23807c;
    --accent-ink: #1a6662;
    --accent-soft: #d6ecea;
    --on-accent: #fdfdfc;
    --bubble: color-mix(in srgb, var(--paper) 80%, var(--ink) 8%);
  }
  :global(:root[data-scheme="light"][data-palette="D"]) {
    --paper: #f7f0e8;
    --sheet: #fffaf4;
    --well: #ece2d6;
    --ink: #2b211d;
    --ink2: #4d4039;
    --dim: #87786d;
    --line: #e6dacd;
    --line2: #d2c3b3;
    --accent: #a87a22;
    --accent-ink: #8a6219;
    --accent-soft: #f3e6c9;
    --on-accent: #fffaf4;
    --bubble: color-mix(in srgb, var(--paper) 80%, var(--ink) 8%);
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
    /* 300 A15: sized and placed to the visible part of the screen
       (viewport.ts sets --vvh/--vvtop), so the keyboard never pans the
       header off; without the variables, the screen's height as before. */
    position: fixed;
    left: 0;
    right: 0;
    top: var(--vvtop, 0px);
    height: var(--vvh, 100dvh);
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
  .gate-mark {
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
  /* 300 A35: a flex row cannot ellipsize its bare text; this span can. */
  .sub-text {
    min-width: 0;
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
  /* Item 300 (A14): the plain line, the host's sentence behind a tap. */
  .bar .bar-detail {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    opacity: 0.8;
    overflow-wrap: anywhere;
  }
  .detail-btn {
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 13px;
    text-decoration: underline;
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
  /* 300 A1: an Agent card's subagent steps, folded; tap to open. */
  .steps-toggle {
    all: unset;
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-height: 32px;
    padding: 0 2px 0 8px;
    color: var(--accent-ink);
    font-size: 12px;
    cursor: pointer;
  }
  .steps-toggle .ico {
    width: 14px;
    height: 14px;
    transition: transform 0.15s;
  }
  .steps-toggle[aria-expanded="true"] .ico {
    transform: rotate(90deg);
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 0 6px 10px;
    border-left: 2px solid var(--line2);
    font-size: 12px;
    min-width: 0;
  }
  .step-call,
  .step-out {
    font-family: var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .step-call b {
    font-family: var(--sans);
    color: var(--ink);
  }
  .step-out {
    color: var(--dim);
  }
  .step-said {
    color: var(--ink2);
    overflow-wrap: break-word;
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
    /* 300 A24: a table scrolls sideways in its own box; its words never
       break mid-word ("Colum / n A"), which `.turn`'s anywhere-wrap did. */
    overflow-wrap: normal;
    word-break: normal;
  }
  .md :global(th) {
    background: var(--sheet);
    font-weight: 600;
    white-space: nowrap;
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
  /* 300 A24: a code block's header (language, Copy) and a fade at the
     right edge while it has more to scroll to (codeBlocks.ts). */
  .md :global(.code-box) {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--sheet);
    margin: 0 0 0.7em;
    overflow: hidden;
  }
  .md :global(.code-head) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 0 12px;
    font-size: 12px;
    color: var(--dim);
    border-bottom: 1px solid var(--line);
    background: var(--well);
  }
  .md :global(.code-copy) {
    all: unset;
    cursor: pointer;
    min-height: 36px;
    padding: 0 10px;
    color: var(--accent-ink);
    font-size: 13px;
    font-weight: 500;
  }
  .md :global(.code-body) {
    position: relative;
  }
  .md :global(.code-body pre) {
    margin: 0;
    border: 0;
    border-radius: 0;
    overflow-wrap: normal;
    -webkit-overflow-scrolling: touch;
  }
  .md :global(.code-body.more)::after {
    content: "";
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 28px;
    pointer-events: none;
    background: linear-gradient(to right, transparent, var(--sheet));
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
  .card-note {
    margin: -4px 0 0;
    font-size: 14px;
    color: var(--ink2);
  }
  .reply-line {
    margin-top: 2px;
    font-family: var(--mono);
    font-size: 11px;
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
  /* The keyboard covers the home indicator: no safe-area gap above it. */
  :global(html[data-kb]) .dock {
    padding-bottom: 8px;
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
  .toast-go {
    border: 0;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
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
  /* Item 300 (A30, A36): a refused held message, and the ✕'s question. */
  .held.failed .held-meta {
    color: var(--failed);
  }
  .held-ask {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
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
  .composer .attach + textarea {
    padding-left: 4px;
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
    /* Item 300 (A7, A8): one composited layer, kept painted; closed it sits
       off screen (its shadow too) and hides once it has slid away. */
    transform: translate3d(calc(-100% - 48px), 0, 0);
    will-change: transform;
    backface-visibility: hidden;
    -webkit-backface-visibility: hidden;
    transition:
      transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
      visibility 0s;
  }
  .drawer.closed {
    visibility: hidden;
    transition:
      transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
      visibility 0s linear 0.32s;
  }
  .drawer.still,
  .drawer-scrim.still,
  .drawer-scrim.dragging {
    transition: none;
  }
  /* Hidden (not only transparent) once faded: Safari tints its status bar
     from fixed layers at the top, an invisible scrim included (A38's band). */
  .drawer-scrim {
    pointer-events: none;
    visibility: hidden;
    transition:
      opacity 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
      visibility 0s linear 0.32s;
  }
  .drawer-scrim.shown {
    pointer-events: auto;
    visibility: visible;
    transition:
      opacity 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
      visibility 0s;
  }
  /* The row under a dragging finger is not being pressed. */
  .drawer.dragging .chat-row:active,
  .drawer.dragging .new-row:active {
    background: transparent;
  }
  .recents-head {
    margin: 4px 0 2px;
    padding: 0 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--dim);
  }
  .chat-meta .tag {
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .menu button:active:not(:disabled) {
    background: var(--well);
  }
  .drawer-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px 12px;
    /* A5: a line where the list meets the fixed rows above it. */
    border-top: 1px solid var(--line);
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
    /* 300 F4 (A10, A22): lifted over the keyboard and capped at what the
       phone shows (sheetLayout.ts fitVisual), below the status bar. */
    bottom: var(--sheet-lift, 0px);
    z-index: 12;
    background: var(--sheet);
    border-radius: 22px 22px 0 0;
    padding: 8px 16px calc(16px + var(--sheet-kb, 0px) + env(safe-area-inset-bottom, 0px));
    display: flex;
    flex-direction: column;
    gap: 10px;
    --sheet-cap: calc(var(--sheet-vh, 100dvh) - env(safe-area-inset-top, 0px) - 8px);
    max-height: min(80dvh, var(--sheet-cap));
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
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
    /* 300 F4 (A10): never shrunk by the sheet's max-height — that clipped
       its last rows (Delete) out of reach; the sheet scrolls instead. */
    flex: none;
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
  .menu .grow {
    flex: 1;
  }
  .menu .ico {
    color: var(--ink2);
  }

  /* ---- wave 1C: long-press, removed turns, photos ---- */
  /* A long-press opens the message menu (Copy is in it), so the phone's
     own text selection and callout stay off the turns (blocker 690). */
  .turn.user .bubble,
  .turn.reply {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .turn.removed .bubble,
  .turn.reply.removed .md {
    opacity: 0.5;
  }
  .turn.removed .bubble {
    border: 1.5px dashed var(--line2);
  }
  .sheet-note.bad {
    color: var(--failed);
    margin: 0;
  }
  .part-gone,
  .tool.removed {
    color: var(--dim);
    font-size: 13px;
    font-style: italic;
  }
  .tool.removed .tool-sum {
    text-decoration: line-through;
  }
  .pics {
    display: block;
    font-size: 12px;
    color: var(--dim);
  }
  .new-row.quiet {
    color: var(--ink2);
    font-weight: 400;
  }

  /* ---- wave 2C: gestures, search, the new project sheet ---- */
  /* The strip a swipe right starts on: under the top bar, above the dock,
     narrower than the chat's own padding so it covers nothing tappable. */
  .edge {
    position: fixed;
    left: 0;
    top: calc(64px + env(safe-area-inset-top, 0px));
    bottom: calc(96px + env(safe-area-inset-bottom, 0px));
    /* Item 300 (A8): as wide as client.ts EDGE, so a thumb a little in from
       Safari's own back-swipe strip still catches the drawer. */
    width: 32px;
    z-index: 5;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  /* Item 300 (A9): a long press on the chat's empty area, the bars or the
     drawer starts no page-wide selection or magnifier; the message menu
     (long-press a turn) has Copy, and fields stay selectable. */
  .page,
  .drawer {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .page :global(input),
  .page :global(textarea),
  .page :global([contenteditable="true"]) {
    -webkit-user-select: text;
    user-select: text;
    -webkit-touch-callout: default;
  }
  .drawer {
    touch-action: pan-y;
  }
  .drawer.dragging,
  .sheet.dragging {
    transition: none;
  }
  .grab {
    margin: -8px -16px 0;
    padding: 8px 0 8px;
    touch-action: none;
    cursor: grab;
    flex: none;
  }
  .grab .grabber {
    margin: 0 auto;
  }
  .sheet.tall {
    max-height: min(94dvh, var(--sheet-cap));
  }
  .sheet > .sheet-title,
  .sheet > .sheet-sub,
  .sheet > .sheet-note,
  .sheet > .actions {
    flex: none;
  }
  .pull {
    position: sticky;
    top: 0;
    height: 0;
    margin-bottom: -18px;
    display: flex;
    justify-content: center;
    z-index: 2;
    overflow: visible;
  }
  .drawer-list .pull {
    margin-bottom: 0;
  }
  /* 300 A6: the chat's pull — a gap above the first message, as tall as
     the pull, with a ring that fills as he pulls and spins while it
     refreshes. -18px cancels the column's gap, so at rest it is nothing. */
  /* 300 A27: another chat's turn waits on his answer. */
  .wait-bar {
    all: unset;
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 14px;
    border-radius: 14px;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: var(--ink);
    font-size: 14px;
    cursor: pointer;
    box-sizing: border-box;
  }
  .wait-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wait-bar b {
    color: var(--accent-ink);
  }
  .pull-gap {
    flex: none;
    margin-bottom: -18px;
    display: grid;
    place-items: center;
    overflow: hidden;
    transition: height 0.25s var(--ease);
  }
  .pull-gap.held {
    transition: none;
  }
  .pull-ring {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: conic-gradient(var(--dim) calc(var(--turn, 0) * 360deg), transparent 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2.5px));
  }
  .pull-ring.ready {
    background: var(--accent);
  }
  .pull-ring.spin {
    background: conic-gradient(var(--accent) 0 270deg, transparent 0);
    animation: pull-spin 0.8s linear infinite;
  }
  @keyframes pull-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .pull-pill {
    display: inline-block;
    margin-top: -32px;
    padding: 6px 14px;
    border-radius: 999px;
    background: var(--sheet);
    border: 1px solid var(--line);
    color: var(--dim);
    font-size: 13px;
    white-space: nowrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }
  .pull-pill.ready,
  .pull-pill.spin {
    color: var(--accent-ink);
    border-color: var(--accent);
  }
  .scopes {
    display: flex;
    gap: 6px;
    margin: 0 14px 6px;
  }
  .scopes button {
    all: unset;
    cursor: pointer;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid var(--line2);
    font-size: 13px;
    color: var(--ink2);
  }
  .scopes button.on {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .found-sum {
    font-size: 12px;
    color: var(--dim);
    margin: 2px 10px 6px;
  }
  .hit {
    all: unset;
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    box-sizing: border-box;
    padding: 10px;
    border-radius: 12px;
    cursor: pointer;
  }
  .hit:active {
    background: var(--well);
  }
  .hit-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .hit-head .chat-label {
    flex: 1;
    min-width: 0;
  }
  .hit-head .ico {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .hit-row {
    font-size: 13px;
    color: var(--dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hit-row mark {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-radius: 3px;
    padding: 0 1px;
  }
  .hit-more {
    font-size: 11px;
    color: var(--dim);
  }
  .proj-inst {
    resize: none;
  }
  /* The field's own clear button would sit beside the page's. */
  .search input::-webkit-search-cancel-button {
    -webkit-appearance: none;
    appearance: none;
  }

  .picker {
    display: none;
  }
  .attach {
    all: unset;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--ink2);
    cursor: pointer;
    margin: 1px 0 1px 2px;
  }
  .attach:active {
    background: var(--well);
  }
  .photos {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 0 2px 8px;
  }
  .photo {
    position: relative;
    flex: none;
  }
  .photo img {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 12px;
    display: block;
    border: 1px solid var(--line);
  }
  /* A file in the composer (item 277): its badge over its name. */
  .photo-file {
    width: 64px;
    height: 64px;
    box-sizing: border-box;
    padding: 6px;
    border-radius: 12px;
    border: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 10px;
    overflow: hidden;
    word-break: break-all;
  }
  .photo-file b {
    font-size: 9px;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }
  .photo-x {
    all: unset;
    position: absolute;
    top: -6px;
    right: -6px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--ink);
    color: var(--paper);
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .photo-x .ico {
    width: 14px;
    height: 14px;
    stroke-width: 2.4;
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
