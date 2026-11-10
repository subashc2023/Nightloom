<script lang="ts">
  /**
   * The Nightshift header, Filament IV (item 566, stage 9; `f4-night.png`):
   * the page title with one status line beside it — the night's state
   * (running, armed for a held launch, or not armed) and the last shift's
   * tally — "N blockers wait on you" at the right, then one row of tabs:
   * Start · Morning page · Runs · Blockers · Notes. The tabs drive the same
   * state the Start / Review switch and the Review row did (`tab`,
   * `reviewTab`); only the look changed. Under Classic the parent mounts
   * `NightshiftHeaderClassic.svelte` (the file as it was at fe79d50).
   */
  import { app, cancelLaunch } from "./state.svelte";
  import { sameMorning } from "./nightshift";
  import { tip } from "./tip";
  import { clock12, spanWords, tally } from "./nightshiftFace";
  import { relativeTime } from "./time";
  import NotificationCentre from "./NotificationCentre.svelte";

  const row = $derived(app.nightshift.rows.find((r) => r.id === app.nightshift.selected) ?? null);
  const info = $derived(row?.nightshift ?? null);
  const review = $derived(app.nightshift.tab === "review");
  const latest = $derived(app.nightshift.shifts[0] ?? null);
  const pending = $derived(app.nightshift.pending);

  const openBlockers = $derived(
    app.nightshift.blockers
      ? app.nightshift.blockers.blockers.filter((b) => b.status === "open").length
      : (info?.open_blockers ?? 0),
  );
  const unread = $derived.by(() => {
    if (!row || !info?.newest_morning) return false;
    const read = app.nightshift.read[row.id] ?? [];
    return !read.some((n) => sameMorning(n, info.newest_morning));
  });
  const noteFileCount = $derived(app.nightshift.notes.filter((n) => !n.is_dir).length);

  // "in 2 h 46 min" ticks once a minute while a launch is held; nothing
  // moves otherwise.
  let nowMs = $state(Date.now());
  $effect(() => {
    if (!pending) return;
    const t = setInterval(() => (nowMs = Date.now()), 60_000);
    return () => clearInterval(t);
  });

  /** The night's state, first on the line: live, armed, or not armed. */
  const night = $derived.by(() => {
    if (info?.live) {
      const st = latest?.live ? latest.status : null;
      const where = st?.item_id ? `item ${st.item_id}${st.pass != null ? ` · pass ${st.pass}` : ""}` : "a shift is running";
      return { tone: "live", word: "Running", detail: where, mono: "" };
    }
    if (pending) {
      return { tone: "armed", word: "Armed", detail: `starts ${clock12(pending.fire_at_ms, new Date(nowMs))}`, mono: `in ${spanWords(pending.fire_at_ms - nowMs)}` };
    }
    return { tone: "idle", word: "Not armed", detail: "", mono: "" };
  });

  /** The last finished shift as a tally, coloured by how it ended. */
  const last = $derived.by(() => {
    if (!latest || latest.live) return null;
    const units = latest.status?.units ?? [];
    const counts = tally(units);
    const failed = latest.status?.exit != null && latest.status.exit !== 0;
    const tone = failed || latest.interrupted ? "failed" : units.some((u) => u.outcome && u.outcome !== "done") ? "partial" : "done";
    const stamp = latest.status?.updated ?? latest.status?.started ?? null;
    return {
      tone,
      text: `Last shift: ${counts || (latest.interrupted ? "interrupted" : "no passes")}`,
      when: stamp ? relativeTime(stamp) : "",
      tip: `shift ${latest.id}${latest.status?.exit != null ? ` · exit ${latest.status.exit}` : ""}`,
    };
  });

  function go(tab: "start" | "morning" | "runs" | "blockers" | "notes"): void {
    if (tab === "start") {
      app.nightshift.tab = "start";
      return;
    }
    app.nightshift.tab = "review";
    app.nightshift.reviewTab = tab;
  }
  const on = (tab: string) => (tab === "start" ? !review : review && app.nightshift.reviewTab === tab);
</script>

