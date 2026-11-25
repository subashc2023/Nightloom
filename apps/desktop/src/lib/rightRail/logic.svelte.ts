// Item 856 (2026-11-19): the behaviour of RightRail, once. `RightRail.svelte` (Jarvis) and
// `RightRailClassic.svelte` mount this and keep only their markup and CSS; `logic.test.ts` beside it fails when
// one look binds to something the other does not. Moved verbatim from RightRail.svelte's script.
import { ContextDrive } from "../contextDrive.svelte";
import { app, asideReads, asidesOf, chatAgentSession, contextUsed, currentTodos, type Aside } from "../state.svelte";
import * as api from "../api";
import { figuresOf, trackOpenChatFigures } from "../chatFigures.svelte";
import { modelName, spenderName, stackParts, type ScopedLimits, type SessionFigures } from "../usageFigures";
import { mark as handoffMark } from "../handoff.svelte";
import { handOffNow } from "../manualHandoff.svelte";
import { touchedUntil } from "../keepWarm";
import { keepWarm } from "../keepWarm.svelte";
import { cacheState, chipFace, newestReplySentAt, nextTickMs, ownModelCache, remainingText, sideCacheFor, stoppedUnsure } from "../cache";
import { cacheEstimate, lastReply, ratesFromPrice } from "../cacheCost";
import { cacheRatesOf, loadCacheRates } from "../cacheRates.svelte";
import { boxDraftTokens } from "../draftCost.svelte";
import { draftKey } from "../drafts.svelte";
import { asideDraftKey } from "../asides";
import { modelIdFor, modelSwitchPending, nextSendModel, pendingChangeCost } from "../changeCost";
import { modelSeen } from "../modelSeen.svelte";
import { displayName } from "../modelSeen";
import { clockText, freshIn, handoffText, lastLoggedTurn, niceCeil, shortTokens, tickCounts, toolMarks, toolsText } from "../contextDial";
import { liveContextOf } from "../liveContext.svelte";
import { liveFor, liveTokens, liveValue } from "../liveContext";
import { asideFigures } from "../asideFigures";
import { contextOf } from "../chatContext.svelte";

export type RightRailLogicProps = Props;

export interface Props {
  /**
   * Item 533 (Filament IV stage 2): the right column beside the chat —
   * Context (the dial and its three legend lines), Plan use, This turn,
   * Tasks. Without it, the model chip's popover as before (Model · Tasks).
   */
  column?: boolean;
  /**
   * Item 605 (his "shouldn't asides still have cost, context, all of the
   * stuff in the side bar?"): the column beside an aside tab — the same
   * column, reading the aside: its context dial, plan use, This aside
   * (its cost and cache hit), This turn (its newest exchange). No Tasks
   * (the to-do list is the chat's session's) ~~and no cache timer (the
   * timer is the chat's newest reply's)~~ — item 786 (2026-11-17): the
   * cache row too, the chat's timer, since the aside reads that cache.
   * Null: the chat's, as before.
   */
  aside?: Aside | null;
  /** The chat the aside is of (item 605), for its hand-off line. */
  asideChat?: string | null;
}

export type Tab = "connection" | "tasks";

