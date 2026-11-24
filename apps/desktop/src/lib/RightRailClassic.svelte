<script lang="ts">
  import ProviderRail from "./ProviderRail.svelte";
  import { tabPlace } from "./tabPlace";
  // Item 715: the view keeps its scroll across close and reopen.
  import TaskPanel from "./TaskPanel.svelte";
  import ContextDial from "./ContextDial.svelte";
  import DialMotion from "./DialMotion.svelte";
  import { app } from "./state.svelte";
  import { compactCount, duration, modelName, resetClock, usd, type StackPart } from "./usageFigures";
  import { usd as usdShort } from "./cacheCost";
  import { modelShort, shortTokens, WEEK_HOT } from "./contextDial";
  import { tip } from "./tip";
  import { railFold, toggleRailFold } from "./railFold.svelte";
  import { liveLegend, liveTip } from "./liveContext";
  import { handOffBlock, handOffNow } from "./manualHandoff.svelte";
  import { rightRailLogic, type RightRailLogicProps } from "./rightRail/logic.svelte";

  // Item 856: the behaviour lives once, in `rightRail/logic.svelte.ts`; this file is the look.
  const props: RightRailLogicProps = $props();
  const T = rightRailLogic(() => props);
</script>

{#snippet stack(title: string, why: string, parts: StackPart[])}
  <div class="stack" use:tip={why}>
    <div class="sub">{title}</div>
    <div class="sbar" role="img" aria-label={`${title}: ${parts.map((p) => `${p.name} ${p.pct}%`).join(", ")}`}>
      {#each parts as p, i (p.name)}<i class="c{i % 5}" style:flex-grow={p.share}></i>{/each}
    </div>
    <div class="lg">
      {#each parts as p, i (p.name)}<span><i class="c{i % 5}"></i>{p.name}<b>{p.pct}%</b></span>{/each}
    </div>
  </div>
{/snippet}

{#snippet foldButton(folded: boolean)}
  <!-- Item 599: fold the column to a strip and back; the choice is kept across chats and relaunches. -->
  <button
    type="button"
    class="fold"
    aria-expanded={!folded}
    aria-label={folded ? "Show the right column" : "Hide the right column"}
    use:tip={folded ? "Show the context dial and readings" : "Hide the context dial and readings; the chat widens"}
    onclick={toggleRailFold}
  >
    <svg viewBox="0 0 12 12" aria-hidden="true"><path d={folded ? "M7.5 2.5 4 6l3.5 3.5" : "M4.5 2.5 8 6 4.5 9.5"} /></svg>
  </button>
{/snippet}

{#if T.column && railFold.folded}
  <aside class="col folded" aria-label="Context, plan use, this turn and tasks (folded)">
    {@render foldButton(true)}
    {#if T.used != null && T.limit}
      <span class="fpct" use:tip={`Context ${T.used.toLocaleString()} of ${T.limit.toLocaleString()} tokens`}>{T.pct(T.share)}</span>
    {/if}
  </aside>
{:else if T.column}
  <!-- Item 563: data-rail-col — the first send from the new-chat page slides this column in (sendMotion.ts departDial). -->
  <aside class="col" data-rail-col aria-label="Context, plan use, this turn and tasks" use:tabPlace={"rail:col:" + (T.aside ? "aside" : "chat")}>
    <section>
      <h4>Context <span class="hr"><span>{modelShort(T.af?.model ?? T.aside?.model ?? app.connection?.model)}</span>{@render foldButton(false)}</span></h4>
      <div class="dial-at" data-dial-dock>
        <!-- Item 585: a few of 581's new-chat layers behind the dial, quieter (item 587: DialMotion's column form —
             all of the new-chat dial's layers, the gears, radar and 5-hour hand between the figure and the inner ring; his keys surge it too); the ring holds a gentle surge while a turn streams
             and each new tool call nudges it. Paused when hidden, still under reduced motion. -->
        <div class="dm-at">
          <DialMotion size={104} pad={14} quiet column layers={T.COLUMN_LAYERS} plan={T.motionPlan} streaming={T.live} typed={T.marks.length + T.keys} flowKey={T.stepKey} gear={T.dv ? T.drive.gear : null} gearKey={T.drive.n} />
        <ContextDial
          size={104}
          share={T.dv ? T.dv.solid : T.share}
          mark={T.markShare}
          inner={T.cache ? T.cacheShare : null}
          estimate={T.dv ? null : T.estShare}
          drive={T.dv}
          minor={T.ticks.minor}
          major={T.ticks.major}
          value={T.dialValue}
          unit={T.limit ? `of ${shortTokens(T.limit)}` : T.used != null ? "window unknown" : ""}
          label={T.used != null
            ? `Context ${(T.liveCtx && T.liveCtx.estimate > 0) || T.est ? "about " : ""}${T.used.toLocaleString()} tokens${T.limit ? ` of ${T.limit.toLocaleString()}` : ""}${T.liveCtx && T.liveCtx.estimate > 0 ? ", estimated since the last step" : ""}${T.est ? ", estimated" : ""}`
            : "Context: no reading yet"}
        />
        </div>
      </div>
      <div class="legend">
        {#if T.limit && T.used != null}
          <div class="dk" use:tip={"What the next request carries, over the model's window"}>
            <i class="u"></i><span>Used</span><b>{T.pct(T.share)}</b>
          </div>
        {/if}
        {#if T.est}
          <!-- Item 639: an aside that kept no tokens — its figure is estimated, and says from what. -->
          <div
            class="dk est"
            use:tip={T.est === "chat"
              ? "Estimated: this aside kept no token counts (answered before Nov 11), so the figure is the chat's last context reading plus the thread's text (characters ÷ 4)"
              : "Estimated, a floor: no token counts kept and no reading of the chat's context yet, so only the thread's text (characters ÷ 4)"}
          >
            <i class="e"></i><span>Estimated</span><b>{T.est === "chat" ? "chat + thread" : "thread only"}</b>
          </div>
        {/if}
        {#if T.liveCtx}
          <!-- Item 590: the live reading's line while a reply runs — exact at a step, else the estimate on top. -->
          <div class="dk live" class:est={T.liveCtx.estimate > 0} use:tip={liveTip(T.liveCtx)}>
            <i class="e"></i><span>Live</span><b>{liveLegend(T.liveCtx, shortTokens)}</b>
          </div>
        {/if}
        {#if T.handoffLine}
          <div
            class="dk"
            class:past={T.handoffLine === "past hand-off"}
            use:tip={`The hand-off line: ${T.markTokens?.toLocaleString()} tokens (${T.pct(T.markShare ?? 0)} of the window). Set in Settings → Subscription, or for this chat in its hand-off card.`}
          >
            <i class="n"></i><span>Hand-off line</span><b>{T.handoffLine}</b>
          </div>
        {/if}
        {#if !T.aside && app.activeSessionId}
          <!-- Item 915: the hand-off whenever he wants, at any fill. Not for asides: an aside has no hand-off. -->
          {@const block = handOffBlock()}
          <button
            class="hand"
            type="button"
            disabled={!!block}
            use:tip={block ?? "Send the wrap-up now, at any fill.\nThe next chat starts small."}
            onclick={() => void handOffNow()}>Hand off now</button
          >
        {/if}
        {#if T.cache}
          <div
            class="dk"
            use:tip={T.cacheLeft
              ? `Warm for ${T.cacheLeft} more (${T.cache.ttl === "1h" ? "1-hour" : "5-minute"} cache)`
              : T.railFace === "unknown"
                ? "Unknown until the next send (a stopped turn)"
                : T.aside && T.railOwnModel
                  ? "Own model · no cache from the chat"
                  : "Cache cold · the next send writes it again"}
          >
            <i class="s"></i><span>Cache {T.cacheLeft ? "warm" : T.railFace === "unknown" ? "unknown" : "cold"}</span><b class:sig={!!T.cacheLeft}>{T.cacheLeft ? `${T.cacheLeft} left` : "—"}</b>
          </div>
          {#if T.nextEst}
            <!-- Item 699's price fix: what the next send costs, warm or cold. -->
            <div class="dk" use:tip={T.nextEst.title}>
              <i class="s"></i><span>Next send</span><b>≈ {usdShort(T.nextEst.usd)}</b>
            </div>
            {#if T.cache.warm && T.nextEst.cold != null}
              <!-- Item 776: what the next send costs if he lets it go cold, on the face. -->
              <div class="dk" use:tip={"The next send's API price once the cache has gone cold"}>
                <i class="s"></i><span>Once cold</span><b>≈ {usdShort(T.nextEst.cold)}</b>
              </div>
            {/if}
          {/if}
        {/if}
      </div>
    </section>

    {#if T.plan}
      <section>
        <h4>
          Plan use
          {#if T.plan.stale}<span use:tip={"The newest reading is past twenty minutes old and may be behind"}>stale</span>{/if}
        </h4>
        <div class="kv" use:tip={"Account-wide: every surface, not just this chat"}>
          <span>5 hours</span><b>{T.plan.five_hour}%</b>
        </div>
        <div class="bar am"><i style:width="{Math.min(100, T.plan.five_hour ?? 0)}%"></i></div>
        <div class="scale"></div>
        {#if resetClock(T.plan.five_hour_resets_at)}<div class="rs">resets {resetClock(T.plan.five_hour_resets_at)}</div>{/if}
        {#if T.plan.seven_day != null}
          <div class="kv wk">
            <span>This week</span><b>{T.plan.seven_day}%</b>
          </div>
          <div class="bar" class:ok={T.plan.seven_day / 100 <= WEEK_HOT} class:ht={T.plan.seven_day / 100 > WEEK_HOT}>
            <i style:width="{Math.min(100, T.plan.seven_day)}%"></i>
          </div>
          <div class="scale"></div>
          {#if resetClock(T.plan.seven_day_resets_at)}<div class="rs">resets {resetClock(T.plan.seven_day_resets_at)}</div>{/if}
        {/if}
        {#each T.scoped?.limits ?? [] as l (l.name)}
          <div
            class="kv wk"
            data-scoped={l.name}
            use:tip={`The week's ${l.name}-only limit, account-wide (Claude Code's cache, as /usage shows it)${T.scoped?.stale ? "; the reading is over twenty minutes old" : ""}`}
          >
            <span>{l.name} this week</span><b>{l.percent}%</b>
          </div>
          <div class="bar" class:ok={l.percent / 100 <= WEEK_HOT} class:ht={l.percent / 100 > WEEK_HOT}>
            <i style:width="{Math.min(100, l.percent)}%"></i>
          </div>
          <div class="scale"></div>
          {#if resetClock(l.resets_at)}<div class="rs">resets {resetClock(l.resets_at)}</div>{/if}
        {/each}
      </section>
    {/if}

    {#if T.chat}
      <!-- Item 584 (his "squashed … not easy to look at" on 569): the cost large, three small tiles, one stacked bar
           per split; the per-model tokens and both clocks behind Details, which keeps its fold. -->
      <section class="chat-use" aria-label="This chat's usage">
        <h4>This chat</h4>
        {#if T.chat.cost_usd != null}
          <div
            class="cost"
            use:tip={T.chat.rewound_usd
              ? `Claude Code's estimate at API prices, subagents in · /usage's figure plus ${usd(T.chat.rewound_usd)} of rewound replies`
              : "Claude Code's estimate at API prices, subagents in · the figure /usage shows"}
          >
            <b>{usd(T.chat.cost_usd)}{T.chat.unknown_cost ? "+" : ""}</b><span>at API prices</span>
          </div>
        {/if}
        <div class="tiles">
          {#if T.chat.cache_hit != null}
            <div class="tile" use:tip={"Input read back from the prompt cache, of all input"}>
              <span>Cache hit</span><b>{Math.round(T.chat.cache_hit * 100)}%</b>
            </div>
          {/if}
          {#if T.chat.lines_added != null || T.chat.lines_removed != null}
            <div class="tile" use:tip={`Lines Claude's edits added and removed in this chat: +${(T.chat.lines_added ?? 0).toLocaleString()} −${(T.chat.lines_removed ?? 0).toLocaleString()}`}>
              <span>Lines</span><b><ins>+{compactCount(T.chat.lines_added ?? 0)}</ins> <del>−{compactCount(T.chat.lines_removed ?? 0)}</del></b>
            </div>
          {/if}
          {#if T.chat.run_ms != null}
            <div class="tile" use:tip={"Claude Code's own clock over this chat's runs (not /usage's Active, which Claude Code never writes down)"}>
              <span>Run time</span><b>{duration(T.chat.run_ms)}</b>
            </div>
          {/if}
        </div>
        {#if T.modelParts.length > 1}
          {@render stack("Models", "Each model's share of this chat's cost", T.modelParts)}
        {/if}
        {#if T.usingParts.length > 1}
          {@render stack("Using it", "Who spent this chat's cost: the main chat and each subagent type", T.usingParts)}
        {/if}
        <button class="more" type="button" aria-expanded={T.details} onclick={T.toggleDetails}>
          <svg viewBox="0 0 8 8" aria-hidden="true"><path d="M2.5 1.5 5.5 4 2.5 6.5" /></svg>Details
        </button>
        {#if T.details}
          <div class="det">
            {#if T.chat.api_ms != null}
              <div class="kv" use:tip={"Every request's time, subagents' too, so it can pass the clock"}><span>API time</span><b>{duration(T.chat.api_ms)}</b></div>
            {/if}
            {#if T.chat.run_ms != null}
              <div class="kv" use:tip={"Claude Code's own clock over this chat's runs"}><span>Run time</span><b>{duration(T.chat.run_ms)}</b></div>
            {/if}
            {#if T.chat.models.length}
              <table class="tok" aria-label="Tokens by model">
                <thead><tr><th scope="col">Tokens</th><th scope="col" use:tip={"Input not read from the cache"}>In</th><th scope="col">Out</th><th scope="col" use:tip={"Read back from the prompt cache"}>Read</th><th scope="col" use:tip={"Written to the prompt cache"}>Write</th></tr></thead>
                <tbody>
                  {#each T.chat.models as m (m.model)}
                    <tr use:tip={`${modelName(m.model)}: in ${m.input.toLocaleString()}, out ${m.output.toLocaleString()}, cache read ${m.cache_read.toLocaleString()}, cache write ${m.cache_write.toLocaleString()} · ${usd(m.cost_usd)}`}>
                      <th scope="row">{modelName(m.model)}</th>
                      <td>{compactCount(m.input)}</td>
                      <td>{compactCount(m.output)}</td>
                      <td>{compactCount(m.cache_read)}</td>
                      <td>{compactCount(m.cache_write)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
        {/if}
      </section>
    {/if}

    {#if T.af && T.af.exchanges > 0}
      <!-- Item 605: the aside's own spend, in This chat's form. Item 639: always drawn for an asked aside — an
           old one says its cost was not kept rather than dropping the section. -->
      <section class="chat-use" aria-label="This aside's usage">
        <h4>This aside</h4>
        {#if T.af.cost}
          <!-- Item 675 (his "asides should show the cost as the added cost compared to the regular chat"): what the
               aside added over the chat, each answer's own spend — never the CLI's running total for the chat. -->
          <div
            class="cost"
            data-aside-added
            use:tip={T.af.cost.complete
              ? "What this aside added over the chat, at API prices (the CLI's estimate)"
              : "At least this much over the chat · some answers kept no cost (none came, or before Nov 12)"}
          >
            <b>+{usd(T.af.cost.usd)}{T.af.cost.complete ? "" : "+"}</b><span>over the chat, at API prices</span>
          </div>
        {:else}
          <div
            class="kv"
            data-cost-unkept
            use:tip={"Answers before Nov 12 kept no cost of their own · the next one here is counted"}
          >
            <span>Cost</span><b>not kept</b>
          </div>
        {/if}
        <div class="tiles">
          <div class="tile" use:tip={"Questions asked in this aside"}>
            <span>Exchanges</span><b>{T.af.exchanges}</b>
          </div>
          {#if T.af.cacheHit != null}
            <div class="tile" use:tip={"The newest answer's input read back from the chat's prompt cache, of all its input"}>
              <span>Cache hit</span><b>{Math.round(T.af.cacheHit * 100)}%</b>
            </div>
          {/if}
        </div>
      </section>
    {/if}

    {#if T.hasTurn}
      <section>
        <h4>This turn {#if T.turnClock}<span class:sig={T.live}>{T.turnClock}</span>{/if}</h4>
        {#if T.inTokens != null}
          <div class="io" use:tip={"The newest request's input not read back from the cache: new to the prompt this round"}>
            <span>In</span>
            <div class="bar am"><i style:width="{(T.inTokens / T.ioScale) * 100}%"></i></div>
            <b>{shortTokens(T.inTokens)}</b>
          </div>
        {/if}
        {#if T.outTokens != null}
          <div class="io" use:tip={T.outEst ? "The newest answer's output, estimated from its text (characters ÷ 4): this answer kept no token counts" : "The newest request's output"}>
            <span>Out</span>
            <div class="bar sg"><i style:width="{(T.outTokens / T.ioScale) * 100}%"></i></div>
            <b>{T.outEst ? "~" : ""}{shortTokens(T.outTokens)}</b>
          </div>
        {/if}
        {#if T.toolsLine}
          <div class="kv tools"><span>Tools</span><b>{T.toolsLine}</b></div>
          {#if T.marks.length > 1}<div class="tks" aria-hidden="true">
            {#each T.marks as m, i (i)}<i class:r={!m.done} class:e={m.error} class:s={!!m.soft}></i>{/each}
          </div>{/if}
        {/if}
      </section>
    {/if}

    {#if !T.aside}
      <section class="tasks">
        <TaskPanel column />
      </section>
    {/if}
  </aside>
{:else}
  <aside class="rail" use:tabPlace={`rail:pop:classic:${T.tab}`}>
    <div class="tabs" role="tablist">
      {#each T.aside ? T.TABS.filter((t) => t.id !== "tasks") : T.TABS as t (t.id)}
        <button
          role="tab"
          aria-selected={T.tab === t.id}
          class:active={T.tab === t.id}
          onclick={() => (T.tab = t.id)}
        >
          {t.label}
          {#if t.id === "tasks" && T.open > 0}<span class="badge">{T.open}</span>{/if}
        </button>
      {/each}
    </div>

    {#if T.tab === "connection" || T.aside}
      <ProviderRail aside={T.aside} asideChat={T.asideChat} />
    {:else}
      <TaskPanel />
    {/if}
  </aside>
{/if}

<style>
  .rail {
    background: var(--panel);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  /* A segmented control rather than underlined tabs: three short words in a
     240px column read better as one pill than as three headings. */
  .tabs {
    display: flex;
    flex-shrink: 0;
    gap: 2px;
    margin: 0.6rem 0.7rem 0;
    padding: 2px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .tabs button {
    flex: 1;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 0.28rem 0.3rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.28rem;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.active {
    color: var(--text);
    background: var(--panel);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .badge {
    background: var(--accent);
    color: var(--bg);
    border-radius: 999px;
    font-size: 0.6rem;
    line-height: 1;
    padding: 0.13rem 0.28rem;
    font-variant-numeric: tabular-nums;
  }
  /* Item 856: the column beside an aside tab (item 605), Classic too —
     RightRail.svelte's column rules, kept as they are. */
  /* ---- the right column (item 533; 521 mockup `tele`, f4x-chat.png) */
  .col {
    background: var(--sheet);
    border-left: 1px solid var(--line);
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  /* ---- item 599: the fold button, and the folded strip */
  .col h4 .hr {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .fold {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin: -4px -4px -4px 0;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--dim);
    cursor: pointer;
  }
  .fold:hover {
    color: var(--ink);
    border-color: var(--line);
  }
  .fold:focus-visible {
    outline: 2px solid var(--signal);
    outline-offset: 1px;
  }
  .fold svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .col.folded {
    padding: 12px 0;
    align-items: center;
    gap: 10px;
    overflow: hidden;
  }
  .col.folded .fold {
    margin: 0;
    width: 24px;
    height: 24px;
  }
  .fpct {
    font: 10px var(--mono);
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .col section {
    padding: 0 0 14px;
    margin-bottom: 14px;
    border-bottom: 1px solid var(--line);
  }
  .col section:last-child {
    border: 0;
    margin-bottom: 0;
    padding-bottom: 0;
  }
  /* Tasks sit at the foot of the column, as drawn. */
  .col section.tasks {
    margin-top: auto;
  }
  /* Titles: mono capitals in the lit level (IV+), the sans in calm. */
  .col h4 {
    margin: 0 0 8px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
  }
  /* Item 629: Calm used to set these headings in 12 px sans; Instrument
     light changes only the light now, so they are mono capitals in both. */
  .col h4 span {
    font: 11px var(--mono);
    letter-spacing: 0;
    text-transform: none;
    color: var(--dim);
  }
  .col h4 span.sig {
    color: var(--signal);
  }
  .dial-at {
    display: flex;
    justify-content: center;
  }
  .dm-at {
    position: relative;
  }
  .legend {
    margin-top: 8px;
  }
  .dk {
    font-size: 11.5px;
    color: var(--dim);
    display: grid;
    grid-template-columns: 8px 1fr auto;
    gap: 6px;
    align-items: center;
    padding: 2px 0;
  }
  .hand {
    margin: 4px 0 2px;
    font: inherit;
    font-size: 11.5px;
    color: var(--ink);
    background: transparent;
    border: 1px solid var(--line, currentColor);
    border-radius: 6px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .hand:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .dk b {
    font: 11px var(--mono);
    font-weight: 400;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .dk b.sig {
    color: var(--signal);
  }
  .dk.past b {
    color: var(--hot);
  }
  .dk i {
    width: 8px;
    height: 2px;
    background: var(--accent);
  }
  .dk i.s {
    background: var(--signal);
  }
  .dk i.n {
    background: var(--ink);
    width: 2px;
    height: 8px;
    justify-self: center;
  }
  /* Item 590: the live line's key — the estimate's lighter tone (the dial's tail breathes; the legend holds still). */
  .dk i.e {
    background: color-mix(in srgb, var(--accent) 45%, var(--well));
  }
  .kv {
    display: flex;
    justify-content: space-between;
    font-size: 12.5px;
    color: var(--ink);
    padding: 3px 0;
  }
  .kv span {
    color: var(--dim);
  }
  .kv b {
    font: 11.5px var(--mono);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .kv.wk {
    margin-top: 8px;
  }
  .kv.tools {
    margin-top: 3px;
  }
  /* Item 569: a limit's reset under its bar, small and dim. */
  .rs {
    font: 10px var(--mono);
    color: var(--dim);
    text-align: right;
    margin-top: 1px;
  }
  /* ---- Item 584: This chat at a glance. */
  .cost {
    display: flex;
    align-items: baseline;
    gap: 7px;
    margin: 0 0 10px;
  }
  .cost b {
    font: 400 24px/1 var(--mono);
    letter-spacing: -0.02em;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .cost span {
    font-size: 11px;
    color: var(--dim);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, auto);
    justify-content: space-between;
    gap: 8px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .tile span {
    font-size: 10.5px;
    color: var(--dim);
    white-space: nowrap;
  }
  .tile b {
    font: 400 13px var(--mono);
    color: var(--ink);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .tile b ins {
    text-decoration: none;
    color: var(--done);
  }
  .tile b del {
    text-decoration: none;
    color: var(--hot);
  }
  .stack {
    margin-top: 12px;
  }
  .stack .sub {
    margin: 0 0 5px;
  }
  .sbar {
    display: flex;
    gap: 2px;
    height: 6px;
  }
  .sbar i {
    flex: 0 0 auto;
    flex-basis: 0;
    min-width: 3px;
    border-radius: 2px;
  }
  .lg {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 12px;
    margin-top: 6px;
    font-size: 11.5px;
    color: var(--ink2);
  }
  .lg span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .lg i {
    width: 6px;
    height: 6px;
    border-radius: 1px;
  }
  .lg b {
    font: 400 11px var(--mono);
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .c0 {
    background: var(--accent);
  }
  .c1 {
    background: var(--signal);
  }
  .c2 {
    background: var(--done);
  }
  .c3 {
    background: var(--ink2);
  }
  .c4 {
    background: var(--dim);
  }
  .more {
    margin: 12px 0 0;
    padding: 2px 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: 0;
    font: 500 10px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    cursor: pointer;
  }
  .more:hover,
  .more:focus-visible {
    color: var(--ink);
  }
  .more svg {
    width: 8px;
    height: 8px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
  }
  .more[aria-expanded="true"] svg {
    transform: rotate(90deg);
  }
  .det {
    margin-top: 6px;
  }
  .sub {
    margin: 9px 0 1px;
    font: 500 10px var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .tok {
    width: 100%;
    margin-top: 6px;
    border-collapse: collapse;
    font: 10px var(--mono);
    font-variant-numeric: tabular-nums;
    table-layout: fixed;
  }
  .tok th,
  .tok td {
    padding: 3px 0;
    text-align: right;
    font-weight: 400;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tok thead th {
    color: var(--dim);
    font-size: 10px;
    border-bottom: 1px solid var(--line);
  }
  .tok thead th:first-child {
    width: 27%;
    text-align: left;
  }
  .tok tbody th {
    text-align: left;
    color: var(--ink2);
    font: 10.5px var(--sans);
  }
  .tok td {
    color: var(--ink);
    padding-left: 2px;
  }

  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--well);
    position: relative;
    margin: 2px 0 0;
    overflow: hidden;
  }
  .bar i {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    max-width: 100%;
    border-radius: 2px;
    background: var(--accent);
  }
  .bar.sg i {
    background: var(--signal);
  }
  .bar.ok i {
    background: var(--done);
  }
  .bar.ht i {
    background: var(--hot);
  }
  /* A bar's scale: a tick at each quarter and one at the end. */
  .scale {
    height: 3px;
    margin-top: 2px;
    background:
      linear-gradient(90deg, var(--line2) 0 1px, transparent 1px) 0 0 / 25% 100%,
      linear-gradient(var(--line2), var(--line2)) 100% 0 / 1px 100% no-repeat;
  }
  .io {
    display: grid;
    grid-template-columns: 28px 1fr 38px;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--dim);
    padding: 3px 0;
  }
  .io b {
    font: 11.5px var(--mono);
    font-weight: 400;
    color: var(--ink);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .io .bar {
    margin: 0;
  }
  /* Item 584: one segment per call, in the bars' grammar (a lone 6 × 12 block read as a stray mark). */
  .tks {
    display: flex;
    gap: 2px;
    height: 4px;
    margin-top: 5px;
  }
  .tks i {
    flex: 1 1 0;
    max-width: 18px;
    background: var(--done);
    border-radius: 1px;
  }
  .tks i.r {
    background: var(--signal);
    box-shadow: var(--glow-signal);
  }
  .tks i.e {
    background: var(--failed, var(--hot));
  }
  /* Item 700: a call the harness did not run — amber, not a failure. */
  .tks i.s {
    background: var(--partial);
  }
  @media (prefers-reduced-motion: no-preference) {
    .bar i {
      transition: width 300ms ease;
    }
  }
</style>