<header class="top" class:collapsed={app.layout.sidebarCollapsed}>
  <div class="line">
    <h1 class="title" use:tip={row ? `${row.name}${info ? ` · ${info.config.kind} project · ${info.items} item${info.items === 1 ? "" : "s"}` : ""}` : ""}>Nightshift</h1>
    {#if info}
      <div class="status">
        <span class="st {night.tone}"><i class="dot"></i><b>{night.word}</b>{#if night.detail}<span class="d">{night.detail}</span>{/if}{#if night.mono}<span class="m">{night.mono}</span>{/if}</span>
        {#if pending && !info.live}
          <button type="button" class="cancel" use:tip={"Cancel the held launch — the app holds it only while Nightloom stays open"} onclick={() => void cancelLaunch()}>cancel</button>
        {/if}
        {#if last}
          <span class="sep" aria-hidden="true">·</span>
          <span class="st {last.tone}" use:tip={last.tip}><i class="dot"></i><span class="d">{last.text}</span>{#if last.when}<span class="m">{last.when}</span>{/if}</span>
        {:else if !latest}
          <span class="sep" aria-hidden="true">·</span>
          <span class="st idle"><span class="d">no shifts yet</span></span>
        {/if}
      </div>
    {:else if row}
      <div class="status"><span class="st idle"><span class="d">{row.name} · not a Nightshift project</span></span></div>
    {/if}
    <span class="spacer"></span>
    <!-- The bell (nightshift backlog 069): this page draws no top bar. -->
    <NotificationCentre />
    {#if info && openBlockers > 0}
      <button type="button" class="ns-btn wait" onclick={() => go("blockers")}>
        <span class="k">{openBlockers}</span> blocker{openBlockers === 1 ? "" : "s"} wait{openBlockers === 1 ? "s" : ""} on you
      </button>
    {/if}
  </div>
  {#if info}
    <div class="tabs" role="tablist" aria-label="Nightshift pages">
      <button role="tab" aria-selected={on("start")} class:on={on("start")} onclick={() => go("start")}>Start</button>
      <button role="tab" aria-selected={on("morning")} class:on={on("morning")} onclick={() => go("morning")}>
        Morning page{#if unread}<span class="new">new</span>{/if}
      </button>
      <button role="tab" aria-selected={on("runs")} class:on={on("runs")} onclick={() => go("runs")}>
        Runs{#if app.nightshift.shifts.length > 0}<span class="n">{app.nightshift.shifts.length}</span>{/if}
      </button>
      <button role="tab" aria-selected={on("blockers")} class:on={on("blockers")} onclick={() => go("blockers")}>
        Blockers{#if openBlockers > 0}<span class="n hot">{openBlockers}</span>{/if}
      </button>
      <button role="tab" aria-selected={on("notes")} class:on={on("notes")} onclick={() => go("notes")}>
        Notes{#if noteFileCount > 0}<span class="n">{noteFileCount}</span>{/if}
      </button>
    </div>
  {/if}
</header>

<style>
  .top {
    flex: none;
    padding: 26px 48px 0;
    background: var(--paper);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .top.collapsed {
    padding-left: 64px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 22px;
    min-width: 0;
  }
  .title {
    margin: 0;
    font-family: var(--sans);
    font-size: 30px;
    font-weight: 300;
    letter-spacing: -0.01em;
    line-height: 1.1;
    color: var(--ink);
    white-space: nowrap;
  }
  /* The status takes the room between the title and the right-hand
     controls, so its two readings wrap whole rather than squeezing. */
  .status {
    flex: 1 1 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    min-width: 0;
    white-space: nowrap;
    font-size: 14px;
    color: var(--ink2);
  }
  /* In a narrow window or at a large zoom the readings wrap word-group by
     word-group rather than overlap or clip (both happened at 150%). */
  .st {
    flex: 0 1 auto;
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 7px;
    min-width: 0;
  }
  .st > * {
    white-space: nowrap;
  }
  .st b {
    font-weight: 600;
    color: var(--ink);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
    flex: none;
  }
  .st.armed .dot {
    background: var(--accent);
  }
  .st.live .dot {
    background: var(--signal);
    box-shadow: var(--glow-live);
  }
  .st.live b {
    color: var(--signal);
  }
  .st.done .dot {
    background: var(--done);
  }
  .st.partial .dot {
    background: var(--partial);
  }
  .st.failed .dot {
    background: var(--failed);
  }
  .m {
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .sep {
    color: var(--dim);
  }
  .cancel {
    background: none;
    border: none;
    padding: 0 2px;
    font: inherit;
    font-size: 12px;
    color: var(--dim);
    cursor: pointer;
  }
  .cancel:hover {
    color: var(--failed);
    text-decoration: underline;
  }
  .spacer {
    flex: none;
  }
  .wait {
    flex: none;
    white-space: nowrap;
  }
  .wait .k {
    color: var(--accent);
    font-family: var(--mono);
    font-weight: 600;
    margin-right: 2px;
  }
  .tabs {
    display: flex;
    gap: 6px;
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    padding: 8px 14px 9px;
    margin-bottom: -1px;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--ink2);
    font: 500 14px var(--sans);
    cursor: pointer;
  }
  .tabs button:hover {
    color: var(--ink);
  }
  .tabs button.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }
  .n {
    font: 500 11.5px var(--mono);
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .n.hot {
    color: var(--accent);
  }
  .new {
    font: 500 10px var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--signal);
    border: 1px solid color-mix(in srgb, var(--signal) 45%, transparent);
    border-radius: var(--r1);
    padding: 0 4px;
  }
  @media (prefers-reduced-motion: no-preference) {
    .st.live .dot {
      animation: ns-live 1.6s ease-in-out infinite;
    }
  }
  @keyframes ns-live {
    50% {
      opacity: 0.45;
    }
  }
</style>
