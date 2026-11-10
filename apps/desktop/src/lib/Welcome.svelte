<script lang="ts">
  import { tip as tipAction } from "./tip";
  import {
    app,
    contextUsed,
    importFromClaude,
    MODE_LINES,
    KIND_LINES,
    newChatInThread,
    newSession,
    openProjectFolder,
    revealFolder,
    runMenuCommand,
    showNewProject,
    showNightshift,
  } from "./state.svelte";
  import { providerLabel } from "./catalog";
  import type { ChatKind, ChatMode } from "./types";
  import Composer from "./Composer.svelte";
  import ContextDial from "./ContextDial.svelte";
  import Icon from "./Icon.svelte";
  import Kbd from "./Kbd.svelte";
  import WelcomeClassic from "./WelcomeClassic.svelte";
  import { classic } from "./layout.svelte";
  import { isMac } from "./platform";
  import { mark as handoffMark } from "./handoff.svelte";
  import { shortTokens, tickCounts } from "./contextDial";
  import { threadList } from "./threadPanel.svelte";
  import { departs } from "./sendMotion";
  import {
    aroundAt,
    clockLine,
    dialSize,
    greeting,
    quarterLabels,
    readings,
    readoutsFit,
    shortClock,
    threadWhen,
    type Reading,
  } from "./newChatPage";

  /**
   * The new-chat page. Filament IV (item 563, stage 4; 521 report §2 "The
   * new-chat page", mockups `f4-new.png` calm and `f4x-new.png` lit): the
   * context dial, 330 px, in the centre with the date and time, the
   * project's name, a greeting and "0 of 1M in context" inside it; the
   * ready readings — a row of five in calm, six read-outs around the dial
   * with leader lines in lit (the default, blocker 1689) when the pane is
   * wide enough; the message box; the four kinds of chat; the threads to
   * pick up; the key strip. On the first send the dial travels to the
   * right column (`departs` in `sendMotion.ts`).
   *
   * Under the Classic layout (item 542) this is `WelcomeClassic.svelte`,
   * fe79d50's page verbatim: the notes orbiting the composer (2026-09-13).
   *
   * Item 422's column stays: 700 px, "slightly" narrower than the chat's
   * box, at his ask (the mockup drew 760).
   */

  // Stage geometry, read off the element.
  let w = $state(0);
  let h = $state(0);
  const colMax = $derived(Math.max(320, Math.min(700, w - 40)));

  // ---- the dial
  // The column under the dial, measured: the dial takes what is left.
  let colH = $state(0);
  const PAD = 26;
  /** Page padding (10 + 44), the dial's margin (4) and its box's pad (2 × PAD). */
  const size = $derived(dialSize(h, colH + 58 + PAD * 2));
  const box = $derived(size + PAD * 2);
  const mid = $derived(box / 2);
  const limit = $derived(app.connection?.contextLimit ?? null);
  const used = $derived(contextUsed() ?? 0);
  const share = $derived(limit ? Math.min(used / limit, 1) : 0);
  const markShare = $derived(limit ? handoffMark(null, limit) : null);
  const ticks = $derived(tickCounts(limit));
  const quarters = $derived(quarterLabels(limit));
  const handoffAt = $derived.by(() => {
    if (markShare == null || !limit || size === 0) return null;
    const p = aroundAt(markShare, size / 2 + 16, mid);
    return { ...p, left: markShare > 0.5, text: `hand-off ${shortTokens(markShare * limit)}` };
  });
  // The centre's type follows the dial's size (the mockup's 33 px at 330).
  const titlePx = $derived(Math.max(18, Math.round((33 * size) / 330)));

  // ---- the clock: wakes once a minute, on the minute; nothing else ticks.
  let now = $state(new Date());
  $effect(() => {
    const wait = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50;
    const id = setTimeout(() => (now = new Date()), wait);
    return () => clearTimeout(id);
  });

  // ---- the readings
  const openRow = $derived(
    app.project ? (app.nightshift.rows.find((r) => r.id === app.project?.id) ?? null) : null,
  );
  const plan = $derived.by(() => {
    if (app.connection?.engine !== "claude-code") return null;
    const u = app.planUsage;
    if (!u || u.source === "none" || u.five_hour == null) return null;
    return { five: u.five_hour, week: u.seven_day, resets: shortClock(u.five_hour_resets_at) };
  });
  const list = $derived(
    readings({
      engine: app.connection?.engine ?? app.draft.engine ?? null,
      provider: providerLabel(app.connection?.provider ?? app.draft.provider),
      connected: !!app.connection,
      connecting: app.connecting,
      subscription: app.connection?.agent?.subscription ?? null,
      cliVersion: app.connection?.agent?.version ?? null,
      model: app.connection?.model ?? null,
      limit,
      project: app.project ? { root: app.project.root ?? null, exists: app.project.exists } : null,
      notes: app.project ? app.notes.length : 0,
      vault: app.vault.length,
      chats: app.sessions.length,
      plan,
      nightshift: app.project
        ? {
            enabled: !!openRow?.nightshift,
            live: !!openRow?.nightshift?.live,
            armedAt:
              app.nightshift.pending && app.nightshift.selected === app.project.id
                ? shortClock(new Date(app.nightshift.pending.fire_at_ms).toISOString())
                : null,
            items: openRow?.nightshift?.items ?? 0,
            blockers: openRow?.nightshift?.open_blockers ?? 0,
          }
        : null,
    }),
  );
  /** The calm row: five, the model left to the composer's own chip. */
  const row = $derived(list.filter((r) => r.key !== "model"));
  const byKey = (k: Reading["key"]) => list.find((r) => r.key === k) ?? null;
  /** The lit read-outs: the mockup's six slots, left then right, top down. */
  const SLOTS: { key: Reading["key"]; side: "l" | "r"; deg: number }[] = [
    { key: "engine", side: "l", deg: -40 },
    { key: "folder", side: "l", deg: -10 },
    { key: "memory", side: "l", deg: 42 },
    { key: "model", side: "r", deg: -40 },
    { key: "plan", side: "r", deg: -10 },
    { key: "nightshift", side: "r", deg: 42 },
  ];
  const wide = $derived(size > 0 && readoutsFit(w, size));
  const readouts = $derived.by(() => {
    const R = size / 2 + 20;
    const reach = size / 2 + 79;
    return SLOTS.flatMap((s) => {
      const r = byKey(s.key);
      if (!r) return [];
      const t = (s.deg * Math.PI) / 180;
      const dx = R * Math.cos(t);
      const y = mid + R * Math.sin(t);
      const x1 = s.side === "r" ? mid + dx : mid - dx;
      const x2 = s.side === "r" ? mid + reach : mid - reach;
      return [{ ...s, r, y, x1, x2, at: reach + 10 }];
    });
  });

  const ready = $derived(
    !!app.connection && !(app.project?.root && !app.project.exists),
  );
  const hello = $derived(
    ready
      ? `${greeting(now.getHours())} Everything is ready.`
      : app.connecting
        ? `${greeting(now.getHours())} Connecting…`
        : app.project?.root && !app.project.exists
          ? "The project's folder is missing."
          : "Not connected yet.",
  );

  function act(r: Reading) {
    switch (r.key) {
      case "engine":
      case "model":
        runMenuCommand("model");
        break;
      case "folder":
        if (app.project) void revealFolder(app.project.root ?? app.project.notes_dir);
        else void openProjectFolder();
        break;
      case "memory":
        app.leftTab = "notes";
        break;
      case "nightshift":
        showNightshift();
        break;
      case "plan":
        runMenuCommand("settings");
        break;
    }
  }
  const actTip: Record<Reading["key"], string> = {
    engine: "Model and connection (⌘M)",
    model: "Model and connection (⌘M)",
    folder: "Show this folder",
    memory: "Open the notes",
    nightshift: "Open Nightshift",
    plan: "Settings",
  };

  // ---- the four kinds
  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";
  const alt = isMac ? "⌥⌘" : "Ctrl+Alt+";
  const engine = $derived(app.connection?.engine ?? app.draft.engine);
  type KindCard = { id: string; name: string; line: string; tip: string; key: string; kind?: ChatKind; mode?: ChatMode };
  const kinds = $derived<KindCard[]>([
    {
      id: "build",
      name: engine === "claude-code" ? "Claude Code" : "Build",
      line: "The project folder · all tools · plans",
      tip: KIND_LINES.build,
      key: `${mod}N`,
      kind: "build",
    },
    { id: "chat", name: "Chat", line: "Reads only · the web · no folder", tip: KIND_LINES.chat, key: `${alt}N`, kind: "chat" },
    {
      id: "incognito",
      name: "Incognito",
      line: "Kept and marked; knows nothing about you",
      tip: MODE_LINES.incognito,
      key: `${mod}${shift}N`,
      mode: "incognito",
    },
    { id: "ephemeral", name: "Ephemeral", line: "Nothing is kept; gone when you close it", tip: MODE_LINES.ephemeral, key: "", mode: "ephemeral" },
  ]);
  const chosen = $derived(app.pendingMode !== "normal" ? app.pendingMode : app.pendingKind);
  function pick(k: KindCard) {
    if (chosen === k.id) return;
    if (k.mode) void newSession(k.mode);
    else void newSession(undefined, k.kind);
  }

  // ---- the threads to pick up: the project's, most recently touched first.
  const THREADS_MAX = 3;
  const threads = $derived(
    app.project && threadList.project === app.project.id ? threadList.list.slice(0, THREADS_MAX) : [],
  );
