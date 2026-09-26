<script lang="ts">
  import { tip as tipAction } from "./tip";
  import {
    app,
    importFromClaude,
    openProjectFolder,
    pickerModels,
    revealFolder,
    runMenuCommand,
    showNewProject,
    showNote,
  } from "./state.svelte";
  import { MODEL_KEYS, providerLabel } from "./catalog";
  import type { Note, NoteScope } from "./types";
  import Composer from "./Composer.svelte";
  import Icon from "./Icon.svelte";
  import Kbd from "./Kbd.svelte";
  import { isMac } from "./platform";
  import { relativeTime } from "./time";

  /**
   * The new-chat page, redesigned 2026-09-13 (nightshift
   * notes/runner-design/surface-redesign-2026-09-13, canvas row 5; blocker
   * 030): the project's notes orbit the composer on an inner ring, the
   * knowledge base's on an outer one. Hover pauses a note and shows its
   * first line; click opens it in the centre pane, as the Notes tab does.
   * The project list left the page — ⌘P is the switcher, ⌘K the command
   * palette — and a strip of the stable keys sits at the foot. Nothing the
   * old page could do is gone; the paths moved.
   */

  /**
   * ~~On the Claude Code engine the notes are still on disk and its tools can
   * read them — but nothing indexes them into its prompt, because it
   * assembles its own. So the count line says how many there are, not that a
   * new chat starts knowing them, which on this engine it does not.~~
   * Since 2026-09-14 the indexes cross to that engine too (the preamble
   * bridge in `connect_agent`), so the count line reads the same on both.
   */
  const agentMode = $derived(app.connection?.engine === "claude-code");

  // The rings. Capped: a forty-note vault as a ring of text would be the
  // clutter the round-2 critique was about; the rest are one click away.
  const INNER_MAX = 8;
  const OUTER_MAX = 6;
  const inner = $derived(app.project ? app.notes.slice(0, INNER_MAX) : []);
  const outer = $derived(app.vault.slice(0, OUTER_MAX));

  // Stage geometry, read off the element so the ellipses follow the pane.
  let w = $state(0);
  let h = $state(0);
  // Below this the rings would cross the column; the column alone remains.
  const rings = $derived(w >= 760 && h >= 480);
  const cx = $derived(w / 2);
  const cy = $derived(h / 2 - 16);
  // Inner ring first; the outer one stays inside the pane (a chip is ~70px
  // either side of its centre), and the column is sized to clear the inner
  // ring — on the default window it would otherwise graze the composer.
  const innerR = $derived({ rx: Math.round(w * 0.33), ry: Math.round(h * 0.26) });
  const outerR = $derived({
    rx: Math.round(Math.min(w * 0.44, w / 2 - 95)),
    ry: Math.round(h * 0.36),
  });
  // 720, up from 560 (his 2026-09-16 review: a long prompt "feels kinda
  // compressed horizontally") — near the open chat's composer width, still
  // held inside the inner ring on a narrow window.
  const colMax = $derived(rings ? Math.min(720, 2 * (innerR.rx - 60)) : 720);

  function ellipse(rx: number, ry: number): string {
    return `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy}`;
  }
  const innerPath = $derived(ellipse(innerR.rx, innerR.ry));
  const outerPath = $derived(ellipse(outerR.rx, outerR.ry));
  const INNER_LAP = 240; // seconds — the board's "one lap ≈ 4 min"
  const OUTER_LAP = 400;

  interface Traveller {
    scope: NoteScope;
    note: Note;
    path: string;
    lap: number;
    /** Negative, so the ring starts spread rather than bunched. */
    delay: number;
  }
  const travellers = $derived.by((): Traveller[] => {
    const out: Traveller[] = [];
    inner.forEach((note, i) =>
      out.push({
        scope: "project",
        note,
        path: innerPath,
        lap: INNER_LAP,
        delay: -((i / Math.max(inner.length, 1)) * INNER_LAP),
      }),
    );
    outer.forEach((note, i) =>
      out.push({
        scope: "knowledge",
        note,
        path: outerPath,
        lap: OUTER_LAP,
        // Offset by half a slot so an outer note never starts directly
        // above an inner one.
        delay: -(((i + 0.5) / Math.max(outer.length, 1)) * OUTER_LAP),
      }),
    );
    return out;
  });

  /**
   * The hovered note's preview card. Positioned from where the traveller
   * *is* when the pointer reaches it — it is moving — and kept open while
   * the pointer crosses to the card, or "open" could never be clicked.
   */
  let tip = $state<{ t: Traveller; x: number; y: number; right: boolean } | null>(null);
  let stage = $state<HTMLElement | null>(null);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  function showTip(t: Traveller, el: HTMLElement) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    const r = el.getBoundingClientRect();
    const s = stage?.getBoundingClientRect();
    if (!s) return;
    const x = r.left - s.left;
    const y = r.top - s.top;
    // The card sits on whichever side has room; 270 = its width + a gap.
    const right = x + r.width + 270 < w;
    tip = { t, x: right ? x + r.width + 8 : x - 268, y: Math.max(8, y - 6), right };
  }
  function hideTipSoon() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (tip = null), 160);
  }
  function holdTip() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
  }
  function key(t: Traveller): string {
    return `${t.scope}:${t.note.name}`;
  }
  const held = $derived(tip ? key(tip.t) : null);

  function open(t: Traveller) {
    tip = null;
    showNote(t.scope, t.note.name);
  }
  function reveal(t: Traveller) {
    tip = null;
    const dir = t.scope === "project" ? app.project?.notes_dir : app.knowledge?.dir;
    void revealFolder(dir);
  }
  /** The last path segment: `research/plan.md` → `plan.md`; the card has the whole. */
  function leaf(name: string): string {
    const i = name.lastIndexOf("/");
    return i >= 0 ? name.slice(i + 1) : name;
  }

  // The count line's parts; nothing renders when there is nothing to count,
  // for the reason the old page gave — an empty docspace is explained by the
  // Notes tab, not here.
  const counts = $derived.by(() => {
    const parts: string[] = [];
    const n = app.project ? app.notes.length : 0;
    const k = app.vault.length;
    if (n > 0) parts.push(`${n} project note${n === 1 ? "" : "s"}`);
    if (k > 0) parts.push(`${k} from your knowledge base`);
    return parts;
  });

  // The key strip. Each cap is a button too, so the mouse loses nothing.
  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";
  // Claude Code: the CLI's four aliases on their letters. The API engine:
  // the picker's models on ⌘⇧1…9 (2026-09-14) — the first five here, the
  // rest in the popover, so a long picker cannot push the strip off the foot.
  const modelKeys = $derived.by(() => {
    if (agentMode) {
      return MODEL_KEYS.map((k) => ({
        id: `model_${k.alias}`,
        label: k.alias,
        key: `${mod}${shift}${k.key}`,
        title: `Switch to ${k.alias}`,
      }));
    }
    return pickerModels()
      .slice(0, 5)
      .map((m, i) => ({
        id: `model_${i + 1}`,
        label: m,
        key: `${mod}${shift}${i + 1}`,
        title: `Switch to ${m} (${providerLabel(app.draft.provider)})`,
      }));
  });
