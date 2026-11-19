<script lang="ts">
  // Item 824: the Context and Plan card is design B, Dials.
  import PlanDials from "./PlanDials.svelte";
  import { hudIn, hudOut } from "./hudMenu";
  import { app, compactSession, MODE_GLYPH, chatKind, kindLabel, openSession } from "./state.svelte";
  import ContextDial from "./ContextDial.svelte";
  import { mark as handoffMark } from "./handoff.svelte";
  import { connectionWord, launch } from "./launch.svelte";
  import { budgetChip, budgetTitle } from "./budget";
  import RightRail from "./RightRail.svelte";
  import { portal } from "./portal";
  import { tip } from "./tip";
  import ZoomChip from "./ZoomChip.svelte";
  import NotificationCentre from "./NotificationCentre.svelte";
  import ForYouButton from "./ForYouButton.svelte";
  import { makeMainChat } from "./versions.svelte";
  import ThreadChip from "./ThreadChip.svelte";
  // Item 556: the open chat's own running sign, at the bar's left.
  import ChatRunSign from "./ChatRunSign.svelte";
  import { displayName } from "./modelSeen";
  import { topBarLogic, type TopBarLogicProps } from "./topBar/logic.svelte";

  // Item 856: the behaviour lives once, in `topBar/logic.svelte.ts`; this file is the look.
  const props: TopBarLogicProps = $props();
  const T = topBarLogic(() => props);
</script>