</script>

{#if classic()}
  <WelcomeClassic />
{:else}
<!-- Item 362: the empty chat takes a dropped file for its box, as the
     transcript does. -->
<div class="welcome" data-drop-chat bind:clientWidth={w} bind:clientHeight={h} class:wide>
  <div class="page">
    {#if size > 0}
      <div class="core" style:width="{box}px" style:height="{box}px">
        {#if wide}
          <!-- Lit (IV+): six read-outs on leader lines. Calm hides them for the row below. -->
          <svg class="leaders" width={box} height={box} aria-hidden="true">
            {#each readouts as o (o.key)}
              <line x1={o.x1} y1={o.y} x2={o.x2} y2={o.y} />
              <circle class="foot" cx={o.x1} cy={o.y} r="2" />
              <circle class="tip" cx={o.x2} cy={o.y} r="2" />
            {/each}
          </svg>
          {#each readouts as o (o.key)}
            <button
              class="ro {o.side}"
              class:warn={o.r.warn}
              style:top="{o.y - 8}px"
              style:left={o.side === "r" ? `${mid + o.at}px` : undefined}
              style:right={o.side === "l" ? `${mid + o.at}px` : undefined}
              use:tipAction={actTip[o.key]}
              onclick={() => act(o.r)}
            >
              <span class="ro-k">{o.r.label}</span>
              <span class="ro-v">{o.r.value}</span>
              <small>{o.r.sub}</small>
            </button>
          {/each}
          <svg class="irings" width={box} height={box} aria-hidden="true" fill="none">
            <circle cx={mid} cy={mid} r={size / 2 - 16} class="ir1" />
            <circle cx={mid} cy={mid} r={size / 2 - 22} class="ir2" stroke-dasharray="{size * 0.21} {size * 0.08} {size * 0.024} {size * 0.08} {size * 0.42} {size * 0.18} {size * 0.024} {size * 0.18}" />
            <circle cx={mid} cy={mid} r={size / 2 - 30} class="ir3" stroke-dasharray="2 6" />
          </svg>
        {/if}
        <div class="dial-wrap" use:departs>
          <ContextDial
            {size}
            {share}
            mark={markShare}
            inner={null}
            stroke={3}
            pad={PAD}
            minor={ticks.minor}
            major={ticks.major}
            label={limit
              ? `Context ${used.toLocaleString()} of ${limit.toLocaleString()} tokens`
              : "Context: window unknown until connected"}
          />
        </div>
        {#if quarters.length === 4}
          <span class="tq" style:left="{mid}px" style:top="1px" style:transform="translateX(-50%)">{quarters[0]}</span>
          <span class="tq" style:left="{box - 12}px" style:top="{mid - 6}px">{quarters[1]}</span>
          <span class="tq" style:left="{mid}px" style:bottom="0" style:transform="translateX(-50%)">{quarters[2]}</span>
          <span class="tq" style:right="{box - 12}px" style:top="{mid - 6}px">{quarters[3]}</span>
        {/if}
        {#if handoffAt}
          <span
            class="tq h"
            style:top="{handoffAt.y - 6}px"
            style:left={handoffAt.left ? undefined : `${handoffAt.x + 6}px`}
            style:right={handoffAt.left ? `${box - handoffAt.x + 6}px` : undefined}>{handoffAt.text}</span
          >
        {/if}
        <div class="c" style:--title="{titlePx}px" style:--inner="{Math.round(size * 0.95)}px">
          <div class="clock">{clockLine(now)}</div>
          <h1 class="name">{app.project?.name ?? "New chat"}</h1>
          <div class="hello"><span class="dot" class:off={!ready}></span>{hello}</div>
          <div class="zero"><b>{shortTokens(used)}</b> of {limit ? shortTokens(limit) : "—"} in context</div>
        </div>
      </div>
    {:else}
      <!-- A pane too short for the dial: the name and the greeting alone. -->
      <h1 class="name flat">{app.project?.name ?? "New chat"}</h1>
      <div class="hello flat"><span class="dot" class:off={!ready}></span>{hello}</div>
    {/if}

    <div class="colw" style:max-width="{colMax}px" bind:clientHeight={colH}>
      {#if row.length > 0}
        <div class="ready" aria-label="What is ready">
          {#each row as r (r.key)}
            <button class="rd" class:warn={r.warn} use:tipAction={`${r.value} — ${r.sub}`} onclick={() => act(r)}>
              <span class="rd-k">{r.label}</span>
              <span class="rd-v">{#if r.ok}<i>✓</i>{/if}{r.short}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if app.project && !app.project.exists && app.project.root}
        <p class="warn">
          That folder is not there right now. Tools rooted at it will fail until
          it comes back.
        </p>
      {/if}
      {#if !app.project}
        <p class="lede">
          No folder — the model has no workspace and no shared notes until you
          open a project.
        </p>
      {/if}
      {#if app.error}
        <p class="warn">{app.error}</p>
      {/if}

      <div class="composer-slot">
        <Composer floating />
      </div>

      {#if !app.project}
        <div class="unfiled">
          <button class="ns-btn outline" onclick={showNewProject}>
            <Icon name="plus" size={13} />
            New project…
          </button>
          <button class="ns-btn ghost" onclick={() => void openProjectFolder()}>
            <Icon name="folder" size={13} />
            Open project…
          </button>
          <button class="ns-btn ghost" onclick={() => void importFromClaude()}>
            <Icon name="download" size={13} />
            Import from Claude…
          </button>
          <span class="import-note">
            Turns a claude.ai export into projects: instructions, knowledge and chats.
          </span>
        </div>
      {/if}

      <div class="kinds" role="radiogroup" aria-label="Kind of chat">
        {#each kinds as k (k.id)}
          <button
            class="kind"
            class:on={chosen === k.id}
            role="radio"
            aria-checked={chosen === k.id}
            use:tipAction={k.tip}
            onclick={() => pick(k)}
          >
            <b><span class="kn">{k.name}</span>{#if k.key}<span class="kk-key">{k.key}</span>{/if}</b>
            <span class="kl">{k.line}</span>
          </button>
        {/each}
      </div>

      {#if threads.length > 0}
        <div class="thr">
          <div class="ns-cap">Or pick up a thread</div>
          {#each threads as t (t.slug)}
            <button
              class="tr"
              class:on={app.pendingThread === t.slug}
              disabled={app.busy || app.connecting}
              use:tipAction={"A new chat in this thread, its hand-off in the box"}
              onclick={() => void newChatInThread(t.slug)}
            >
              <span class="tdot"></span>
              <span class="tt">{t.title}</span>
              <span class="ts">{t.status || t.slug}</span>
              <i>{threadWhen(t.touched, now)}</i>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="keys" aria-label="Keyboard shortcuts">
    <button class="kk" onclick={() => runMenuCommand("commands")} use:tipAction={"Every command and its key"}>
      <Kbd keys="{mod}K" />Commands
    </button>
    <button class="kk" onclick={() => runMenuCommand("projects")} use:tipAction={"Switch project — 1–9, N new, O open, I import, 0 leave"}>
      <Kbd keys="{mod}P" />Projects
    </button>
    <button class="kk" onclick={() => runMenuCommand("model")} use:tipAction={"Model, tasks and context"}>
      <Kbd keys="{mod}M" />Model
    </button>
    <button class="kk" onclick={() => runMenuCommand("settings")}>
      <Kbd keys="{mod}," />Settings
    </button>
  </div>
</div>
{/if}

<style>
  .welcome {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding: 10px 1.5rem 2.75rem;
    background-image: var(--ground-dots);
    background-size: 22px 22px;
  }
  .page {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  /* The page scrolls rather than squeezing what is in it. */
  .page > * {
    flex: none;
  }
  .colw {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  /* ---- the dial and what is in it */
  .core {
    position: relative;
    flex: none;
    margin-bottom: 4px;
  }
  .dial-wrap {
    position: absolute;
    inset: 0;
  }
  .tq {
    position: absolute;
    font: 10px var(--mono);
    color: var(--dim);
    white-space: nowrap;
    pointer-events: none;
  }
  .tq.h {
    color: var(--ink2);
  }
  .c {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    pointer-events: none;
  }
  .clock {
    font: 11px var(--mono);
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .name {
    margin: 6px 0 8px;
    font: 300 var(--title, 33px) / 1.1 var(--sans);
    letter-spacing: -0.02em;
    color: var(--ink);
    max-width: var(--inner, 280px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.flat {
    --title: 28px;
    max-width: 100%;
    margin-top: 18px;
  }
  .hello {
    font-size: 13px;
    color: var(--ink2);
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .hello.flat {
    margin-bottom: 12px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--done);
    flex: none;
  }
  .dot.off {
    background: var(--dim);
  }
  .zero {
    margin-top: 16px;
    font: 11px var(--mono);
    color: var(--dim);
  }
  .zero b {
    font-weight: 500;
    font-size: 13px;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }

  /* ---- lit (IV+): read-outs on leader lines, two thin inner rings */
  .leaders,
  .irings {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
  }
  .leaders line {
    stroke: var(--line2);
  }
  .leaders .foot {
    fill: var(--ink2);
  }
  .leaders .tip {
    fill: var(--accent);
  }
  .ir1 {
    stroke: var(--line2);
    stroke-width: 1;
  }
  .ir2 {
    stroke: var(--signal);
    stroke-opacity: 0.55;
    stroke-width: 2;
  }
  .ir3 {
    stroke: var(--line);
    stroke-width: 1;
  }
  .ro {
    position: absolute;
    display: block;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 12.5px;
    color: var(--ink);
    white-space: nowrap;
    cursor: pointer;
    text-align: left;
  }
  .ro.l {
    text-align: right;
  }
  .ro-k {
    display: block;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--dim);
    margin-bottom: 3px;
  }
  .ro-v {
    display: block;
  }
  .ro small {
    display: block;
    font: 10.5px var(--mono);
    color: var(--dim);
    margin-top: 2px;
  }
  .ro:hover .ro-v,
  .ro:focus-visible .ro-v {
    color: var(--accent-ink);
  }
  .ro.warn small {
    color: var(--failed);
  }
  /* Calm (IV) and the classic palettes: no read-outs, no rings; the row. */
  :global(:is([data-light="calm"], [data-palette="classic-A"], [data-palette="B"], [data-palette="C"], [data-palette="D"])) .leaders,
  :global(:is([data-light="calm"], [data-palette="classic-A"], [data-palette="B"], [data-palette="C"], [data-palette="D"])) .irings,
  :global(:is([data-light="calm"], [data-palette="classic-A"], [data-palette="B"], [data-palette="C"], [data-palette="D"])) .ro {
    display: none;
  }
  /* Lit and wide: the read-outs carry the readings, so no row. */
  .wide .ready {
    display: none;
  }
  :global(:is([data-light="calm"], [data-palette="classic-A"], [data-palette="B"], [data-palette="C"], [data-palette="D"])) .wide .ready {
    display: flex;
  }

  /* ---- the calm row of readings */
  .ready {
    display: flex;
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    background: var(--sheet);
    font-size: 12px;
    overflow: hidden;
  }
  .rd {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 7px 12px;
    border: none;
    border-right: 1px solid var(--line);
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rd:last-child {
    border-right: none;
  }
  .rd:hover {
    background: var(--raised);
  }
  .rd-k {
    font-size: 11px;
    color: var(--dim);
    margin-bottom: 2px;
  }
  .rd-v {
    font-weight: 500;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    font-variant-numeric: tabular-nums;
  }
  .rd-v i {
    font-style: normal;
    color: var(--done);
    margin-right: 5px;
    font-size: 10.5px;
  }
  .rd.warn .rd-v {
    color: var(--failed);
  }

  .lede {
    margin: 0;
    font-size: 13.5px;
    color: var(--dim);
    text-align: center;
  }
  .warn {
    margin: 0;
    color: var(--error);
    font-size: 0.78rem;
    line-height: 1.5;
    text-align: center;
  }
  .composer-slot {
    width: 100%;
    margin-top: 2px;
  }
  .unfiled {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .ns-btn.outline {
    background: transparent;
    color: var(--accent);
    border-color: var(--accent);
  }
  .ns-btn.outline:hover {
    background: var(--accent-soft);
  }
  .import-note {
    font-size: 12px;
    color: var(--dim);
    flex-basis: 100%;
    text-align: center;
  }

  /* ---- the four kinds */
  .kinds {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    background: var(--sheet);
    overflow: hidden;
  }
  .kind {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-width: 0;
    padding: 9px 12px 10px;
    border: none;
    border-right: 1px solid var(--line);
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .kind:last-child {
    border-right: none;
  }
  .kind:hover {
    background: var(--raised);
  }
  .kind b {
    font-weight: 500;
    font-size: 13px;
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--ink2);
  }
  .kind b::before {
    content: "";
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 1.5px solid var(--line2);
    flex: none;
  }
  .kn {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .kk-key {
    margin-left: auto;
    font: 10.5px var(--mono);
    color: var(--dim);
    flex: none;
  }
  .kl {
    margin: 4px 0 0 19px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--dim);
  }
  .kind.on {
    background: var(--well);
  }
  .kind.on b {
    color: var(--ink);
    font-weight: 600;
  }
  .kind.on b::before {
    border: 3.5px solid var(--accent);
    background: var(--on-accent);
  }
  .kind.on .kl {
    color: var(--ink2);
  }
  .kind:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  /* ---- the threads */
  .thr {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
  }
  .thr .ns-cap {
    margin-bottom: 6px;
  }
  .tr {
    display: grid;
    grid-template-columns: 8px minmax(0, 150px) minmax(0, 1fr) 70px;
    gap: 14px;
    align-items: center;
    padding: 7px 0;
    border: none;
    border-top: 1px solid var(--line);
    background: none;
    font: inherit;
    font-size: 12.5px;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }
  .tr:hover:not(:disabled) .tt {
    color: var(--accent-ink);
  }
  .tr:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .tdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
  }
  .tr.on .tdot {
    background: var(--accent);
  }
  .tt,
  .ts {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ts {
    color: var(--dim);
  }
  .tr i {
    font: 10.5px var(--mono);
    color: var(--dim);
    font-style: normal;
    text-align: right;
  }

  /* ---- the key strip */
  .keys {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 14px;
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding: 0 16px;
    font-size: 11.5px;
    color: var(--dim);
    z-index: 1;
  }
  .kk {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 2px 2px;
    border-radius: 4px;
    font: inherit;
    color: var(--dim);
    cursor: pointer;
  }
  .kk:hover {
    color: var(--ink);
  }
  .kk:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
</style>
