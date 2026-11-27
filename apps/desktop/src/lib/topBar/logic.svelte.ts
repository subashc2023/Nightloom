// Item 856 (2026-11-19): the behaviour of TopBar, once. `TopBar.svelte` (Jarvis) and
// `TopBarClassic.svelte` mount this and keep only their markup and CSS; `logic.test.ts` beside it fails when
// one look binds to something the other does not. Moved verbatim from TopBar.svelte's script.
import { paceWarn, WARN_PCT } from "../pace";
import { dialWindow, staleTag, stopLine, type DialFigures } from "../planDials";
import { addToast, app, chatMode, contextUsed, currentTodos, liveFlags, latestSubagents, subagentsOfTurn, liveChats, openSession, chatThread, asideReads, type Aside } from "../state.svelte";
import { touchedUntil } from "../keepWarm";
import { keepWarm } from "../keepWarm.svelte";
import { cacheState } from "../cache";
import { coldToast, lastReply } from "../cacheCost";
import { tellPhoneCache } from "../remoteHandlers";
import { nextSendRates } from "../cacheRates.svelte";
import { boxDraftTokens } from "../draftCost.svelte";
import { modelSeen } from "../modelSeen.svelte";
import { lastLoggedTurn } from "../contextDial";
import { liveFor, liveTokens } from "../liveContext";
import { liveContextOf } from "../liveContext.svelte";
import { anchorBelow } from "../portal";
import { gaugeChipTip, planReadingTip } from "../shortTip";
import { foldToFit } from "../fold";
import { forkLine } from "../edit";
import { writesHandoffFile } from "../handoff.svelte";
// Item 299: Make main on the open fork, from the bar.
import { canMakeMain } from "../versions";
import { versions } from "../versions.svelte";
import { allRunning } from "../running.svelte";
import { asideRun, chatRun } from "../runGroups";
import { threadChip } from "../thread";
import { auth } from "../claudeAuth.svelte";
import { chipWord } from "../claudeAuth";
import { asideFigures, asideSpendText } from "../asideFigures";
import { openChatSpend, trackOpenChatFigures } from "../chatFigures.svelte";
import { contextOf } from "../chatContext.svelte";
import { chatLabel } from "../chatLabel";

export type TopBarLogicProps = Props;

export interface Props {
  /**
   * Item 605 (2026-11-11, his "that entire top bar, even like the
   * notification bell place is gone for asides"): the bar over an aside
   * tab — the same bar, reading the aside's own figures: its context
   * (the next follow-up's prefix), the plan, its spend; the bell and
   * Files for you. What is about the chat's session alone (the mode mark,
   * the thread chip, Make main, the agents chip, Compact, the model popover)
   * stays the chat's bar's. Null: the chat's bar, as before.
   */
  aside?: Aside | null;
  /** The chat the aside is of (item 605), for its hand-off line. */
  asideChat?: string | null;
  /** Whether this bar carries the bell and Files for you (item 605): an
   *  aside's bar does only while no chat bar is up, so the window has one. */
  bell?: boolean;
}