<header class="topbar" bind:this={T.barEl} data-fold={T.foldAttr}>
  <!-- ~~The title and the short id~~ — board d (backlog 175): the tab is
       the title, its hover the id. The mode mark and "continued from"
       stay, at the bar's left, when a chat has one. -->
  {#if !T.aside && (T.runSign !== "idle" || T.modeText || T.continuedFrom || T.threadChipShown || T.mainable)}
    <div class="left">
      <!-- The chat's research thread (nightshift backlog 281): first on
           the left, where the title row's name used to be — the tab names
           the chat, this says what it works from. -->
      <!-- Item 556: whether this chat runs — first, so it is seen. -->
      <ChatRunSign />
      <ThreadChip />
      {#if T.modeText}
        <span class="mode {T.mode}" use:tip={T.modeTitle}
          ><span aria-hidden="true">{MODE_GLYPH[T.mode]}</span><span class="fold2"> {T.modeText}</span></span
        >
      {/if}
      {#if T.continuedFrom}
        <button
          class="continued"
          use:tip={"This chat continues a full one from its HANDOFF.md — click to open the earlier chat"}
          onclick={() => void openSession(T.continuedFrom!.id)}
        >
          <span aria-hidden="true">↳</span><span class="fold1"> continued from {T.continuedFrom.line}</span>
        </button>
      {/if}
      {#if T.mainable && app.activeSessionId}
        {@const sid = app.activeSessionId}
        <button
          class="continued make-main"
          use:tip={"This chat is a version of another: Make main puts it in that chat's row, name and place, and keeps the other as a version (‹ › under the edited message)"}
          onclick={() => void makeMainChat(sid)}
        >
          <span class="mm-icon" aria-hidden="true">⑂</span><span class="fold3">Make main</span>
        </button>
      {/if}
    </div>
  {/if}

  <div class="right" bind:this={T.rightEl}>
    {#if !T.aside}<ZoomChip />{/if}
    <!-- The kind chip (nightshift backlog 102; blocker 141's final form
         since backlog 112): `Claude Code · subscription`, `Chat ·
         subscription`, `Build · anthropic`, `Chat · anthropic` — the kind
         and the engine, no model. The model's name is the composer's
         button; this chip still opens the rail, where the model is. -->
    {#if T.aside}
      <!-- Item 605: the aside's kind chip. ~~Not a button: the model and
           effort are the composer's buttons, and the model popover is the
           chat's~~ — item 657 (his "doesn't do anything"): a button that
           opens the same settings card as the chat's chip, scoped to the
           aside — its model and effort its own, the rest the chat's. -->
      <button
        class="ns-chip model aside-kind"
        class:open={T.showAsideCard}
        bind:this={T.chipEl}
        aria-expanded={T.showAsideCard}
        use:tip={`An aside: answered from ${T.asideChatName}'s context on the Claude Code engine, never part of it — its model (${T.af?.model ? displayName(T.af.model) : "the chat's"}), effort and settings, click to open`}
        onclick={T.toggleAsideCard}
      >
        <span class="dot" class:unknown={!app.connection} class:failed={!!T.signedOut}></span>
        <span class="model-name">Aside<span class="fold2">{" · "}{T.engineName || "subscription"}</span></span>
      </button>
    {:else}
    <button
      class="ns-chip model"
      class:open={app.showRail}
      bind:this={T.chipEl}
      use:tip={app.connection
        ? `${kindLabel(chatKind(app.events), app.connection.engine)} · ${T.engineName} — model and tasks, click to open (⌘M)`
        : "Model and tasks — click to open (⌘M)"}
      aria-expanded={app.showRail}
      onclick={T.toggleRail}
    >
      <span class="dot" class:unknown={!app.connection} class:failed={!!T.signedOut}></span>
      {#if app.connection}
        <span class="model-name"
          >{kindLabel(chatKind(app.events), app.connection.engine)}<span class="fold2">{" · "}{T.engineName}</span></span
        >
      {:else}
        <!-- "not connected" only once it is true (item 220): while the
             launch connect or any connect runs, "connecting…". -->
        <span class="annotation"
          >{connectionWord({
            connected: false,
            connecting: app.connecting,
            launchConnectSettled: launch.connectSettled,
          })}</span
        >
      {/if}
      {#if T.openTasks > 0}<span class="badge" use:tip={`${T.openTasks} open tasks`}>{T.openTasks}</span>{/if}
    </button>
    {/if}

    <!-- The gauge chip (board d, nightshift backlog 175 pass 2): the
         context gauge and the plan chip made one — two thin bars, context
         (amber, warm and hot as before) over the plan's five hours (the
         live blue), and the plan reading's age (his "4m", 2026-09-18).
         ~~Its click opens the Context page~~ — it opens the gauge card with
         every figure; the card's button and ⌘⇧C open the Context page.
         Every figure is also in the chip's hover. Before any usage it reads
         "Context", and with no known window the raw count stands in for
         the bar. -->
    {#if app.connection}
      <button
        class="ns-chip mono gauge {T.level}"
        class:open={T.showGauge}
        class:stale={T.plan?.stale}
        class:warn80={T.warn != null}
        aria-expanded={T.showGauge}
        bind:this={T.gaugeEl}
        use:tip={T.chipTip}
        onclick={T.toggleGauge}
      >
        <!-- Item 595 ("either both dials or both bars"): ~~a 13 px context
             ring over a 48 px blue five-hour bar, the age at the right~~ —
             one form for every reading: a small dial with its figure
             beside it, context then the five-hour window, on one centre
             line; each reading names itself in its own hover. The
             five-hour dial takes the rail's colour for it (amber), so the
             two read as one pair; the context arc turns orange past the
             hand-off mark as before. -->
        {#if T.gauge || T.plan}
          {#if T.gauge}
            <span class="reading" data-reading="context" use:tip={T.gaugeTip}>
              {#if T.gauge.ratio != null}
                <ContextDial
                  size={14}
                  stroke={2.5}
                  pad={2}
                  minor={0}
                  major={0}
                  share={T.gauge.ratio}
                  mark={handoffMark(T.aside ? T.asideChat : app.activeSessionId, T.gauge.limit)}
                  label={`Context ${Math.round(T.gauge.ratio * 100)}%`}
                />
              {/if}
              <span class="figure" class:dimmed={T.liveEst} class:landed={T.landFlash}>{T.af?.estimated || T.liveEst ? "~" : ""}{T.tokens(T.gauge.used)}</span>
            </span>
          {/if}
          {#if T.plan}
            <span class="reading" data-reading="five-hour" use:tip={T.planTip}>
              <ContextDial
                size={14}
                stroke={2.5}
                pad={2}
                minor={0}
                major={0}
                share={Math.min(T.plan.five_hour ?? 0, 100) / 100}
                label={`5-hour window ${T.plan.five_hour}%`}
              />
              <span class="figure">{T.plan.five_hour}%</span>
              {#if T.weekHot}<span class="of week-hot">wk {T.plan.seven_day}%</span>{/if}
              <span class="of plan-age">{T.planAgeMark}</span>
            </span>
          {/if}
        {:else}
          <span class="figure sans">Context</span>
        {/if}
      </button>
    {/if}

    <!-- The agents chip (nightshift backlog 152): the latest turn's
         subagents and their tokens, opening the Running-tasks panel. Shown
         while any runs and kept, quieter, once all are done, so a finished
         agent's transcript stays a click away — ~~until the next turn~~
         since backlog 160 until a later turn spawns agents: the chip reads
         the chat's latest turn that had any (`chipAgents`). -->
    {#if !T.aside && (T.chipAgents.rows.length > 0 || T.offScreen > 0)}
      <button
        class="ns-chip mono agents"
        class:live={T.chipAgents.running > 0 || T.offScreen > 0}
        class:open={app.showTasks}
        aria-expanded={app.showTasks}
        use:tip={`${T.offScreen > 0 ? `${T.offScreen} chat${T.offScreen === 1 ? "" : "s"} running off screen · ` : ""}${T.chipAgents.rows.length} subagent${T.chipAgents.rows.length === 1 ? '' : 's'} in this chat's latest turn with agents${T.chipAgents.running > 0 ? `, ${T.chipAgents.running} running` : ', all done'} · ${T.chipAgents.tokens.toLocaleString()} tokens (the CLI's figure per agent, not in the context gauge) — click for the Running-tasks panel${app.turnBudget ? `\n${budgetTitle(app.turnBudget)}` : ''}`}
        onclick={T.toggleTasks}
      >
        <span class="figure">
          {#if T.chipAgents.rows.length > 0}
            <span>{T.chipAgents.rows.length} agent{T.chipAgents.rows.length === 1 ? "" : "s"}</span>
            <!-- Running or done, from the same rows the Running-tasks page
                 counts (backlog 331). -->
            {#if T.chipAgents.running === 0}<span class="of fold1">· done</span>{:else}<span class="of">· {T.chipAgents.running} running</span>{/if}
          {/if}
          <!-- Chats running off screen (A4). -->
          {#if T.offScreen > 0}<span class:of={T.chipAgents.rows.length > 0}>{T.chipAgents.rows.length > 0 ? "· " : ""}{T.offScreen} chat{T.offScreen === 1 ? "" : "s"} running</span>{/if}
          <!-- No figure when none is known (a row rebuilt from a log whose
               result carried none), rather than a bare `· 0`. -->
          {#if T.chipAgents.tokens > 0}<span class="of fold3">· {T.tokens(T.chipAgents.tokens)}</span>{/if}
          <!-- The message's budget meter (backlog 165, pass 2): spent of
               budget, in window percent, as the hook's ledger moves. -->
          {#if app.turnBudget && budgetChip(app.turnBudget)}<span class="of budget" class:stopped={!!app.turnBudget.stopped}>· {budgetChip(app.turnBudget)}</span>{/if}
        </span>
      </button>
    {/if}

    <!-- ~~The plan chip (backlog 073) and the spend chip~~ — folded into
         the gauge chip and its card (board d, backlog 175 pass 2,
         2026-09-22); every figure they showed is in the card and the
         chip's hover. ~~The two transcript toggles (backlog 052) and the
         cache chip (063)~~ — the composer's bottom row since backlog 112. -->

    <!--
      Compaction and nothing else. The settings gear used to sit beside it and
      moved up into the window's title bar, where it belongs: this bar describes
      the conversation — which model, how full its window is, what it has cost —
      and settings are about the app.
    -->
    {#if T.canCompact}
      <button
        class="ns-btn ghost small"
        use:tip={"Replace earlier turns with a model-written summary"}
        onclick={() => void compactSession()}
        disabled={app.busy}
      >
        {app.busy ? "…" : "Compact"}
      </button>
    {/if}
    <!-- New terminal (nightshift backlog 113, agent M's hunk): a shell
         docked under the chat, at the right end of the chips (board 12a). -->
    <!-- ~~<TerminalButton />~~ — the sidebar's foot beside Settings since
         2026-09-18 (his words: "move the terminal button to the bottom row
         … right next to the settings button; that might save some space"). -->
    <!-- The bell (nightshift backlog 069, agent I's hunk): what waits on
         him, five kinds; the Nightshift header carries the same one. -->
    <!-- Files for you (nightshift backlog 377): what the model marked for
         him, a dot for new ones. -->
    {#if T.bell}
      <ForYouButton />
      <NotificationCentre />
    {/if}
  </div>

  {#if T.aside ? T.showAsideCard : app.showRail}
    <!-- Portalled to body and placed by the chip's rectangle (backlog 163):
         inside the bar's stacking context it painted under the Welcome
         page's floating composer and off its chip. Item 657: an aside's
         bar opens the same card from its chip, scoped to the aside. -->
    <div
      class="popover hud-m"
      bind:this={T.popEl}
      use:portal
      in:hudIn|global
      out:hudOut|global
      style="top: {T.popPos.top}px; left: {T.popPos.left}px"
    >
      <RightRail aside={T.aside} asideChat={T.asideChat} />
    </div>
  {/if}
  {#if T.showGauge && app.connection}
    <!-- The gauge card (board d, backlog 175 pass 2): every figure the
         context gauge, the plan chip and the spend chip carried, portalled
         and placed under the gauge chip as the rail's card is (163). -->
    <div
      class="gauge-card hud-m"
      role="dialog"
      aria-label="Context and plan"
      data-card="dials"
      bind:this={T.gaugePopEl}
      use:portal
      in:hudIn|global
      out:hudOut|global
      style="top: {T.gaugePos.top}px; left: {T.gaugePos.left}px; width: {T.GAUGE_WIDTH}px"
    >
      <!-- Item 824: design B, Dials — ~~the rows with pace sentences and the
           source foot~~ (his "bunch of yap on this page"). -->
      <PlanDials
        figures={T.dialFigures}
        spendTip={T.spendTip}
        itemise={T.aside ? { label: "Itemise chat", onclick: () => void T.itemiseChat() } : { label: "Itemise", key: "⌘⇧C", onclick: T.itemise }}
      />
    </div>
  {/if}
  <!-- The Context page is no longer a popover here: it opens as a centre
       modal from `App.svelte` (2026-09-15), on the same overlay as
       Settings. The chip above still toggles `app.showContext`. -->
</header>

<style>
  .topbar {
    position: relative;
    /* ~~The bar is a CSS container (backlog 129)~~ — no longer (backlog
       183, 2026-09-22: under WebKit page zoom a container query reads the
       width × the zoom); it folds by measurement (`fold.ts`, `data-fold`).
       It stays a stacking context lifted a step over `.content` — which
       follows it in the DOM. Under the overlays (20), the find bar (10 is
       inside `.content`, whose own context this does not enter) and the
       toasts. */
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
    padding: 0 16px;
    /* ~~52px~~ — 44 px with the title row gone (board d, backlog 175);
       ~~44~~ 40 since item 534, the tab strip's 38 and a hair. */
    min-height: 40px;
    /* Past the three folds the bar wraps to a second line rather than
       clipping its last chip (his screenshot at ⌘+ zoom, 2026-09-18:
       "≥$0.0" cut at the edge — the gauge grew a week bar after 129
       measured the folds). `min-height`, so a one-line bar is unchanged. */
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .left {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  /* ~~`.title` and `.crumb`~~ — gone with the title row (board d,
     backlog 175, 2026-09-22); the tab's hover carries the id. */
  /* The mode mark: the crumb's size, a shade brighter so it reads as a
     state and not as an id. */
  .mode {
    font-size: 11.5px;
    color: var(--text);
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The hand-off's trace (backlog 086): the mode mark's size, a button
     because it opens the earlier chat. */
  .continued {
    font-size: 11.5px;
    color: var(--dim);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: var(--sans);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .continued:hover {
    color: var(--ink);
  }
  /* Make main (item 555, his report 2026-11-10: the folded ⑂ alone was
     tiny and sank into the background): an accent pill that keeps its
     words until the last fold level and never shrinks away. */
  .continued.make-main {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font-weight: 600;
    overflow: visible;
  }
  .continued.make-main:hover {
    background: color-mix(in srgb, var(--accent) 24%, transparent);
    color: var(--ink);
  }
  .make-main .mm-icon {
    font-size: 14px;
    line-height: 1;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    /* ~~flex-shrink: 0~~ — with the cluster unshrinkable its width was its
       content's, so `flex-wrap` on it never had a bound to wrap at and the
       last chip still ran off the edge at 175% (his screenshot, 2026-09-18,
       after 20392bd). Bounded to the bar, it shrinks and wraps its chips. */
    flex-shrink: 1;
    min-width: 0;
    max-width: 100%;
    flex-wrap: wrap;
    justify-content: flex-end;
    row-gap: 4px;
    /* With no title on the left, the cluster keeps the right end. */
    margin-left: auto;
  }
  /* The folds, by measurement (backlog 183; ~~three `@container topbar`
     steps at 1000 / 860 / 700 px~~, which WebKit's page zoom fired a step
     late). `refold()` sets `data-fold` to the first level at which the
     bar's items sit on one line. Level 1: the agents chip's "· done" and
     "continued from"'s words. Level 2: the kind chip's engine and the mode
     mark's words. Level 3: the agents chip's token count, and the gauge's
     bars and the kind chip narrow. Every folded word is in a hover. */
  .topbar:is([data-fold="1"], [data-fold="2"], [data-fold="3"]) .fold1 {
    display: none;
  }
  .topbar:is([data-fold="2"], [data-fold="3"]) .fold2 {
    display: none;
  }
  .topbar[data-fold="3"] .fold3 {
    display: none;
  }
  /* ~~`.gbar { width: 36px }`~~ — item 595: the bars are dials now; at
     level 3 the plan reading's age folds into its hover instead. */
  .topbar[data-fold="3"] .plan-age {
    display: none;
  }
  .topbar[data-fold="3"] .model {
    max-width: 200px;
  }
  .topbar[data-fold="3"] .right {
    gap: 6px;
  }

  .model {
    cursor: pointer;
    font-family: var(--sans);
    max-width: 380px;
  }
  .model.open,
  .model:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .model-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .annotation {
    color: var(--dim);
  }
  .badge {
    background: var(--accent);
    color: var(--paper);
    border-radius: 999px;
    font-size: 10px;
    line-height: 1;
    padding: 2px 5px;
    font-variant-numeric: tabular-nums;
  }

  .gauge {
    font-variant-numeric: tabular-nums;
    color: var(--ink2);
  }
  .gauge {
    cursor: pointer;
  }
  .gauge.open,
  .gauge:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  /* The agents chip (backlog 152): the live blue while a child runs,
     the gauge's grey once all are done. */
  .agents {
    cursor: pointer;
    color: var(--ink2);
  }
  .agents.live {
    color: var(--live);
    border-color: var(--live-soft);
  }
  .agents.open,
  .agents:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .figure.sans {
    font-family: var(--sans);
  }
  .figure {
    display: inline-flex;
    gap: 5px;
  }
  .of {
    color: var(--dim);
  }
  /* The budget meter once the hook has refused (backlog 165 pass 2; the
     class was set with no rule until the review of 44ab834). */
  .of.budget.stopped {
    color: var(--failed);
  }
  /* ~~`.bar`, `.plan`, `.plan .figure`, `.spend`~~ — the old gauge's,
     plan chip's and spend chip's; board d's are `.gbar` and the card's. */
  /* ~~`.fill`, `.plan-fill`~~ — the old card's bars (item 824: dials). */
  .gauge.hot {
    color: var(--failed);
  }
  /* ~~The gauge chip (board d): context over plan, two 3 px bars
     (`.gauge .bars`, `.gbar`)~~ — item 595: two readings side by side,
     each an 18 px dial and its figure, sharing one centre line. */
  .gauge {
    gap: 10px;
  }
  .gauge .reading {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
  }
  .gauge .reading .figure {
    color: var(--ink);
  }
  /* Item 614 ("why tf is it still off centered"): app.css's `.ns-chip svg
     { 14px }` drew each dial's 18 px SVG at 14 px in the top-left of its
     18 px box, so the ring sat 2 px above the figures' midline and 4 px
     too far from its figure. The box now shrinks to the SVG (same 14 px
     ring as before), centred on the line; the left padding gives back the
     ring's stroke inset (0.6 px) so the ink is equally padded each side. */
  .gauge .reading :global(.dial) {
    width: auto !important;
    height: auto !important;
  }
  .right > .ns-chip.gauge {
    padding-left: 9.5px;
  }
  .gauge.hot .reading[data-reading="context"] .figure {
    color: var(--failed);
  }
  /* Item 654: an estimate reads dimmed; the landing flashes once (motion only). */
  .gauge .reading .figure.dimmed {
    color: var(--ink2);
  }
  @media (prefers-reduced-motion: no-preference) {
    .gauge .reading[data-reading="context"] .figure {
      transition: color 500ms ease;
    }
    .gauge .reading[data-reading="context"] .figure.landed {
      color: var(--accent-ink);
      transition: color 80ms ease;
    }
  }
  .gauge .plan-age {
    font-size: 11px;
  }
  .gauge.stale .plan-age {
    font-style: italic;
  }
  /* Item 769: past 80% of either window (his stop line) the plan's
     figure turns the partial colour, and a hot week shows beside it. */
  .gauge.warn80 .reading[data-reading="five-hour"] .figure,
  .gauge .week-hot {
    color: var(--partial);
    font-weight: 600;
  }
  .gauge .week-hot {
    font-size: 11px;
  }
  /* The gauge card: the rail card's frame around PlanDials (item 824);
     portalled, so fixed to the viewport. */
  .gauge-card {
    position: fixed;
    z-index: 80;
    box-sizing: border-box;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    font-size: 12.5px;
    color: var(--ink2);
  }
  /* The cache chip's and the toggles' rules went with them to
     `Composer.svelte` (backlog 112). */

  .popover {
    position: fixed;
    /* top and left are set inline from the chip's rectangle (backlog 163). */
    /* 340 × 780 since the 2026-09-13 redesign (was 300 × 560): the Model
       pane became cards, pills and a radio list, which want the width, and
       the height shows the Provider pane's first four sections unscrolled. */
    width: 340px;
    height: min(780px, calc(100vh - var(--titlebar-h) - 80px));
    display: flex;
    flex-direction: column;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    overflow: hidden;
    /* Above the composer's menus (70) and the overlays; under the toasts
       (100). Portalled, so the bar's context no longer caps it. */
    z-index: 80;
  }
  /* The context popover: the same card, its own head, and the panel that
     was the rail's third tab. Shorter than the model popover — a list, not
     four sections. */
  /* The rail draws its own left border and panel background for the column it
     used to be; inside the popover the card is the frame. */
  .popover :global(.rail) {
    border-left: none;
    background: transparent;
    flex: 1;
    min-height: 0;
  }
  /* Item 577 (Filament IV, stage 6's menus grammar, item 570): the chip's
     popover is a card in front — raised, token corners, the deep shadow,
     rising in over 90 ms — and its Model | Tasks strip a quiet control
     with the open tab on the control fill. The strip's markup is
     RightRail's (shared with the column); it is styled from here, inside
     `.popover`, so the column and Classic (TopBarClassic) are untouched. */
  .popover {
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.6);
  }
  .popover :global(.rail .tabs) {
    margin: 10px 12px 2px;
    background: var(--well);
    border: 1px solid var(--line2);
    border-radius: var(--r1);
  }
  .popover :global(.rail .tabs button) {
    border-radius: calc(var(--r1) - 2px);
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
    padding: 5px 4px;
  }
  .popover :global(.rail .tabs button:hover) {
    color: var(--ink);
  }
  .popover :global(.rail .tabs button.active) {
    background: var(--well2);
    color: var(--ink);
    box-shadow: none;
  }
  .popover :global(.rail .tabs .badge) {
    font-family: var(--mono);
    letter-spacing: 0;
  }
  @media (prefers-reduced-motion: no-preference) {
    .popover {
      animation: rail-rise 90ms ease-out;
    }
  }
  @keyframes rail-rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }

  /* Item 534 (Filament IV stage 3): ~~pills~~ — the bar's chips take the
     control grammar (a fill, an edge, the small corner, 28 px), and the
     kind chip reads as the mockup's plain line, "Claude Code ·
     subscription", until hovered or open. The gauge chip's insides are
     stage 2's (item 533). */
  .right > .ns-chip {
    height: 28px;
    box-sizing: border-box;
    padding: 0 10px;
    border-radius: var(--r1);
    background: var(--well);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  .right > .ns-chip.model {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--dim);
    font-size: 12px;
  }
  .right > .ns-chip.model:hover,
  .right > .ns-chip.model.open {
    background: var(--raised);
    border-color: var(--line2);
    color: var(--ink);
  }
  .badge {
    border-radius: 3px;
    font-family: var(--mono);
  }
</style>