export function rightRailLogic(props: () => RightRailLogicProps) {
  const column = $derived(props().column ?? false);
  const aside = $derived(props().aside ?? null);
  const asideChat = $derived(props().asideChat ?? null);
  let tab = $state<Tab>("connection");

  const open = $derived(
    currentTodos().filter((t) => t.status !== "completed").length,
  );

  /**
   * Model and Tasks only (review round 1, 2026-09-13). The Context tab
   * left for its own popover under the top bar's gauge — which also ended
   * the engine special-case here: the tab used to be dropped on Claude
   * Code, and the popover explains that instead of hiding it.
   */
  const TABS: { id: Tab; label: string }[] = [
    { id: "connection", label: "Model" },
    { id: "tasks", label: "Tasks" },
  ];

  // ---- the column's readings (item 533). Each comes from what the app
  // already holds; a reading it does not hold is left out, never drawn
  // from a guess.

  /**
   * Item 590: while a reply runs, the live reading — the last exact figure
   * plus an estimate of what has streamed since — in place of the last
   * round's. (Declared before `used`; `live` and `logged` are below.)
   */
  let now = $state(Date.now());
  /** Item 605: the aside's own figures, on the column's clock (declared
   *  here, before the readings that use it). */
  /** Item 639: the chat's last context reading — the prefix every aside of
   *  it forks from — for an aside that kept no tokens (answered before 605). */
  const asideBase = $derived.by(() => {
    if (!column || !aside || !asideChat) return null;
    if (asideChat === app.activeSessionId) return contextUsed() ?? contextOf(asideChat)?.used ?? null;
    return contextOf(asideChat)?.used ?? null;
  });
  const af = $derived(column && aside ? asideFigures(aside, now, asideBase) : null);
  /** Item 639: the dial's figure is an estimate (no turn kept its tokens). */
  const est = $derived(af?.estimated ?? null);
  const liveCtx = $derived(
    column && !aside && app.busy && app.live != null
      ? liveFor(liveContextOf(app.activeSessionId), lastLoggedTurn(app.events)?.startedAt ?? null)
      : null,
  );
  /** Context: the next request's prefix over the window (the top bar's gauge's figures). */
  const used = $derived(column ? (af ? af.used : liveCtx ? liveTokens(liveCtx) : contextUsed()) : null);
  const limit = $derived(app.connection?.contextLimit ?? (aside && asideChat ? contextOf(asideChat)?.limit || null : null));
  const share = $derived(used != null && limit ? Math.min(used / limit, 1) : 0);
  /** Item 590: the estimated tail of the arc, as a share of the window. */
  const estShare = $derived(liveCtx && liveCtx.estimate > 0 && limit ? Math.min(liveCtx.estimate / limit, share) : null);
  /** Item 590: each exact step swells the column's motion (587's language). */
  const stepKey = $derived(liveCtx ? `${app.activeSessionId ?? ""}:${liveCtx.steps}` : "");
  /** The hand-off line: the chat's own mark, else the Settings percent or token cap (backlog 436). */
  const markShare = $derived(limit ? handoffMark(aside ? asideChat : app.activeSessionId, limit) : null);
  const markTokens = $derived(limit && markShare != null ? Math.round(markShare * limit) : null);
  const ticks = $derived(tickCounts(limit));
  const handoffLine = $derived(handoffText(used, markTokens));

  /**
   * The prompt cache (backlog 063): the newest live reply's entry. The
   * clock wakes when the text would change — once a minute, then once a
   * second under two minutes — and not at all once cold, so an idle
   * column with a cold cache has no timer.
   */
  // Item 786: an aside's column times its chat's cache too (it reads the
  // chat's prefix, item 732) while that chat is the open one; an aside on
  // another model times its own answers' cache (`ownModelCache`).
  const railChat = $derived(aside ? (asideChat === app.activeSessionId ? asideChat : null) : app.activeSessionId);
  const railOwnModel = $derived(
    !!aside?.model && displayName(aside.model) !== (app.draft.agentModel.trim() ? displayName(app.draft.agentModel) : "default"),
  );
  const chatCache = $derived(
    !column || (aside && !railChat)
      ? null
      : aside && railOwnModel
        ? ownModelCache(aside.turns, now)
        : cacheState(app.events, now, railChat ? touchedUntil(keepWarm.byChat[railChat]) : null, asideReads(railChat, lastReply(app.events)?.model)),
  );
  // Item 959: as the composer's chip — a switch pending onto a model an
  // aside wrote the chat on meets that entry (`sideCacheFor`).
  const sideCache = $derived(
    !aside && railChat && chatCache && app.connection?.engine === "claude-code" && modelSwitchPending(app.events, app.draft.agentModel, modelSeen.byAlias)
      ? sideCacheFor(asidesOf(railChat), modelIdFor(app.draft.agentModel, modelSeen.byAlias), newestReplySentAt(app.events), now)
      : null,
  );
  const cache = $derived(sideCache ?? chatCache);
  /** Item 786: cold after a stop that logged no reply reads "unknown". */
  const railFace = $derived(chipFace(cache, !aside && !!cache && !cache.warm && stoppedUnsure(app.events, app.busy)));
  $effect(() => {
    if (!cache || !cache.warm) return;
    const wait = nextTickMs(cache.remainingMs);
    if (wait == null) return;
    const id = setTimeout(() => (now = Date.now()), wait);
    return () => clearTimeout(id);
  });
  const TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;
  const cacheShare = $derived(cache ? Math.max(0, cache.remainingMs) / TTL_MS[cache.ttl] : null);
  const cacheLeft = $derived(cache ? remainingText(cache.remainingMs) : null);
  /** Item 699's price fix (2026-11-16): the next send's API-price estimate,
   *  as the composer's chip gives it — the column's cache row had none. */
  // Item 777: a pending model switch is priced at the new model (cold too).
  const nextModel = $derived(cache ? nextSendModel(app.events, aside?.model || app.draft.agentModel, modelSeen.byAlias) : null);
  $effect(() => {
    if (nextModel && app.connection?.engine === "claude-code") void loadCacheRates(nextModel);
  });
  /** Item 904: the draft in the box this column speaks for (the chat's, or
   *  the aside's), priced into the next send as the composer's chip does. */
  const railDraft = $derived(
    cache
      ? boxDraftTokens(aside ? asideDraftKey(aside) : draftKey(app.activeSessionId, app.project?.id, app.pendingMode, app.pendingThread), app.connection?.engine)
      : 0,
  );
  /** Item 777: with a change pending on a warm cache, the price with it
   *  (the composer's bar gives both), so the two never disagree. */
  const pendingCost = $derived(
    cache?.warm && !aside
      ? pendingChangeCost({
          events: app.events,
          draft: app.draft,
          connection: app.connection,
          seen: modelSeen.byAlias,
          warm: true,
          rates: (m) => {
            if (m && app.connection?.engine === "claude-code") void loadCacheRates(m);
            return cacheRatesOf(m);
          },
          sideWarm: !!sideCache,
          draftTokens: railDraft,
        })
      : null,
  );
  const nextEst = $derived.by(() => {
    if (!cache) return null;
    const est = cacheEstimate(app.events, app.connection?.engine === "claude-code" ? cacheRatesOf(nextModel) : ratesFromPrice(app.connection?.price), cache.warm, railDraft);
    const p = pendingCost?.price.with;
    // 777's with-change price; 776's *Once cold* row still needs the cold figure.
    if (p != null) return { usd: p, title: `With the pending change · ${pendingCost!.title}`, cold: est?.cold ?? null };
    return est;
  });

  /**
   * Item 654 (his pick B3, blocker 1962): the column's dial moves with a
   * reply — the drive (`dialDrive.ts`) follows the live reading while one
   * runs (the chat's `liveCtx`; an aside's figure as it lands) and runs the
   * landing when it ends; ContextDial draws its layer, DialMotion's gears
   * count its tokens. At rest it holds still, as before.
   */
  const drive = new ContextDrive();
  $effect(() => {
    if (!column || used == null || !limit) return;
    drive.set({
      exact: liveCtx ? liveCtx.exact : used,
      estimate: liveCtx ? liveCtx.estimate : 0,
      limit,
      streaming: live,
      ticks: ticks.minor,
    });
  });
  $effect(() => () => drive.destroy());
  const dv = $derived(column && used != null && limit ? drive.view : null);
  /** The figure: the drive's count while it moves, `~` while it is an estimate. */
  const dialValue = $derived.by(() => {
    if (dv && used != null) {
      const estimating = dv.estimating || (liveCtx != null && liveCtx.estimate > 0);
      return `${estimating || est ? "~" : ""}${shortTokens(dv.figure)}`;
    }
    return liveCtx ? liveValue(liveCtx, shortTokens) : used != null ? `${est ? "~" : ""}${shortTokens(used)}` : "—";
  });

  /** Plan use (backlog 073): the Claude Code engine's five-hour and week, account-wide. */
  const plan = $derived.by(() => {
    if (!column || app.connection?.engine !== "claude-code") return null;
    const u = app.planUsage;
    if (!u || u.source === "none" || u.five_hour == null) return null;
    return u;
  });

  /**
   * This turn: while one runs, the live reply's calls and the newest
   * request's usage, the clock from his message; idle, the last turn as
   * the log has it, its clock stopped.
   */
  const logged = $derived(column && !aside ? lastLoggedTurn(app.events) : null);
  const live = $derived(af ? !!af.turn?.live : column && app.busy && app.live != null);
  $effect(() => {
    if (!live) return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const turnClock = $derived.by(() => {
    if (af) return af.turn?.ms != null ? clockText(af.turn.ms) : null;
    if (!logged?.startedAt) return null;
    if (live) return clockText(now - logged.startedAt);
    return logged.endedAt != null && logged.endedAt >= logged.startedAt ? clockText(logged.endedAt - logged.startedAt) : null;
  });
  const marks = $derived(
    aside ? toolMarks(aside.turns[aside.turns.length - 1]?.segments ?? []) : live ? toolMarks(app.live?.segments ?? []) : (logged?.tools ?? []),
  );
  const turnUsage = $derived(af ? (af.turn?.usage ?? null) : live ? app.liveUsage : (logged?.usage ?? null));
  const inTokens = $derived(freshIn(turnUsage));
  /** Item 639: an aside answer that kept no tokens: its output estimated from its text. */
  const outEst = $derived(!turnUsage && af?.turn?.estOut != null);
  const outTokens = $derived(turnUsage ? turnUsage.output_tokens : (af?.turn?.estOut ?? null));
  const ioScale = $derived(niceCeil(Math.max(inTokens ?? 0, outTokens ?? 0)));
  const toolsLine = $derived(toolsText(marks));
  const hasTurn = $derived(turnClock != null || inTokens != null || outTokens != null || toolsLine != null);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  /**
   * Item 585: the new-chat layers the column's dial draws. Item 587 (his "add
   * the gear and vibrating thing to the context wheel too", then "the same new
   * chat animatiosn"): every new-chat layer, in DialMotion's column form, which
   * keeps them in the band outside the figure. (Null: all layers.)
   */
  const COLUMN_LAYERS = null;
  /** Item 587: the 5-hour hand, from the same plan use the column shows below. */
  const motionPlan = $derived(plan ? { used: plan.five_hour ?? null, resetsAt: plan.five_hour_resets_at ?? null } : null);
  /** Item 587: his keys in a composer surge the column's ring, as they do the new-chat dial's. */
  let keys = $state(0);
  $effect(() => {
    if (!column) return;
    const on = (e: Event) => {
      const el = e.target as Element | null;
      if (el?.closest?.(".composer")) keys++;
    };
    document.addEventListener("input", on, { passive: true });
    return () => document.removeEventListener("input", on);
  });

  // ---- item 569: Claude Code's /usage figures. The account's per-model
  // weeklies (the CLI cache) under Plan use; this chat's own totals (its
  // transcript's `cost-state`) in This chat. Neither is drawn from a guess:
  // a figure the files do not hold is left out.
  const claudeCode = $derived(column && app.connection?.engine === "claude-code");
  let scoped = $state<ScopedLimits | null>(null);
  $effect(() => {
    if (!claudeCode) return;
    // Re-read whenever the plan reading moves (its five-minute refresh rewrites the cache).
    void app.planUsage?.sampled_at_ms;
    let gone = false;
    api
      .planScopedLimits()
      .then((s) => {
        if (!gone) scoped = s;
      })
      .catch(() => {});
    return () => (gone = true);
  });
  const agentSession = $derived(claudeCode && !aside ? chatAgentSession(app.events) : null);
  // Item 675: read through the store the top bar's "Spent" reads too
  // (`chatFigures.svelte.ts`), over every CLI session the chat has run on
  // — a rewind no longer lowers the cost. A turn's end writes the newest
  // totals: the store reads again when one ends.
  $effect(() => {
    if (claudeCode) trackOpenChatFigures();
  });
  /** Only the open chat's figures: another chat's never show while this one's load. */
  const chat = $derived<SessionFigures | null>(figuresOf(agentSession));
  // Item 584: the two splits as stacked bars, and the Details fold (kept across chats and restarts).
  const modelParts = $derived(chat ? stackParts(chat.models.map((m) => ({ name: modelName(m.model), value: m.cost_usd }))) : []);
  const usingParts = $derived(chat ? stackParts(chat.using.map((u) => ({ name: spenderName(u), value: u.share }))) : []);
  const DETAILS_KEY = "nightloom.chatDetails";
  let details = $state(readDetails());
  function readDetails(): boolean {
    try {
      return localStorage.getItem(DETAILS_KEY) === "1";
    } catch {
      return false;
    }
  }
  function toggleDetails() {
    details = !details;
    try {
      localStorage.setItem(DETAILS_KEY, details ? "1" : "0");
    } catch {
      /* the fold still works for this run */
    }
  }

  /** Item 926: *Hand off now* — the one hand-off path, launched from the
   *  button (the send motion's flight); `handing` lights Send's edge trace
   *  on it (Jarvis) until the send returns. */
  let handing = $state(false);
  function handOff(from: Element | null): void {
    handing = true;
    void handOffNow(undefined, from).finally(() => (handing = false));
  }

  return {
    handOff,
    get handing() {
      return handing;
    },
    get COLUMN_LAYERS() {
      return COLUMN_LAYERS;
    },
    get TABS() {
      return TABS;
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
    get cache() {
      return cache;
    },
    get cacheLeft() {
      return cacheLeft;
    },
    get cacheShare() {
      return cacheShare;
    },
    get chat() {
      return chat;
    },
    get column() {
      return column;
    },
    get details() {
      return details;
    },
    set details(v) {
      details = v;
    },
    get dialValue() {
      return dialValue;
    },
    get drive() {
      return drive;
    },
    get dv() {
      return dv;
    },
    get est() {
      return est;
    },
    get estShare() {
      return estShare;
    },
    get handoffLine() {
      return handoffLine;
    },
    get hasTurn() {
      return hasTurn;
    },
    get inTokens() {
      return inTokens;
    },
    get ioScale() {
      return ioScale;
    },
    get keys() {
      return keys;
    },
    set keys(v) {
      keys = v;
    },
    get limit() {
      return limit;
    },
    get live() {
      return live;
    },
    get liveCtx() {
      return liveCtx;
    },
    get markShare() {
      return markShare;
    },
    get markTokens() {
      return markTokens;
    },
    get marks() {
      return marks;
    },
    get modelParts() {
      return modelParts;
    },
    get motionPlan() {
      return motionPlan;
    },
    get nextEst() {
      return nextEst;
    },
    get open() {
      return open;
    },
    get outEst() {
      return outEst;
    },
    get outTokens() {
      return outTokens;
    },
    get pct() {
      return pct;
    },
    get plan() {
      return plan;
    },
    get railFace() {
      return railFace;
    },
    get railOwnModel() {
      return railOwnModel;
    },
    get scoped() {
      return scoped;
    },
    set scoped(v) {
      scoped = v;
    },
    get share() {
      return share;
    },
    get stepKey() {
      return stepKey;
    },
    get tab() {
      return tab;
    },
    set tab(v) {
      tab = v;
    },
    get ticks() {
      return ticks;
    },
    toggleDetails,
    get toolsLine() {
      return toolsLine;
    },
    get turnClock() {
      return turnClock;
    },
    get used() {
      return used;
    },
    get usingParts() {
      return usingParts;
    },
  };
}
