<script lang="ts">
  /**
   * Home, the phone's first screen (nightshift item 763 H8; item 741's
   * screen). In design §7's order — the default until he picks a layout
   * (blocker 2084): the header ("Home · 3 need you · today 0.3% of the
   * week"), Needs you (each row with its buttons or its reply box),
   * today's scan (folded once read), Done since you looked (each row
   * opens its chat), Running (with context size), the Tell Home box and
   * the Jobs row, and Home on this Mac.
   *
   * Nothing typed here is lost (practices §7): the Tell Home box and each
   * reply box keep their text under the chat's own composer key on every
   * keystroke, so leaving Home, opening the chat, a reload or a refusal
   * leaves it; only a send that lands (or is held in the page's queue)
   * clears it. Its place — scroll and folds — is kept (`homeFirst.ts`).
   *
   * Variables only from the page's palettes (`--ink`, `--dim`, `--line`,
   * `--well`, `--raised`, `--accent`, `--accent-ink`), so it reads in
   * Jarvis and Classic, light and dark; `fil` adds Jarvis's mono heads.
   */
  import StartCard from "../lib/StartCard.svelte";
  import RouteHeld from "../lib/RouteHeld.svelte";
  import { pruneRouteDrafts, readRouteDrafts, routeText, withRouteDraft, type HomeRoute, type RoutePick } from "../lib/homeRoutes";
  import { onDestroy, onMount, tick, type Component } from "svelte";
  import { renderMarkdown } from "../lib/markdown";
  // Item 991: a skip an older build wrote says so; Home's one-line rows drop markdown marks (plainLine).
  import { skipWhy } from "../lib/skipWhy";
  import { plainLine } from "../lib/homeStage/steps";
  import {
    ApiError,
    Unreachable,
    SEND_DEADLINE_MS,
    cardKind,
    clock12,
    loadDraft,
    newNonce,
    saveDraft,
    shortWhen,
    toolSummary,
    type Client,
    type HeldBlockerWire,
    type HomeFeedWire,
    type HomeScanWire,
    type HomeTodayWire,
    type PushFeedWire,
    type RemoteState,
    type Running,
  } from "./client";
  import { answerPatch, confirmPatch, type Answer, type Job } from "./jobs";
  import JobApproval from "./JobApproval.svelte";
  import JobRunConfirm from "./JobRunConfirm.svelte";
  import BlockerAnswer from "./BlockerAnswer.svelte";
  import { handledRows, pruneMarked, unseenWords } from "../lib/homeStage/watch";
  import { NightshiftClient, type NsBlocker } from "./nightshiftClient";
  import {
    asOfWords,
    doneMark,
    headerWords,
    homeDraftKey,
    homeTarget,
    isFolded,
    jobsWords,
    loadHomeKept,
    markScanRead,
    needRows,
    newsRows,
    heldWords,
    needTotal,
    proposalWords,
    runningLine,
    saveHomeKept,
    scanText,
    scanBody,
    scanWhen,
    stopWords,
    setFold,
    withScroll,
    type HomeSection,
    type NeedRow,
  } from "./homeFirst";
  import type { HostRole } from "./hosts";
  import HomeStage from "./HomeStage.svelte";

  interface Props {
    client: Client;
    /** The host answering now. */
    active: HostRole;
    /** The Mac is paired (so the away server answering means the Mac is not). */
    macPaired: boolean;
    remote: RemoteState;
    /** The open chat's name, for its own approvals. */
    openLabel: string | null;
    /** Jarvis (the Filament look) — mono section heads. */
    fil: boolean;
    /** The chat he left, for one tap back to it. */
    resume: { chat: string; project: string | null; label: string | null } | null;
    /** Bumped by the page when the host says something changed. */
    tick?: number;
    onopen: (chat: string, project: string | null) => void;
    onjobs: () => void;
    ondrawer: () => void;
    onnew: () => void;
    /** Hold a message the host could not take (the page's own queue). */
    onhold: (chat: string, text: string, project: string | null, nonce: string) => void;
    /** Messages held in the page's queue (they go when their host answers). */
    queued?: number;
  }
  let { client, active, macPaired, remote, openLabel, fil, resume, tick: bump = 0, onopen, onjobs, ondrawer, onnew, onhold, queued = 0 }: Props = $props();

  // Home covers the page's dock, so its notes show here.
  let msg = $state<string | null>(null);
  /** Item 845: the stage's Watching tab is in focus (Home's own sections show); a task's tab draws its view instead. */
  let watching = $state(true);
  function onnote(text: string) {
    msg = text;
    setTimeout(() => {
      if (msg === text) msg = null;
    }, 4000);
  }

  // ---- what Home reads ----
  let today = $state<HomeTodayWire | null>(null);
  let feed = $state<HomeFeedWire | null>(null);
  let scan = $state<HomeScanWire | null>(null);
  let scanLoaded = $state(false);
  let pushRows = $state<PushFeedWire[]>([]);
  let jobs = $state<Job[]>([]);
  let held = $state<HeldBlockerWire[]>([]);
  /** Item 995: pending proposals (counted, reviewed on the Mac). */
  let proposals = $state(0);
  // Item 763 H5: Start cards — his edits kept as drafts, a tap that could not go says why.
  let cards = $state<HomeRoute[]>([]);
  /** Routes waiting on something other than him (a closed project, a night run). */
  let heldRoutes = $state<HomeRoute[]>([]);
  let routeDrafts = $state(readRouteDrafts());
  let routeBusy = $state<string | null>(null);
  let routeProblems = $state<Record<string, string>>({});
  async function startCard(id: string, pick: RoutePick | null) {
    if (routeBusy) return;
    routeBusy = id;
    try {
      const after = await client.homeRouteStart(id, routeDrafts[id] ?? null, pick);
      routeDrafts = withRouteDraft(routeDrafts, id, null);
      onnote(after.state === "started" ? `Started in ${after.project_name}` : `Queued for ${after.project_name}${after.note ? ` — ${after.note}` : ""}`);
    } catch (e) {
      routeProblems = { ...routeProblems, [id]: e instanceof Unreachable ? "The host is not answering — nothing was started. Your edit is kept." : String(e instanceof Error ? e.message : e) };
    } finally {
      routeBusy = null;
      void load();
    }
  }
  async function dismissCard(id: string) {
    if (routeBusy) return;
    routeBusy = id;
    try {
      await client.homeRouteDismiss(id);
      routeDrafts = withRouteDraft(routeDrafts, id, null);
    } catch (e) {
      routeProblems = { ...routeProblems, [id]: e instanceof Unreachable ? "The host is not answering — the card is still here." : String(e instanceof Error ? e.message : e) };
    } finally {
      routeBusy = null;
      void load();
    }
  }
  let running = $state<Running | null>(null);
  /** Home's chat when the scan job has not named one: its project's newest. */
  let homeChat = $state<string | null>(null);
  let loading = $state(true);
  let problem = $state<string | null>(null);
  /** Item 947: Needs you has been read at least once (so "nothing needs you" is a fact, not a guess). */
  let needsRead = $state(false);

  const home = $derived.by(() => {
    const h = feed?.home ?? { project: null, chat: null };
    return { project: h.project, chat: h.chat ?? homeChat };
  });
  // Item 945: Nightshift's held blockers are not listed with the chats' rows — one folded line under the list.
  // Item 995: they are counted, with the proposals: `total` is the Mac pill's one number.
  const needs = $derived(needRows(pushRows, jobs, [], { chat: remote.active_chat, label: openLabel, pending: remote.pending.length }));
  const heldRows = $derived(needRows([], [], held, { chat: null, label: null, pending: 0 }));
  const total = $derived(needTotal({ needs: needs.length, cards: cards.length, held: heldRows.length, proposals }));
  const header = $derived(headerWords(total, today, needsRead));
  const headParts = $derived(header.split(" · "));
  const stop = $derived(stopWords(today));
  const fromAway = $derived(active === "away" && macPaired);
  const asOf = $derived(asOfWords(fromAway, feed?.as_of ?? null, (ms) => clock12(ms)));
  const scanJob = $derived(jobs.find((j) => j.id === "home-morning-scan") ?? null);
  const scanDate = $derived(scan?.date ?? null);

  /** Item 947: one read that did not come. */
  const FAIL = Symbol("fail");
  /** Item 947: a read that never answers is the host not answering (a phone on a bad network can wait a minute). */
  const LIMIT_MS = 25_000;
  async function timed<T>(p: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, no) => (t = setTimeout(() => no(new Unreachable("timed out")), LIMIT_MS)))]);
    } finally {
      clearTimeout(t);
    }
  }
  /** One read of Home. An older host without the route (404, 405, 501) is answered by `fallback`; a route that
   *  fails otherwise (500, 401, a body that is not JSON) is `FAIL`, so the page keeps what it last read instead of
   *  drawing "nothing needs you" from a read that never happened (item 947). */
  async function quiet<T>(p: Promise<T>, fallback: T): Promise<T | typeof FAIL> {
    try {
      return await timed(p);
    } catch (e) {
      if (e instanceof Unreachable) throw e;
      if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) return fallback;
      return FAIL;
    }
  }
  /** Item 947: the newest load that was applied; a slower, older read arriving later is dropped. */
  let loadSeq = 0;
  let appliedSeq = 0;

  async function load() {
    const c = client;
    const mine = ++loadSeq;
    const has = (f: string) => !remote.features || remote.features.includes(f);
    try {
      const [t, f, s, p, j, h, r, rt] = await Promise.all([
        quiet(c.homeToday(), null),
        quiet(c.homeFeed(), null),
        quiet(c.homeScan(), { scan: null }),
        has("push") ? quiet(c.pushFeed(), { rows: [] }) : Promise.resolve({ rows: [] }),
        has("jobs") ? quiet(c.jobs(), { jobs: [], now: "" }) : Promise.resolve({ jobs: [], now: "" }),
        quiet(c.homeHeld(), { blockers: [] }),
        has("running") ? quiet(c.running(), null) : Promise.resolve(null),
        quiet(c.homeRoutes(), null),
      ]);
      if (c !== client || mine < appliedSeq) return;
      appliedSeq = mine;
      const bad = [t, f, s, p, j, h, r, rt].some((v) => v === FAIL);
      if (t !== FAIL) today = t;
      if (f !== FAIL) feed = f;
      // Item 946: per-row marks the feed no longer holds, or that a "Mark all seen" (here or on the Mac) covered,
      // are let go, so the kept place does not grow for ever.
      if (f && f !== FAIL && f.rows?.length) {
        const pruned = pruneMarked(kept.marked, newsRows(f.rows), f.seen_at ?? null);
        if (pruned !== kept.marked) {
          kept = { ...kept, marked: pruned };
          saveHomeKept(kept);
        }
      }
      if (s !== FAIL) {
        scan = s.scan;
        scanLoaded = true;
      }
      if (p !== FAIL) {
        pushRows = p.rows;
        needsRead = true;
      }
      if (j !== FAIL) jobs = j.jobs;
      if (h !== FAIL) {
        held = h.blockers;
        proposals = h.proposals ?? 0;
      }
      if (rt && rt !== FAIL) {
        cards = rt.cards;
        heldRoutes = rt.held ?? [];
        routeDrafts = pruneRouteDrafts(routeDrafts, rt.cards);
      }
      if (r !== FAIL) running = r;
      problem = bad ? "Part of Home could not be read — it shows what it last read." : null;
      if (f && f !== FAIL && !f.home.chat && f.home.project) {
        const got = await quiet(c.chats(f.home.project), []);
        const rows = got === FAIL ? [] : got;
        homeChat = rows.length ? [...rows].sort((a, b) => Date.parse(b.last_message ?? b.modified) - Date.parse(a.last_message ?? a.modified))[0].id : null;
      }
    } catch (e) {
      problem = e instanceof Unreachable ? (needsRead ? "The host is not answering — Home shows what it last read." : "The host is not answering — Home has not read anything yet.") : String(e);
    } finally {
      loading = false;
    }
  }

  // ---- the place kept: scroll and folds ----
  // Item 944: whether Needs you has anything to draw, and whether the whole of Home's own column is empty.
  const anyNeeds = $derived(total + heldRoutes.length > 0);
  const bareHome = $derived(!anyNeeds && !scan && !(running?.chats.length));
  let kept = $state(loadHomeKept());
  // Item 946: the same feed as a notification list — every news row, the unseen ones marked.
  const handled = $derived(handledRows(newsRows(feed?.rows ?? []), feed?.seen_at ?? null, kept.marked));
  function toggleHandled() {
    kept = { ...kept, handledOpen: !kept.handledOpen };
    saveHomeKept(kept);
  }
  function markOne(key: string) {
    if (kept.marked[key]) return;
    kept = { ...kept, marked: { ...kept.marked, [key]: 1 } };
    saveHomeKept(kept);
  }
  let scroller = $state<HTMLElement | null>(null);
  let restored = false;
  /** The scan page this visit opened on: it stays open until he leaves,
   *  though it is marked read (so the next visit shows it folded). */
  let visitOpen = $state<string | null>(null);
  function folded(s: HomeSection): boolean {
    if (s === "scan" && scanDate && visitOpen === scanDate && !(kept.scanFoldFor === scanDate && kept.folds.scan !== undefined)) return false;
    return isFolded(kept, s, scanDate);
  }
  function fold(s: HomeSection) {
    kept = setFold(kept, s, !folded(s), scanDate);
    saveHomeKept(kept);
  }
  // The scan shown open is read: the next visit shows it folded.
  $effect(() => {
    const d = scanDate;
    if (!d || visitOpen === d || isFolded(kept, "scan", d)) return;
    visitOpen = d;
    kept = markScanRead(kept, d);
    saveHomeKept(kept);
  });
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  function onScroll() {
    if (!scroller || !restored) return;
    const at = scroller.scrollTop;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      kept = withScroll(kept, at);
      saveHomeKept(kept);
    }, 120);
  }
  async function restoreScroll() {
    await tick();
    if (scroller && kept.scroll > 0) scroller.scrollTop = kept.scroll;
    restored = true;
  }

  // ---- Needs you: answers ----
  let busyKey = $state<string | null>(null);
  let replies = $state<Record<string, string>>({});
  let blockerViews = $state<Record<string, NsBlocker | null>>({});
  let openBlocker = $state<string | null>(null);
  const ns = $derived(new NightshiftClient(client.token, client.base));

  /** The open chat's request for `chat`, when this host's state has one. */
  function pendingFor(chat: string | null) {
    if (!chat) return null;
    return remote.pending.find((p) => (p.chat ?? remote.active_chat) === chat) ?? null;
  }

  async function decide(row: NeedRow, decision: "allow" | "deny") {
    const req = pendingFor(row.chat);
    if (!req) return;
    busyKey = row.key;
    try {
      await client.approve({ id: req.id, name: req.name, decision });
      onnote(decision === "allow" ? "Allowed" : "Denied");
      await load();
    } catch (e) {
      onnote(e instanceof ApiError ? e.message : "Could not answer — open the chat to try again");
    } finally {
      busyKey = null;
    }
  }

  async function answerJob(job: Job, how: Answer) {
    busyKey = `job:${job.id}`;
    try {
      await client.jobPatch(job.id, answerPatch(how));
      await load();
    } catch (e) {
      onnote(e instanceof ApiError ? e.message : "Could not answer the job — try again");
    } finally {
      busyKey = null;
    }
  }

  /** Item 812: Run anyway / Cancel on the spend guard's card. Not queued while the host is out of reach: a
   *  run must not start later on its own, so an unsent press says so and the card stays. */
  async function confirmJob(job: Job, run: boolean) {
    busyKey = `run:${job.id}`;
    try {
      await client.jobPatch(job.id, confirmPatch(run));
      await load();
    } catch (e) {
      onnote(e instanceof ApiError ? e.message : run ? "Could not start the job — try again" : "Could not cancel — try again");
    } finally {
      busyKey = null;
    }
  }

  async function showBlocker(b: HeldBlockerWire) {
    const k = `${b.project}:${b.id}`;
    if (openBlocker === k) {
      openBlocker = null;
      return;
    }
    openBlocker = k;
    if (blockerViews[k]) return;
    try {
      blockerViews = { ...blockerViews, [k]: await ns.blocker(b.project, b.id) };
    } catch {
      blockerViews = { ...blockerViews, [k]: null };
      onnote("Could not read the blocker — try again");
    }
  }

  function replyText(chat: string): string {
    return replies[chat] ?? loadDraft(chat);
  }
  function typedReply(chat: string, text: string) {
    replies = { ...replies, [chat]: text };
    saveDraft(chat, text);
  }

  /** Send `text` into `chat`; held in the page's queue when the host is
   *  not answering. True when it left the box (sent or held). */
  async function sendInto(chat: string, project: string | null, text: string): Promise<boolean> {
    const nonce = newNonce();
    try {
      // Item 1014: a dead host is held after the deadline, not a minute later.
      const st = await client.send(chat, text, { project, nonce, deadlineMs: SEND_DEADLINE_MS });
      onnote(st === "queued" ? "Sent — it goes when the running turn ends" : "Sent");
      return true;
    } catch (e) {
      if (e instanceof Unreachable) {
        onhold(chat, text, project, nonce);
        return true;
      }
      onnote(e instanceof ApiError ? e.message : "Could not send — your words stay in the box");
      return false;
    }
  }

  /** What stays in a box once `sent` left it: nothing, or the words he
   *  typed while the send was on its way (merge round S). */
  function afterSend(now: string, sent: string): string {
    const t = now.trim();
    if (t === sent) return "";
    return t.startsWith(sent) ? t.slice(sent.length).trimStart() : now;
  }

  async function sendReply(row: NeedRow) {
    const chat = row.chat;
    if (!chat) return;
    const text = replyText(chat).trim();
    if (!text || busyKey === row.key) return; // a second tap before the first send answered (item 947)
    busyKey = row.key;
    if (await sendInto(chat, row.project, text)) {
      typedReply(chat, afterSend(replyText(chat), text));
      void load();
    }
    busyKey = null;
  }

  // ---- Tell Home ----
  const tellKey = $derived(homeDraftKey(home));
  let tell = $state("");
  let tellFor = "";
  let tellBusy = $state(false);
  $effect(() => {
    if (tellFor === tellKey) return;
    // The key moved (Home's chat became known): carry what is typed over.
    // Merge round S: when the new key already holds a draft (the chat's
    // own composer text), the two are joined — neither is dropped.
    const kept = loadDraft(tellKey);
    if (tellFor && tell.trim()) {
      const joined = kept.trim() && kept.trim() !== tell.trim() ? `${kept.replace(/\s+$/, "")}\n\n${tell}` : tell;
      if (saveDraft(tellKey, joined)) saveDraft(tellFor, "");
      tell = joined;
    } else tell = kept;
    tellFor = tellKey;
  });
  function typedTell() {
    saveDraft(tellKey, tell);
  }
  // The phone's view in focus (its stage's tab), told to the Mac just before a Tell Home message so Home reads where
  // he typed from (846 §7 step 3). Best-effort: an older Mac or the away server sends the words without it.
  let stageWhere = $state({ view: "watch", task: "" });
  async function sendTell() {
    const text = tell.trim();
    if (!text || tellBusy) return;
    const target = homeTarget(home);
    tellBusy = true;
    try {
      await client.homeStageFocus(stageWhere.view, stageWhere.task).catch(() => {});
      if (target && "chat" in target) {
        if (await sendInto(target.chat, home.project, text)) {
          tell = afterSend(tell, text);
          saveDraft(tellKey, tell);
        }
      } else if (target) {
        try {
          await client.newChat(target.project, text, [], newNonce());
          tell = afterSend(tell, text);
          saveDraft(tellKey, tell);
          onnote("Sent to Home");
          void load();
        } catch (e) {
          onnote(e instanceof Unreachable ? "The host is not answering — your message stays here" : e instanceof ApiError ? e.message : "Could not send — your words stay in the box");
        }
      } else {
        onnote(feed === null && problem ? "Home could not be read yet — your message stays here" : "Home is not set up on this host yet — your message stays here");
      }
    } finally {
      tellBusy = false;
    }
  }

  // ---- Home on this Mac (the 808 helper's HomeSources.svelte) ----
  // Mounted when the file is there; until then nothing is drawn.
  const sourcesMod = import.meta.glob("./HomeSources.svelte", { eager: true, import: "default" }) as Record<string, Component<Record<string, unknown>>>;
  const HomeSources = Object.values(sourcesMod)[0] ?? null;

  // ---- life ----
  let timer: ReturnType<typeof setInterval> | null = null;
  function onVisible() {
    if (document.visibilityState === "visible") void load();
  }
  onMount(() => {
    void load().then(restoreScroll);
    timer = setInterval(() => void load(), 30_000);
    document.addEventListener("visibilitychange", onVisible);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (scrollTimer) clearTimeout(scrollTimer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    // Leaving: the scroll he had.
    if (scroller && restored) saveHomeKept(withScroll(kept, scroller.scrollTop));
  });
  let lastBump = 0;
  $effect(() => {
    if (bump !== lastBump) {
      lastBump = bump;
      void load();
    }
  });
  // The host's state moved (a turn ended, a card came or went): read again.
  let lastSig = "";
  $effect(() => {
    const sig = `${remote.busy}:${remote.pending.length}:${remote.active_chat ?? ""}`;
    if (sig === lastSig) return;
    const first = lastSig === "";
    lastSig = sig;
    if (!first) void load();
  });

  async function markSeen() {
    try {
      const r = await client.homeSeen();
      if (feed) feed = { ...feed, seen_at: r.seen_at };
      kept = { ...kept, marked: pruneMarked(kept.marked, newsRows(feed?.rows ?? []), r.seen_at) };
      saveHomeKept(kept);
    } catch {
      onnote("Could not mark it seen — try again");
    }
  }

  const ago = (ms: number | null) => (ms ? shortWhen(new Date(ms).toISOString()) : "");
</script>

{#snippet head(section: HomeSection, label: string, count: number | null, extra: string | null = null)}
  <button class="h-head" class:fil onclick={() => fold(section)} aria-expanded={!folded(section)} data-home-head={section}>
    <span class="h-chev" class:shut={folded(section)} aria-hidden="true">›</span>
    <span class="h-label">{label}</span>
    {#if count !== null}<span class="h-count">{count}</span>{/if}
    {#if extra}<span class="h-extra">{extra}</span>{/if}
  </button>
{/snippet}

<section class="home" class:fil bind:this={scroller} onscroll={onScroll} data-home-first aria-label="Home">
  <header class="h-top">
    <button class="h-icon" onclick={ondrawer} aria-label="Chats and projects">☰</button>
    <h1 class="h-title">
      <span class="h-name">{headParts[0]}</span>
      {#each headParts.slice(1) as part (part)}<span class="h-dot" aria-hidden="true">·</span><span class="h-part">{part}</span>{/each}
    </h1>
    <!-- Item 946: Handled — what was "Done since you looked", behind one button; it opens downward under the header. -->
    <button class="h-icon h-hbtn" class:on={kept.handledOpen} class:has={handled.unseen > 0} onclick={toggleHandled} aria-expanded={kept.handledOpen} aria-label={handled.unseen ? `Handled — ${handled.unseen} not seen` : "Handled"} data-home-handled>
      <span aria-hidden="true">✓</span>{#if handled.unseen > 0}<span class="h-hn" aria-hidden="true">{unseenWords(handled.unseen)}</span>{/if}
    </button>
    <button class="h-icon" onclick={onnew} aria-label="New chat">＋</button>
  </header>
  {#if kept.handledOpen}
    <div class="h-handled" class:fil role="region" aria-label="Handled" data-home-section="done">
      <div class="h-hhead">
        <span class="h-label">Handled</span>
        <span class="h-extra">{handled.unseen ? `${handled.unseen} not seen` : handled.list.length ? "all seen" : ""}</span>
        {#if handled.unseen}<button class="h-btn quiet" onclick={markSeen}>Mark all seen</button>{/if}
      </div>
      {#if handled.list.length === 0}
        <p class="h-empty">Nothing handled yet.</p>
      {/if}
      {#each handled.list as h, i (h.key)}
        {@const r = h.row}
        {@const m = doneMark(r.kind)}
        <div class="h-hrow" class:seen={!h.unseen} style:--i={Math.min(i, 8)}>
          <button class="h-row link" disabled={!r.chat} onclick={() => { markOne(h.key); if (r.chat) onopen(r.chat, r.project ?? null); }}>
            <span class="h-row-top">
              <span class="h-kind {m.tone}">{m.mark}</span>
              <span class="h-row-title">{r.label ?? "A chat"}</span>
              <span class="h-when">{shortWhen(r.at)}</span>
            </span>
            <span class="h-line">{plainLine(r.line)}</span>
          </button>
          {#if h.unseen}<button class="h-hseen" onclick={() => markOne(h.key)} aria-label={`Mark seen — ${r.label ?? r.line}`}>✓</button>{/if}
        </div>
      {/each}
      {#if handled.more > 0}<p class="h-empty">{handled.more} older, seen — not shown.</p>{/if}
    </div>
  {/if}
  {#if stop}<p class="h-stop" role="status">{stop}</p>{/if}
  {#if asOf}<p class="h-asof">{asOf}</p>{/if}
  {#if problem}<p class="h-asof">{problem}</p>{/if}
  {#if resume}
    <button class="h-resume" onclick={() => onopen(resume.chat, resume.project)}>
      <span class="h-dim">Back to</span> <span class="h-ellip">{resume.label ?? "the chat you were in"}</span>
    </button>
  {/if}

  <!-- Item 845: Home's stage — the bar, the tab row (Watching, the brief, Home's tasks, Chat); a task's tab draws its
       view here in place of Home's own sections. Tell Home stays under every tab. -->
  <HomeStage {client} {home} {scan} needs={total} {fil} tick={bump} bind:watching bind:where={stageWhere} onopen={(c, p) => onopen(c, p)} {onnote} />

  {#if watching}
  <!-- Item 944: Home starts simple and grows — a section with nothing in it is not drawn; the first time it has
       something it arrives. While nothing needs him, one calm line says so. -->
  {#if !anyNeeds && (loading || needsRead)}
    <p class="h-calm" class:fil>{loading ? "Reading…" : bareHome ? "Nothing needs you. Home is watching — what needs you, today's scan and what is running show up here as they happen." : "Nothing needs you — Home is watching."}</p>
  {/if}
  <!-- 1. Needs you -->
  {#if anyNeeds}
  <div class="h-sec arrive" class:fil data-home-section="needs">
    {@render head("needs", "Needs you", total)}
    {#if !folded("needs")}
      {#each cards as route (route.id)}
        <StartCard
          {route}
          phone
          text={routeText(route, routeDrafts)}
          busy={routeBusy === route.id}
          problem={routeProblems[route.id] ?? null}
          ontext={(t) => (routeDrafts = withRouteDraft(routeDrafts, route.id, t))}
          onstart={(pick) => void startCard(route.id, pick)}
          ondismiss={() => void dismissCard(route.id)}
        />
      {/each}
      {#each heldRoutes as route (route.id)}
        <RouteHeld {route} />
      {/each}
      {#if total + heldRoutes.length === 0}
        <p class="h-empty">{loading ? "Reading…" : "Nothing needs you."}</p>
      {/if}
      {#each needs as row (row.key)}
        {@const req = pendingFor(row.chat)}
        <div class="h-row need" data-need={row.kind}>
          <div class="h-row-top">
            <span class="h-kind {row.kind}">{row.kind === "approval" ? "Approval" : row.kind === "question" ? "Question" : row.kind === "stuck" ? "Stuck" : row.kind === "job" ? "Job" : "Blocker"}</span>
            <span class="h-row-title">{row.title}</span>
            {#if row.at}<span class="h-when">{ago(row.at)}</span>{/if}
          </div>
          {#if row.kind === "approval" && req && cardKind(req) === "call"}
            <p class="h-line">{toolSummary(req.name, req.input)}</p>
            <div class="h-acts">
              <button class="h-btn primary" disabled={busyKey === row.key} onclick={() => decide(row, "allow")}>Allow</button>
              <button class="h-btn" disabled={busyKey === row.key} onclick={() => decide(row, "deny")}>Deny</button>
              {#if row.chat}<button class="h-btn quiet" onclick={() => onopen(row.chat!, row.project)}>Open</button>{/if}
            </div>
          {:else if row.kind === "job" && row.job && row.confirm}
            <JobRunConfirm job={row.job} busy={busyKey === row.key} onanswer={(run) => confirmJob(row.job!, run)} />
          {:else if row.kind === "job" && row.job}
            <JobApproval job={row.job} busy={busyKey === row.key} onanswer={(how) => answerJob(row.job!, how)} />
          {:else if row.kind === "blocker" && row.blocker}
            {@const b = row.blocker}
            {@const k = `${b.project}:${b.id}`}
            <p class="h-line">{plainLine(row.line)}</p>
            {#if openBlocker === k && blockerViews[k]}
              <BlockerAnswer {ns} project={b.project} blocker={blockerViews[k]!} live={false} onanswered={() => { openBlocker = null; void load(); }} />
            {:else}
              <div class="h-acts"><button class="h-btn primary" onclick={() => showBlocker(b)}>Answer</button></div>
            {/if}
          {:else if row.kind === "question" && row.chat && !req}
            <!-- A turn-end question: his reply is the next message, kept as the chat's own draft. -->
            <p class="h-line">{plainLine(row.line)}</p>
            <div class="h-reply">
              <textarea
                rows="2"
                placeholder="Reply in {row.title}…"
                value={replyText(row.chat)}
                oninput={(e) => typedReply(row.chat!, (e.currentTarget as HTMLTextAreaElement).value)}
              ></textarea>
              <div class="h-acts">
                <button class="h-btn primary" disabled={busyKey === row.key || !replyText(row.chat).trim()} onclick={() => sendReply(row)}>Send</button>
                <button class="h-btn quiet" onclick={() => onopen(row.chat!, row.project)}>Open</button>
              </div>
            </div>
          {:else}
            <p class="h-line">{plainLine(row.line)}</p>
            {#if row.chat}<div class="h-acts"><button class="h-btn primary" onclick={() => onopen(row.chat!, row.project)}>Open to answer</button></div>{/if}
          {/if}
        </div>
      {/each}
      {#if proposals > 0}
        <p class="h-else h-else-line" data-home-proposals><span class="h-else-t">{proposalWords(proposals)}</span></p>
      {/if}
      {#if heldRows.length}
        <button class="h-else" onclick={() => fold("held")} aria-expanded={!folded("held")} data-home-head="held">
          <span class="h-chev" class:shut={folded("held")} aria-hidden="true">›</span>
          <span class="h-else-t">{heldWords(heldRows.length)}</span>
          <span class="h-else-n">in the count above</span>
        </button>
        {#if !folded("held")}
          {#each heldRows as row (row.key)}
            {#if row.blocker}
              {@const b = row.blocker}
              {@const k = `${b.project}:${b.id}`}
              <div class="h-row need" data-need="blocker">
                <div class="h-row-top"><span class="h-kind blocker">Blocker</span><span class="h-row-title">{row.title}</span></div>
                <p class="h-line">{plainLine(row.line)}</p>
                {#if openBlocker === k && blockerViews[k]}
                  <BlockerAnswer {ns} project={b.project} blocker={blockerViews[k]!} live={false} onanswered={() => { openBlocker = null; void load(); }} />
                {:else}
                  <div class="h-acts"><button class="h-btn primary" onclick={() => showBlocker(b)}>Answer</button></div>
                {/if}
              </div>
            {/if}
          {/each}
        {/if}
      {/if}
    {/if}
  </div>
  {/if}

  <!-- 2. Today's scan -->
  {#if scan}
  <div class="h-sec arrive" class:fil data-home-section="scan">
    {@render head("scan", scan && !scan.today ? "Last scan" : "Today's scan", null, scan ? scanWhen(scan, (ms) => clock12(ms)) : null)}
    {#if !folded("scan")}
      {#if !scanLoaded}
        <p class="h-empty">Reading…</p>
      {:else if !scan}
        <p class="h-empty">No scan yet{scanJob ? ` · runs ${scanJob.every_words.replace(/^every day at /, "every day at ")}` : ""}.</p>
      {:else}
        {@const body = scanText(scanBody(scan))}
        {#if scan.skipped}<p class="h-skip">Skipped: {skipWhy(scan.skipped)}. This is the code-only page.</p>{/if}
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        <div class="h-scan md">{@html renderMarkdown(body.text, { localImagesAsText: true })}</div>
        {#if home.chat}<div class="h-acts"><button class="h-btn quiet" onclick={() => onopen(home.chat!, home.project)}>Open Home's chat</button></div>{/if}
      {/if}
    {/if}
  </div>
  {/if}

  <!-- 3. Done since you looked: item 946 — the Handled button in the header's corner (above). -->

  <!-- 4. Running -->
  {#if running?.chats.length}
  <div class="h-sec arrive" class:fil data-home-section="running">
    {@render head("running", "Running", running?.chats.length ?? 0)}
    {#if !folded("running")}
      {#if !running || running.chats.length === 0}
        <p class="h-empty">Nothing is running.</p>
      {:else}
        {#each running.chats as c, i (c.chat ?? `new-${i}`)}
          <button class="h-row link" disabled={!c.chat} onclick={() => c.chat && onopen(c.chat, c.project ?? null)}>
            <span class="h-row-top">
              <span class="h-kind run">Running</span>
              <span class="h-row-title">{c.title || "A new chat"}</span>
            </span>
            <span class="h-line">{runningLine(c, Date.now(), c.chat ? (running.contexts?.[c.chat] ?? null) : null)}</span>
          </button>
        {/each}
      {/if}
    {/if}
  </div>
  {/if}
  {/if}

  <!-- 5. Tell Home, and the Jobs row -->
  <div class="h-sec tell" data-home-section="tell">
    <label class="h-tell-label" for="h-tell">Tell Home…</label>
    <textarea id="h-tell" rows="2" bind:value={tell} oninput={typedTell} placeholder="Check why CI is red in Nightloom" data-home-tell></textarea>
    <div class="h-acts">
      <span class="h-dim h-ellip">{home.chat ? "Goes to today's Home chat" : home.project ? "Starts Home's chat" : feed === null && (loading || problem) ? (loading ? "Reading Home…" : "Home could not be read yet") : "Home is not set up on this host yet"}</span>
      <button class="h-btn primary" disabled={tellBusy || !tell.trim()} onclick={sendTell}>Send</button>
    </div>
  </div>
  {#if watching}
  <button class="h-row link jobs" onclick={onjobs} data-home-jobs>
    <span class="h-row-top">
      <span class="h-row-title">Jobs</span>
      <span class="h-line h-ellip">{jobsWords(jobs, (ms) => clock12(ms))}</span>
      <span class="h-chev" aria-hidden="true">›</span>
    </span>
  </button>

  <!-- 6. Home on this Mac (808's HomeSources) -->
  {#if HomeSources}
    <div class="h-sec" data-home-section="sources">
      {@render head("sources", "Home on this Mac", null)}
      {#if !folded("sources")}<HomeSources {client} />{/if}
    </div>
  {/if}
  {/if}
  <div class="h-foot"></div>
  {#if msg || queued > 0}
    <div class="h-toast" role="status">{msg ?? (queued === 1 ? "1 message held — it goes when its host answers" : `${queued} messages held — they go when their host answers`)}</div>
  {/if}
</section>

<style>
  .home {
    position: fixed;
    inset: 0;
    z-index: 6;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    background: var(--paper);
    color: var(--ink);
    padding: env(safe-area-inset-top, 0px) max(14px, env(safe-area-inset-right, 0px)) 0 max(14px, env(safe-area-inset-left, 0px));
    box-sizing: border-box;
  }
  .home * {
    box-sizing: border-box;
  }
  .h-top {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 0 8px;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
    max-width: 760px;
    margin: 0 auto;
  }
  .h-icon {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--well);
    color: var(--ink);
    font-size: 17px;
  }
  .h-title {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.3;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 6px;
  }
  .h-name {
    font-size: 20px;
    font-weight: 700;
  }
  .h-dot,
  .h-part {
    color: var(--dim);
  }
  .fil .h-name {
    font-family: var(--mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .h-stop,
  .h-asof,
  .h-skip {
    max-width: 760px;
    margin: 8px auto 0;
    font-size: 13px;
    line-height: 1.4;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  .h-stop,
  .h-skip {
    color: var(--failed, var(--ink));
  }
  .h-resume {
    display: flex;
    width: 100%;
    max-width: 760px;
    margin: 10px auto 0;
    gap: 6px;
    padding: 8px 12px;
    border-radius: 10px;
    border: 1px dashed var(--line);
    background: none;
    color: var(--ink);
    font-size: 14px;
    text-align: left;
  }
  .h-sec {
    max-width: 760px;
    margin: 14px auto 0;
  }
  .h-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 6px 0;
    border: none;
    background: none;
    color: var(--ink);
    text-align: left;
    font-size: 16px;
    font-weight: 650;
  }
  .h-head.fil .h-label {
    font-family: var(--mono);
    font-size: 13px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .h-chev {
    display: inline-block;
    color: var(--dim);
    transform: rotate(90deg);
    transition: transform 0.15s;
  }
  .h-chev.shut {
    transform: none;
  }
  .h-count {
    min-width: 20px;
    padding: 0 6px;
    border-radius: 10px;
    background: var(--well);
    color: var(--dim);
    font-size: 12px;
    text-align: center;
  }
  .h-extra {
    margin-left: auto;
    color: var(--dim);
    font-size: 12px;
    font-weight: 400;
    white-space: nowrap;
  }
  /* Item 944: the calm line, and a section's arrival (Jarvis; plain otherwise). */
  .h-calm {
    max-width: 760px;
    margin: 14px auto 6px;
    padding: 0 2px;
    color: var(--dim);
    font-size: 14px;
    line-height: 1.45;
  }
  .h-sec.arrive.fil {
    animation: h-arrive 380ms cubic-bezier(0.2, 0.9, 0.25, 1.05) backwards;
  }
  @keyframes h-arrive {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .h-sec.arrive.fil {
      animation: none;
    }
  }
  /* Item 946: the Handled button and the list it opens downward under the header. */
  .h-hbtn {
    position: relative;
  }
  .h-hbtn.on {
    color: var(--accent);
  }
  .h-hn {
    position: absolute;
    top: -2px;
    right: -4px;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 8px;
    background: var(--accent);
    color: #1a1205;
    font: 600 10px/15px var(--mono, ui-monospace, monospace);
    text-align: center;
  }
  .h-handled {
    max-width: 760px;
    margin: 0 auto;
    padding: 6px 0 10px;
    /* Item 947: a long list scrolls inside its own box — 60 rows opened inline buried Needs you a screen-and-a-half down. */
    max-height: min(62vh, 560px);
    overflow-y: auto;
    overscroll-behavior: contain;
    border-bottom: 1px solid var(--line);
    transform-origin: top;
    animation: h-handled-down 220ms cubic-bezier(0.2, 0.9, 0.25, 1.05);
  }
  .h-handled.fil {
    border-bottom-color: color-mix(in srgb, var(--accent) 40%, var(--line));
    box-shadow: 0 10px 18px -14px color-mix(in srgb, var(--accent) 55%, transparent);
  }
  @keyframes h-handled-down {
    from {
      opacity: 0;
      clip-path: inset(0 0 100% 0);
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      clip-path: inset(0 0 0 0);
      transform: none;
    }
  }
  .h-hhead {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 2px 6px;
  }
  .h-hhead .h-extra {
    flex: 1;
  }
  .h-hrow {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .h-handled.fil .h-hrow {
    animation: h-hrow-in 240ms ease-out backwards;
    animation-delay: calc(var(--i, 0) * 28ms + 80ms);
  }
  @keyframes h-hrow-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
  }
  .h-hrow > .h-row {
    flex: 1;
    min-width: 0;
  }
  .h-hrow.seen > .h-row {
    opacity: 0.6;
  }
  .h-hseen {
    flex: none;
    width: 36px;
    height: 36px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: none;
    color: var(--dim);
    font-size: 15px;
  }
  @media (prefers-reduced-motion: reduce) {
    .h-handled,
    .h-handled.fil .h-hrow {
      animation: none;
    }
  }
  /* Item 995: the proposals' line — words only, nothing to press on the phone. */
  .h-else-line {
    margin: 0;
    cursor: default;
  }
  /* Item 945: Nightshift's held blockers — one quiet line under Needs you. */
  .h-else {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 10px 2px 4px;
    border: 0;
    background: none;
    color: var(--dim);
    font: inherit;
    font-size: 13px;
    text-align: left;
  }
  .h-else-n {
    margin-left: auto;
    font-size: 11px;
    opacity: 0.75;
  }
  .h-empty {
    margin: 2px 0 6px 18px;
    color: var(--dim);
    font-size: 14px;
  }
  .h-row {
    display: block;
    width: 100%;
    margin: 6px 0;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: var(--raised, var(--well));
    color: var(--ink);
    text-align: left;
    font: inherit;
  }
  .h-row.need {
    border-color: var(--accent-soft, var(--line));
  }
  .h-row.link:disabled {
    opacity: 0.8;
  }
  .h-row-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .h-row-title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .jobs .h-row-title {
    flex: none;
  }
  .jobs .h-line {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .h-kind {
    flex: none;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 6px;
    background: var(--well);
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .h-kind.approval,
  .h-kind.question,
  .h-kind.stuck,
  .h-kind.job,
  .h-kind.blocker {
    background: var(--accent-soft, var(--well));
    color: var(--accent-ink, var(--accent));
  }
  .h-kind.bad {
    color: var(--failed, var(--ink));
  }
  .h-kind.ok {
    color: var(--done, var(--ink));
  }
  .h-kind.run {
    color: var(--live, var(--accent));
  }
  .h-when {
    flex: none;
    font-size: 12px;
    color: var(--dim);
  }
  .h-line {
    display: block;
    margin: 4px 0 0;
    font-size: 14px;
    line-height: 1.4;
    color: var(--dim);
    overflow-wrap: anywhere;
  }
  .h-acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  .h-acts .h-dim {
    flex: 1;
    min-width: 0;
    font-size: 13px;
  }
  .h-btn {
    min-height: 34px;
    padding: 6px 14px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--well);
    color: var(--ink);
    font-size: 14px;
  }
  .h-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent, #fff);
  }
  .h-btn.quiet {
    background: none;
  }
  .h-btn:disabled {
    opacity: 0.5;
  }
  .h-reply textarea,
  .tell textarea {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--well);
    color: var(--ink);
    font: inherit;
    font-size: 16px;
    resize: vertical;
  }
  .h-scan {
    font-size: 14px;
    line-height: 1.5;
    padding: 4px 12px 2px;
    border-left: 2px solid var(--accent-soft, var(--line));
    overflow-wrap: anywhere;
  }
  .h-scan :global(p),
  .h-scan :global(ul),
  .h-scan :global(ol) {
    margin: 4px 0;
  }
  .h-scan :global(ul),
  .h-scan :global(ol) {
    padding-left: 18px;
  }
  .h-scan :global(pre) {
    overflow-x: auto;
    max-width: 100%;
  }
  .h-scan :global(h1),
  .h-scan :global(h2),
  .h-scan :global(h3) {
    font-size: 15px;
    margin: 8px 0 4px;
  }
  .tell {
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: var(--raised, var(--well));
  }
  .h-tell-label {
    font-weight: 650;
    font-size: 15px;
  }
  .jobs {
    max-width: 760px;
    margin: 10px auto 0;
  }
  .h-dim {
    color: var(--dim);
  }
  .h-ellip {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .h-toast {
    position: fixed;
    left: 50%;
    bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    z-index: 2;
    max-width: calc(100vw - 32px);
    width: max-content;
    padding: 8px 16px;
    border-radius: 999px;
    background: var(--ink);
    color: var(--paper);
    font-size: 13px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
  }
  .h-foot {
    height: calc(32px + env(safe-area-inset-bottom, 0px));
  }
</style>