export function topBarLogic(props: () => TopBarLogicProps) {
  const aside = $derived(props().aside ?? null);
  const asideChat = $derived(props().asideChat ?? null);
  const bell = $derived(props().bell ?? true);
  const POP_WIDTH = 340;
  const runSign = $derived(chatRun(allRunning(), app.activeSessionId).state);
  /** Item 886: an aside's bar carries its own running sign at the left, as
   *  the chat's bar carries the chat's (item 556). */
  const asideRunSign = $derived(aside ? asideRun(allRunning(), asideChat, aside.id).state : "idle");

  /**
   * The chat top bar in the redesign (item 036, the mock-up's Chat artboard):
   * the session's name and short id on the left; on the right the ~~model~~
   * kind chip, the context chip, ~~the cache chip,~~ the cost chip and
   * Compact. The ~~model~~ chip opens a popover that *is* the old right
   * rail (Model · Tasks · Context), so nothing the rail did is lost — it
   * just no longer takes a 240px column on every screen.
   *
   * Shortened 2026-09-16 (nightshift backlog 112, "the top bar is kinda
   * getting too long"): the model's name, the thinking and tools toggles
   * and the cache chip moved to the composer — the model and effort as
   * buttons in the box, thinking · tools · cache on a row under it — and
   * the chip reads the kind and the engine alone (blocker 141). This bar
   * is what is about the *chat*: its name, its kind, how full its window
   * is, the plan, what it has cost.
   *
   * Folds by priority (nightshift backlog 129, 2026-09-17; the rule his
   * review of the tabs boards stated for 099 — "shortening the number of
   * elements rather than just truncating all of them"): the bar is a CSS
   * container, and as *its own* width runs out — a narrow window, a pane
   * of a split, ⌘= at 150–200% — the chips shed their words in three
   * steps rather than clipping at the right edge. Step 1 (under 1000px):
   * the gauges lose their labels — the context gauge's `of 200k`, the plan
   * chip's `plan` and `· stale` (the colour and the title still say it).
   * Step 2 (under 860px): the spend chip folds into the gauge's hover, the
   * gauge drops its percentage, the plan chip its week. Step 3 (under
   * 700px): the token count folds into the gauge's hover too — both
   * gauges are bars alone, every value in their titles — and the kind
   * chip drops the engine. What survives last is his priority order: the
   * plan's 5h bar, the context bar, the kind. Nothing is removed outright:
   * every folded figure is in the hover of the chip it folded into, and
   * the rail (⌘M) and the Context page (⌘⇧C) have all of it. A container
   * query, not a media query, so the zoom factor (backlog 108) is
   * invisible to it: at 200% the bar is half as many CSS pixels wide and
   * folds as a half-width bar would.
   * ~~A container query … invisible to the zoom~~ — wrong in WebKit
   * (nightshift backlog 183, measured 2026-09-22): under page zoom the
   * query reads the bar's width × the zoom, so each step fired a zoom
   * step late and the bar wrapped. The bar now folds by measuring
   * (`fold.ts`).
   *
   * Board d since 2026-09-22 (nightshift backlog 175 pass 2, blocker 274):
   * no title row — the tab names the chat, and its hover carries the short
   * id; the context gauge, the plan chip and the spend chip are one gauge
   * chip — two thin bars (context over plan) and the plan reading's age —
   * whose click opens a card with every figure and a button to the
   * itemised Context page (⌘⇧C still opens that page directly). One row,
   * 44 px, at every zoom from 100 to 200 % in a 1440 px window; what is
   * left to fold (the kind chip's engine, the agents chip's words) folds by
   * measurement, and the wrap stays the floor beneath.
   */

  const session = $derived(app.sessions.find((s) => s.id === app.activeSessionId) ?? null);
  // ~~`title` and `crumb` (the name and the short id on the bar's left)~~ —
  // board d (backlog 175): the tab is the title; the id is in its hover.

  /**
   * The chat's mode, projected from its log (nightshift backlog 059): a
   * glyph and the word after the short id. An ephemeral chat has no listing
   * row, so `title` above is empty for it and this mark is what says what
   * it is; it also says, in the same breath, that nothing is kept.
   */
  /**
   * "Continued from" (nightshift backlog 086): a chat opened by the
   * hand-off card carries its parent on its creation line with
   * `reason: "handoff"`; the mark names the parent the way the sidebar's
   * lineage line does and opens it on click. An edit-and-send fork has
   * no reason and no mark here — the sidebar already says "from …".
   */
  const continuedFrom = $derived.by(() => {
    if (!session?.forked_from || session.forked_from.reason !== "handoff") return null;
    const line = forkLine(session, app.sessions) ?? "from an earlier chat";
    // Item 1007: HANDOFF.md named only where the hand-off writes one (item 1025: every chat but a plain thread chat).
    return { id: session.forked_from.session, line: line.replace(/^from /, ""), file: writesHandoffFile(session.id) };
  });
  /** The open chat is a fork (or a version) that can take its original's
   *  place (item 299): the bar offers Make main beside the mode mark. */
  const mainable = $derived(
    !!app.activeSessionId && canMakeMain(app.sessions, versions.map, app.activeSessionId),
  );
  const mode = $derived(chatMode(app.events));
  /** Whether the thread chip draws (backlog 281), so the left group is
   *  there for it; the chip decides its own text. */
  const threadChipShown = $derived(threadChip(chatThread(app.events), app.project !== null, mode) !== null);
  const modeText = $derived(
    mode === "incognito"
      ? "incognito"
      : mode === "ephemeral"
        ? "ephemeral — nothing is kept"
        : "",
  );
  const modeTitle = $derived(
    mode === "incognito"
      ? "Incognito: kept and marked; knows nothing about you (no profile, memory, vault or project), writes nothing, unread by other chats"
      : "Ephemeral: no log, no name, no CLI session; gone when you close it",
  );

  /**
   * Context gauge. The denominator comes from the backend's limits table and
   * is null for models it doesn't know; in that case the raw count is shown
   * with no bar, because a guessed window would tell the reader — and the
   * model reading the same figure in its sidecar — that there is headroom
   * nobody verified.
   */
  /**
   * Item 654 (B3's chip: "stays simple"): while the chat's reply runs, the
   * chip reads the live figure the right column does (item 590's), so its
   * arc eases with the reply (ContextDial's 300 ms) and the figure shows
   * `~`, dimmed, while it is an estimate; when the reply ends it flashes
   * once as it lands on the real figure. Asides keep their own figures.
   */
  const liveCtx = $derived(
    !aside && app.busy && app.live != null
      ? liveFor(liveContextOf(app.activeSessionId), lastLoggedTurn(app.events)?.startedAt ?? null)
      : null,
  );
  const liveEst = $derived(liveCtx != null && liveCtx.estimate > 0);
  let landFlash = $state(false);
  let wasLive = false;
  $effect(() => {
    const on = liveCtx != null;
    if (wasLive && !on) {
      landFlash = true;
      const id = setTimeout(() => (landFlash = false), 500);
      wasLive = on;
      return () => {
        clearTimeout(id);
        landFlash = false;
      };
    }
    wasLive = on;
  });
  const gauge = $derived.by(() => {
    const used = af ? af.used : liveCtx ? liveTokens(liveCtx) : contextUsed();
    if (used == null) return null;
    const limit = app.connection?.contextLimit ?? null;
    const ratio = limit ? Math.min(used / limit, 1) : null;
    return { used, limit, ratio };
  });

  const level = $derived(
    gauge?.ratio == null ? "" : gauge.ratio >= 0.9 ? "hot" : gauge.ratio >= 0.7 ? "warm" : "",
  );

  /**
   * Session spend. Shown only once there is something to show, and never as
   * "$0.00" for a model with no price — an unknown cost and a free one look
   * identical at two decimal places, and only one of them is true.
   */
  const spend = $derived.by(() => {
    if (af) {
      const text = asideSpendText(af.cost);
      return text && af.cost ? { text, complete: af.cost.complete, agent: true } : null;
    }
    // Item 675: a Claude Code chat's spend is the CLI's running cost for
    // it (the right column's figure) — its replies carry no logged cost,
    // so the log's sum (`sessionCost`) read "at least $0.00" here.
    const c = openChatSpend();
    if (!c) return null;
    if (c.usd === 0 && c.complete) return null;
    // Sub-cent turns are the common case early in a session; two decimals
    // would render most of them as $0.00 and look broken.
    const digits = c.usd > 0 && c.usd < 0.01 ? 4 : 2;
    return { text: `$${c.usd.toFixed(digits)}`, complete: c.complete, agent: c.agent };
  });
  $effect(() => trackOpenChatFigures());

  /**
   * The prompt-cache timer (nightshift backlog 063, 2026-09-15): when the
   * last turn's cache entry expires, read off the log — each turn records
   * when its request was sent and the lifetime of the cache it left, on
   * both engines — so reopening a chat shows the countdown it had.
   *
   * This supersedes the countdown the cached chip used to infer (five
   * minutes from the reply's *end*, API engine only): the origin was the
   * wrong clock, since the API counts from the request's start, and the
   * Claude Code engine's hour was unreadable from here. Both are now
   * recorded; see `cache.ts`.
   *
   * ~~The clock is a chain of timeouts aligned to when the text would
   * change~~ — the chip and its clock moved to the composer's bottom row
   * (nightshift backlog 112, 2026-09-16); what stays here is the toast
   * on the crossing to cold, since this bar is up on every view the chat
   * is open under and the composer only under the transcript. One timeout
   * to the expiry, and only if the cache was warm when the chain was
   * built: a chat reopened already cold is a state, not a crossing, and
   * the chain is torn down and rebuilt whenever the open chat's log
   * changes, so a background chat has no chain and cannot toast.
   */
  $effect(() => {
    // Item 605: the chat's bar alone toasts its cache going cold.
    if (aside) return;
    const warmUntil = cacheState(app.events, Date.now(), app.activeSessionId ? touchedUntil(keepWarm.byChat[app.activeSessionId]) : null, asideReads(app.activeSessionId, lastReply(app.events)?.model))?.warmUntil ?? null;
    // Item 786: the phone's header times the same cache (pings and asides too).
    tellPhoneCache(app.activeSessionId, warmUntil);
    if (warmUntil == null) return;
    const wait = warmUntil - Date.now();
    if (wait <= 0) return;
    // A millisecond past the boundary, as the display's ticks were: a
    // timer firing on the boundary itself would read the cache as warm.
    // Item 699's price fix: the toast says what the next send now costs,
    // at the rates read when it fires (the composer's chip reads the same).
    // Item 902: at the rates of the model the next send goes to (the pick).
    const pick = () => ({ draftModel: app.draft.agentModel, seen: modelSeen.byAlias });
    void nextSendRates(app.events, app.connection, pick());
    const id = setTimeout(
      // Item 904: with what the box holds when it fires.
      () => addToast(coldToast(app.events, nextSendRates(app.events, app.connection, pick()), boxDraftTokens(app.activeSessionId, app.connection?.engine))),
      wait + 1,
    );
    return () => clearTimeout(id);
  });

  /**
   * The plan chip (nightshift backlog 073, 2026-09-16): on the Claude Code
   * engine, the subscription's five-hour and seven-day percentages beside
   * the context gauge — two numbers he ran `/usage` for more than any
   * other command. Read from the Claude desktop app's sample file and the
   * CLI's cache (`plan_usage.rs`), whichever is fresher, at connect and at
   * every turn end; the title says how old the reading is and when each
   * window resets, and a reading past twenty minutes is marked stale
   * rather than shown as current. Account-wide and server-computed: it
   * counts every surface, not this chat. Nothing before a sample exists.
   * ~~The last turn's `rate_limit_event` carries no percentage~~ — measured
   * 2026-09-16 on CLI 2.1.263, it does (`unifiedWindows`, both windows),
   * and that live figure is the first choice (`planUsageFromTurn`); the
   * files are the fallback before the first turn and on an older CLI.
   */
  const plan = $derived.by(() => {
    if (app.connection?.engine !== "claude-code") return null;
    const u = app.planUsage;
    if (!u || u.source === "none" || u.five_hour == null) return null;
    return u;
  });
  // The reading's age, ticking (his ask 2026-09-18: "add like a '5min
  // ago' in the bar at the top"): `age_seconds` is fixed at the read, so
  // the clock here runs from `sampled_at_ms` every 30 s.
  let now = $state(Date.now());
  /** The aside's figures, refreshed with the bar's 30 s clock (item 605). */
  /** Item 639: the chat's last context reading, for an aside that kept no
   *  tokens (answered before 605) — the same base the right column uses. */
  const asideBase = $derived.by(() => {
    if (!aside || !asideChat) return null;
    if (asideChat === app.activeSessionId) return contextUsed() ?? contextOf(asideChat)?.used ?? null;
    return contextOf(asideChat)?.used ?? null;
  });
  const af = $derived(aside ? asideFigures(aside, now, asideBase) : null);
  /** The aside's chat by name (item 605), for the chip's and card's words. */
  const asideChatName = $derived.by(() => {
    if (!asideChat) return "the chat";
    const s = app.sessions.find((x) => x.id === asideChat);
    return chatLabel(s, asideChat.slice(0, 8));
  });
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });
  const planAgeSeconds = $derived.by(() => {
    if (!plan) return null;
    if (plan.sampled_at_ms != null) return Math.max(0, (now - plan.sampled_at_ms) / 1000);
    return plan.age_seconds;
  });
  const planAgeMark = $derived.by(() => {
    const a = planAgeSeconds;
    if (a == null) return "?";
    if (a < 90) return "now";
    if (a < 3600) return `${Math.round(a / 60)}m`;
    return `${Math.round(a / 3600)}h`;
  });
  // ~~`planAgeText`, `planWhere` (the card's source foot)~~ — item 824
  // dropped the foot as yap; the stale tag in the head carries the age.
  /** Item 769: the pace lines (tighter window first) and the 80% warning
   *  — his stop line — from the reading itself, either window. */
  const warn = $derived(plan ? paceWarn(plan) : null);
  const weekHot = $derived(plan?.seven_day != null && plan.seven_day >= WARN_PCT);

  /** Item 824: the card's figures — context, the two windows with their
   *  projected percent at the reset, his stop line from his setting (the
   *  limits' `stop_at`, never a constant), the spend. */
  const dialFigures = $derived.by((): DialFigures => ({
    head: aside ? "Aside · context & plan" : "Context & plan",
    stale: staleTag(plan, now),
    ctx: gauge
      ? { used: gauge.used, limit: gauge.limit, estimated: !!af?.estimated || liveEst, agents: !aside && agents.rows.length > 0 ? agents.tokens : 0 }
      : null,
    five: plan ? dialWindow(plan.five_hour, plan.five_hour_resets_at, app.planPace?.five_hour, now) : null,
    week: plan ? dialWindow(plan.seven_day, plan.seven_day_resets_at, app.planPace?.seven_day, now) : null,
    stop: stopLine(app.draft.agentLimits),
    spend: spend ? { text: spend.text, complete: spend.complete } : null,
  }));
  /** The spend's hover, two short lines at most (item 776's rule). */
  const spendTip = $derived(
    !spend
      ? ""
      : aside
        ? spend.complete ? "Added over the chat" : "At least: some answers kept no cost"
        : spend.complete ? "This chat so far" : "At least: a model has no price",
  );

  /** Item 595: each reading's own hover, naming it ("Context 212k of 1M",
   *  "5-hour window 59%"); the chip's hover keeps every figure. */
  const gaugeTip = $derived.by(() => {
    if (!gauge) return "";
    const head = gauge.limit
      ? `Context ${tokens(gauge.used)} of ${tokens(gauge.limit)} (${Math.round((gauge.ratio ?? 0) * 100)}%)`
      : `Context ${tokens(gauge.used)} — window size unknown for this model`;
    // Item 639: an aside that kept no token counts reads an estimate, and says so.
    return `${af?.estimated ? "About: " : ""}${head}${af?.estimated ? " (estimated: this aside kept no token counts)" : ""} — click for the figures`;
  });
  /** Post-install 16c8e01: the plan reading's hover, one short line per
   *  window (shortTip.ts); the source, age and stale note are on the gauge
   *  card's foot, which a click opens. */
  const planTip = $derived(plan ? planReadingTip(plan, app.planPace, now) : "");

  function tokens(n: number): string {
    if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(2))}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return String(n);
  }

  // Compaction needs at least one completed exchange to summarize — one the
  // projection still carries, since that is what the backend summarizes.
  const canCompact = $derived.by(() => {
    if (!app.connection || aside) return false;
    // Compaction rewrites what the *log* projects onto the next request, and
    // on the agent engine nothing projects: the next turn resumes a history
    // Claude Code keeps. The button would change what this window shows and
    // nothing about the conversation, which is worse than not offering it.
    if (app.connection.engine === "claude-code") return false;
    const live = liveFlags(app.events);
    return app.events.some((e, i) => live[i] && e.event === "assistant_message");
  });

  // ~~`annotation`: the chip's `· thinking default · tools` tail~~ — gone
  // with backlog 112 (2026-09-16): the thinking mode is the composer's
  // second button on the provider engine, and the tools switch is the
  // rail's; board 10's chips carry neither.

  const openTasks = $derived(currentTodos().filter((t) => t.status !== "completed").length);

  /** Backlog 409: "signed out" in place of `subscription` once Claude
   *  Code's own status said so (`claude auth status`), and the dot red. */
  const signedOut = $derived(app.connection?.engine === "claude-code" ? chipWord(auth.signedIn) : null);
  /** The chip's second word: `subscription` on the Claude Code engine,
   *  the provider's name on the other. Folds at step 3 (backlog 129). */
  const engineName = $derived(
    app.connection?.engine === "claude-code"
      ? (signedOut ?? "subscription")
      : (app.connection?.provider ?? ""),
  );
  /** Post-install 16c8e01: the gauge chip's hover, two short lines
   *  (shortTip.ts) — the spend carried always (backlog 129, step 2), so
   *  it reads the same at every width; every other figure is on the
   *  gauge card it opens. */
  const chipTip = $derived(
    gaugeChipTip({
      context: gauge
        ? `${af?.estimated ? "About" : "Context"} ${tokens(gauge.used)}${gauge.limit ? ` of ${tokens(gauge.limit)} (${Math.round((gauge.ratio ?? 0) * 100)}%)` : " · window unknown"}`
        : null,
      spend: spend ? `${spend.complete ? "" : "≥ "}${spend.text}` : null,
      plan,
    }),
  );
  /**
   * The latest turn's subagents (nightshift backlog 152): the agents chip
   * — `2 agents · 41k` while any runs, `2 agents · done · 41k` after —
   * opening the Running-tasks panel, and the gauge's "+ subagents" line
   * in its hover, so the window figure is not read as the whole.
   */
  const agents = $derived(subagentsOfTurn());
  /** The chip's own rows (backlog 160): the chat's latest turn that had
   *  agents, so `1 agent · done · 31k` stays after the turn and the next. */
  const chipAgents = $derived(latestSubagents());
  /** Chats whose turns run off screen (nightshift backlog 159, A4): the
   *  chip shows while any does, so the Running-tasks panel that lists
   *  them is a click away even in a chat with no subagents. */
  const offScreen = $derived(liveChats().filter((c) => !c.onScreen).length);
  function toggleTasks() {
    app.showRail = false;
    app.showContext = false;
    app.showTasks = !app.showTasks;
  }

  // The popovers: the model one opens from the model chip (or ⌘M, or the
  // ⌘K palette — which is why the flags are app state), the context one
  // from the gauge chip (or ⌘⇧C). The rail closes on Escape, on a click
  // outside it, or on its chip again; opening one closes the other. Context
  // is a centre modal since 2026-09-15 (nightshift backlog 056) — mounted
  // in `App.svelte` on the same overlay as Settings, which handles its
  // own outside click — so only Escape is shared here.
  let popEl = $state<HTMLElement | null>(null);
  let chipEl = $state<HTMLElement | null>(null);
  /** The gauge card (board d, backlog 175): open while true; the bar's
   *  own, since nothing else opens it (⌘⇧C opens the Context page). */
  let showGauge = $state(false);
  let gaugeEl = $state<HTMLElement | null>(null);
  let gaugePopEl = $state<HTMLElement | null>(null);
  function onDocClick(e: MouseEvent): void {
    const t = e.target as Node;
    if (!(popEl?.contains(t) || chipEl?.contains(t))) {
      app.showRail = false;
      showAsideCard = false;
    }
    if (!(gaugePopEl?.contains(t) || gaugeEl?.contains(t))) showGauge = false;
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      app.showRail = false;
      app.showContext = false;
      showGauge = false;
      showAsideCard = false;
    }
  }
  $effect(() => {
    if (!app.showRail && !app.showContext && !showGauge && !showAsideCard) return;
    document.addEventListener("mousedown", onDocClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  });
  function toggleRail() {
    app.showContext = false;
    showGauge = false;
    app.showRail = !app.showRail;
  }
  /** Item 657 (his "the aside * subscription button doesn't do anything",
   *  then "on the normal chat is like the list of settings"): the aside's
   *  chip opens the same settings card, in the same place, scoped to the
   *  aside (`RightRail` → `ProviderRail` given the aside). Its own flag, not
   *  `app.showRail`: a chat bar in another pane opens the chat's card from
   *  that, and must not open with this one. */
  let showAsideCard = $state(false);
  function toggleAsideCard(): void {
    app.showContext = false;
    showGauge = false;
    showAsideCard = !showAsideCard;
  }
  // The card's place, refreshed while it is open on resize and on scroll
  // (backlog 163). ~~From the chip's rectangle~~ — since 2026-09-22 from the
  // bar's (nightshift backlog 180, his word: "it used to be on the right
  // hand side. i think i liked that more"): once the bar wrapped (20392bd)
  // the chip sat mid-window and the card followed it. Back to the pre-163
  // spot — 20 px in from the bar's right end, hanging from its foot — with
  // 163's portal and z-order kept, so the Welcome page's bug stays fixed.
  let barEl = $state<HTMLElement | null>(null);
  let popPos = $state({ top: 0, left: 0 });
  function placePop(): void {
    const el = barEl ?? chipEl;
    if (!el) return;
    const r = el.getBoundingClientRect();
    popPos = anchorBelow({ left: r.left, right: r.right - 20, bottom: r.bottom - 1 }, POP_WIDTH, window.innerWidth, 0);
  }
  $effect(() => {
    if (aside ? !showAsideCard : !app.showRail) return;
    placePop();
    window.addEventListener("resize", placePop);
    window.addEventListener("scroll", placePop, true);
    return () => {
      window.removeEventListener("resize", placePop);
      window.removeEventListener("scroll", placePop, true);
    };
  });
  // ~~`toggleContext` (the gauge chip's click)~~ — the chip opens the gauge
  // card since board d (backlog 175); the card's button is `itemise` below,
  // and ⌘⇧C toggles the page from `state.svelte.ts`.

  // The gauge card's place: right-aligned under the gauge chip, refreshed
  // on resize and scroll while open, as the rail's card is.
  const GAUGE_WIDTH = 320;
  let gaugePos = $state({ top: 0, left: 0 });
  function placeGauge(): void {
    if (!gaugeEl) return;
    const r = gaugeEl.getBoundingClientRect();
    gaugePos = anchorBelow({ left: r.left, right: r.right, bottom: r.bottom }, GAUGE_WIDTH, window.innerWidth, 6);
  }
  $effect(() => {
    if (!showGauge) return;
    placeGauge();
    window.addEventListener("resize", placeGauge);
    window.addEventListener("scroll", placeGauge, true);
    return () => {
      window.removeEventListener("resize", placeGauge);
      window.removeEventListener("scroll", placeGauge, true);
    };
  });
  function toggleGauge() {
    app.showRail = false;
    app.showContext = false;
    showGauge = !showGauge;
  }
  function itemise() {
    showGauge = false;
    app.showRail = false;
    app.showContext = true;
  }
  /** Item 824 (blocker 2123's third call): an aside's card itemises its
   *  chat — the Context page itemises the chat's request — opening that
   *  chat first when another is in front. */
  async function itemiseChat() {
    showGauge = false;
    showAsideCard = false;
    app.showRail = false;
    if (asideChat && asideChat !== app.activeSessionId) await openSession(asideChat);
    app.showContext = true;
  }

  // The folds, by measurement (nightshift backlog 183): on every change of
  // the bar's size — a window resize, a split, ⌘+ — and of what it holds,
  // step the fold level up from 0 until the bar's items sit on one line.
  const FOLD_MAX = 3;
  let rightEl = $state<HTMLElement | null>(null);
  /** Mirrors what `foldToFit` wrote, so the attribute is dynamic markup
   *  (a static one would let Svelte prune the fold rules as unused). */
  let foldAttr = $state("0");
  function refold(): void {
    const bar = barEl;
    if (!bar) return;
    foldAttr = String(foldToFit(
      bar,
      () => [...bar.querySelectorAll(":scope > .left > *, :scope > .right > *")],
      FOLD_MAX,
    ));
  }
  $effect(() => {
    const bar = barEl;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => refold());
    ro.observe(bar);
    if (rightEl) ro.observe(rightEl);
    return () => ro.disconnect();
  });
  $effect(() => {
    // What the bar holds; each read registers the dependency.
    void [
      agents.rows.length,
      agents.running,
      agents.tokens,
      app.turnBudget,
      spend,
      canCompact,
      modeText,
      continuedFrom,
      runSign,
      app.connection,
      gauge == null,
      plan == null,
      planAgeMark,
      openTasks,
      offScreen,
    ];
    refold();
  });

  // ~~The two transcript toggles' key caps, the thinking-cost note (066)
  // and `thinkingDead` (097)~~ — with the toggles, in `Composer.svelte`'s
  // bottom row since backlog 112.

  return {
    get GAUGE_WIDTH() {
      return GAUGE_WIDTH;
    },
    get af() {
      return af;
    },
    get aside() {
      return aside;
    },
    get asideChat() {
      return asideChat;
    },
    get asideRunSign() {
      return asideRunSign;
    },
    get asideChatName() {
      return asideChatName;
    },
    get barEl() {
      return barEl;
    },
    set barEl(v) {
      barEl = v;
    },
    get bell() {
      return bell;
    },
    get canCompact() {
      return canCompact;
    },
    get chipAgents() {
      return chipAgents;
    },
    get chipEl() {
      return chipEl;
    },
    set chipEl(v) {
      chipEl = v;
    },
    get chipTip() {
      return chipTip;
    },
    get continuedFrom() {
      return continuedFrom;
    },
    get dialFigures() {
      return dialFigures;
    },
    get engineName() {
      return engineName;
    },
    get foldAttr() {
      return foldAttr;
    },
    set foldAttr(v) {
      foldAttr = v;
    },
    get gauge() {
      return gauge;
    },
    get gaugeEl() {
      return gaugeEl;
    },
    set gaugeEl(v) {
      gaugeEl = v;
    },
    get gaugePopEl() {
      return gaugePopEl;
    },
    set gaugePopEl(v) {
      gaugePopEl = v;
    },
    get gaugePos() {
      return gaugePos;
    },
    set gaugePos(v) {
      gaugePos = v;
    },
    get gaugeTip() {
      return gaugeTip;
    },
    itemise,
    itemiseChat,
    get landFlash() {
      return landFlash;
    },
    set landFlash(v) {
      landFlash = v;
    },
    get level() {
      return level;
    },
    get liveEst() {
      return liveEst;
    },
    get mainable() {
      return mainable;
    },
    get mode() {
      return mode;
    },
    get modeText() {
      return modeText;
    },
    get modeTitle() {
      return modeTitle;
    },
    get offScreen() {
      return offScreen;
    },
    get openTasks() {
      return openTasks;
    },
    get plan() {
      return plan;
    },
    get planAgeMark() {
      return planAgeMark;
    },
    get planTip() {
      return planTip;
    },
    get popEl() {
      return popEl;
    },
    set popEl(v) {
      popEl = v;
    },
    get popPos() {
      return popPos;
    },
    set popPos(v) {
      popPos = v;
    },
    get rightEl() {
      return rightEl;
    },
    set rightEl(v) {
      rightEl = v;
    },
    get runSign() {
      return runSign;
    },
    get showAsideCard() {
      return showAsideCard;
    },
    set showAsideCard(v) {
      showAsideCard = v;
    },
    get showGauge() {
      return showGauge;
    },
    set showGauge(v) {
      showGauge = v;
    },
    get signedOut() {
      return signedOut;
    },
    get spendTip() {
      return spendTip;
    },
    get threadChipShown() {
      return threadChipShown;
    },
    toggleAsideCard,
    toggleGauge,
    toggleRail,
    toggleTasks,
    tokens,
    get warn() {
      return warn;
    },
    get weekHot() {
      return weekHot;
    },
  };
}