</script>

<div class="welcome" bind:this={stage} bind:clientWidth={w} bind:clientHeight={h}>
  {#if rings && travellers.length > 0}
    <div class="sky" aria-hidden="true">
      <svg viewBox="0 0 {w} {h}" preserveAspectRatio="none">
        {#if inner.length > 0}
          <ellipse cx={cx} cy={cy} rx={innerR.rx} ry={innerR.ry} class="ring" stroke-dasharray="2 6" />
        {/if}
        {#if outer.length > 0}
          <ellipse cx={cx} cy={cy} rx={outerR.rx} ry={outerR.ry} class="ring" stroke-dasharray="2 8" />
        {/if}
      </svg>
    </div>
    {#each travellers as t (key(t))}
      <button
        class="trav"
        class:kb={t.scope === "knowledge"}
        class:held={held === key(t)}
        style:offset-path="path('{t.path}')"
        style:animation-duration="{t.lap}s"
        style:animation-delay="{t.delay}s"
        use:tipAction={t.note.name}
        onmouseenter={(e) => showTip(t, e.currentTarget)}
        onmouseleave={hideTipSoon}
        onfocus={(e) => showTip(t, e.currentTarget)}
        onblur={hideTipSoon}
        onclick={() => open(t)}
      >
        <Icon name="note" size={12} />
        <span class="tname">{t.scope === "knowledge" ? "@kb · " : ""}{leaf(t.note.name)}</span>
      </button>
    {/each}
    {#if tip}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="tip"
        style:left="{tip.x}px"
        style:top="{tip.y}px"
        onmouseenter={holdTip}
        onmouseleave={hideTipSoon}
      >
        <div class="tip-head">
          <span class="tip-name">{tip.t.note.name}</span>
          <span class="tip-when">{relativeTime(tip.t.note.modified)}</span>
        </div>
        {#if tip.t.note.summary}
          <div class="tip-sum">{tip.t.note.summary}</div>
        {/if}
        <div class="tip-acts">
          <button class="tip-open" onclick={() => open(tip!.t)}>open</button>
          <button onclick={() => reveal(tip!.t)}>show in folder</button>
        </div>
      </div>
    {/if}
  {/if}

  <div class="ccol" style:max-width="{colMax}px">
    {#if app.project}
      <h1 class="ctitle">{app.project.name}</h1>
      <button
        class="pathchip"
        use:tipAction={app.project.root ? "Show this folder" : "Show the notes folder"}
        onclick={() => void revealFolder(app.project?.root ?? app.project?.notes_dir)}
      >
        <Icon name="folder" size={13} />
        <span class="ptext">{app.project.root ?? "No folder — notes and chats only"}</span>
        <Icon name="ext" size={12} />
      </button>
      {#if !app.project.exists}
        <p class="warn">
          That folder is not there right now. Tools rooted at it will fail until
          it comes back.
        </p>
      {/if}
    {:else}
      <h1 class="ctitle">New chat</h1>
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

    {#if counts.length > 0}
      <p class="count">
        {counts.join(" · ")} ·
        <button class="link" onclick={() => (app.leftTab = "notes")}>all notes</button>
      </p>
    {/if}

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
  </div>

  <div class="keys" aria-label="Keyboard shortcuts">
    <button class="kk" onclick={() => runMenuCommand("commands")} use:tipAction={"Every command and its key"}>
      <Kbd keys="{mod}K" />commands
    </button>
    <button class="kk" onclick={() => runMenuCommand("projects")} use:tipAction={"Switch project — 1–9, N new, O open, I import, 0 leave"}>
      <Kbd keys="{mod}P" />projects
    </button>
    <button class="kk" onclick={() => runMenuCommand("add_project")} use:tipAction={"Open a folder you already have as a project"}>
      <Kbd keys="{mod}O" />open project
    </button>
    <button class="kk" onclick={() => runMenuCommand("model")} use:tipAction={"Model, tasks and context"}>
      <Kbd keys="{mod}M" />model
    </button>
    <span class="ksep">|</span>
    {#each modelKeys as k (k.id)}
      <button class="kk" use:tipAction={k.title} onclick={() => runMenuCommand(k.id)}>
        <Kbd keys={k.key} />{k.label}
      </button>
    {/each}
    <span class="ksep">|</span>
    <button class="kk" onclick={() => runMenuCommand("new_chat")}>
      <Kbd keys="{mod}N" />new chat
    </button>
    <!-- The two other kinds (nightshift backlog 059): incognito on ⌘⇧N;
         ephemeral has no key, and the cap is still a button. -->
    <button class="kk" onclick={() => runMenuCommand("new_incognito")} use:tipAction={"Kept and marked; writes nothing, unread by other chats"}>
      <Kbd keys="{mod}{shift}N" />incognito
    </button>
    <button class="kk" onclick={() => runMenuCommand("new_ephemeral")} use:tipAction={"Nothing is kept; gone when you close it"}>
      ephemeral
    </button>
    <button class="kk" onclick={() => runMenuCommand("settings")}>
      <Kbd keys="{mod}," />settings
    </button>
  </div>
</div>

<style>
  .welcome {
    flex: 1;
    min-height: 0;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem 1.5rem 3.5rem;
  }

  /* The rings: two dashed ellipses the notes travel along (CSS motion path). */
  .sky {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .sky svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .ring {
    fill: none;
    stroke: var(--line);
  }
  .trav {
    position: absolute;
    left: 0;
    top: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 220px;
    padding: 4px 10px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--well);
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
    cursor: pointer;
    offset-rotate: 0deg;
    /* Centre the chip on the path rather than its top-left corner. */
    offset-anchor: 50% 50%;
    animation: orbit linear infinite;
    z-index: 1;
  }
  .trav :global(.ns-ico) {
    color: var(--dim);
  }
  /* Dashed and a step quieter, and under a project note when the two rings'
     chips cross — they move at different speeds, so they do. */
  .trav.kb {
    border-style: dashed;
    background: var(--sheet);
    color: var(--dim);
    z-index: 0;
  }
  .tname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .trav:hover,
  .trav.held,
  .trav:focus-visible {
    border-color: var(--accent);
    color: var(--ink);
    animation-play-state: paused;
    outline: none;
  }
  @keyframes orbit {
    from {
      offset-distance: 0%;
    }
    to {
      offset-distance: 100%;
    }
  }
  /* Parked at their spread positions — the negative delays do that — for
     anyone who has asked the OS for less motion. */
  @media (prefers-reduced-motion: reduce) {
    .trav {
      animation-play-state: paused;
    }
  }

  .tip {
    position: absolute;
    width: 260px;
    padding: 10px 12px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    font-size: 12px;
    color: var(--ink2);
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 4;
  }
  .tip-head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink);
  }
  .tip-name {
    overflow-wrap: anywhere;
  }
  .tip-when {
    color: var(--dim);
    flex: none;
  }
  .tip-sum {
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .tip-acts {
    display: flex;
    gap: 10px;
    font-size: 11.5px;
  }
  .tip-acts button {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--dim);
    cursor: pointer;
  }
  .tip-acts button:hover {
    color: var(--ink);
  }
  .tip-acts .tip-open {
    color: var(--accent);
  }

  /* The centre column. */
  .ccol {
    position: relative;
    z-index: 2;
    width: 100%;
    max-height: 100%;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .ctitle {
    margin: 0;
    font-family: var(--serif);
    font-size: 30px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.15;
    text-align: center;
    color: var(--ink);
  }
  .lede {
    margin: 0;
    font-size: 13.5px;
    color: var(--dim);
    text-align: center;
  }
  .pathchip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    padding: 5px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--sheet);
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
    cursor: pointer;
  }
  .pathchip :global(.ns-ico) {
    color: var(--dim);
  }
  .pathchip:hover {
    border-color: var(--accent);
    color: var(--ink);
  }
  .ptext {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
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
    margin-top: 6px;
  }
  .count {
    margin: 0;
    font-size: 12px;
    color: var(--dim);
    text-align: center;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .link:hover {
    color: var(--accent-ink);
    text-decoration: underline;
  }
  .unfiled {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 4px;
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

  /* The key strip. */
  .keys {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 18px;
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding: 0 16px;
    font-size: 12px;
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
    font-size: 12px;
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
  .ksep {
    opacity: 0.4;
  }
</style>
