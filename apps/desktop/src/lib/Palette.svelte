<script lang="ts">
  import { browseFree, canLeaveProject } from "./state.svelte";
  import {
    app,
    pickerModels,
    providerPills,
    redoLabel,
    reviewProposal,
    runMenuCommand,
    switchModel,
    switchModelAt,
    toggleSidebar,
    undoLabel,
    usable,
    useProject,
  } from "./state.svelte";
  import { toggleTranscriptPref, transcript } from "./transcriptPrefs.svelte";
  import { thinkingToggleDead } from "./activity";
  import { MODEL_KEYS, providerLabel } from "./catalog";
  import { cli } from "./cliUpdate.svelte";
  import { modelList } from "./modelList.svelte";
  import { modelSeen } from "./modelSeen.svelte";
  import { currentCliVersion, familyRows, newestModels } from "./modelSeen";
  import type { IconName } from "./icons";
  import Icon from "./Icon.svelte";
  import Kbd from "./Kbd.svelte";
  import { isMac } from "./platform";
  import { openAgentTab, openTerminalFromBar, terminalCwd } from "./terminal.svelte";

  /**
   * The two keyboard overlays of the 2026-09-13 redesign (canvas row 5,
   * blocker 030's "shell shortcuts as the stable layer"):
   *
   * - **projects** (⌘P): every project on a number, N new, O open, I
   *   import, 0 leave.
   *   No text box — a digit or a letter acts at once.
   * - **commands** (⌘K): every command with its key, filtered by typing.
   *
   * One component because they share everything but the rows: the scrim,
   * the arrow keys, Enter, Escape, the foot. Which one is open is
   * `app.overlay`, so a menu accelerator can open either from anywhere.
   */

  const mode = $derived(app.overlay);

  interface Row {
    id: string;
    label: string;
    meta: string;
    icon: IconName;
    key: string;
    group: string;
    run: () => void;
    disabled?: boolean;
    /** Marks the row that describes the current state (the open project,
     *  the connected model). */
    current?: boolean;
  }

  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";

  function close() {
    app.overlay = null;
  }
  /** Close first, then act: the action may open something else. */
  function go(f: () => void) {
    close();
    f();
  }

  const projectRows = $derived.by((): Row[] => {
    const rows: Row[] = app.projects.map((p, i) => ({
      id: `p:${p.id}`,
      label: p.name,
      meta: `${p.chats} chat${p.chats === 1 ? "" : "s"} · ${p.notes} note${p.notes === 1 ? "" : "s"}${p.exists ? "" : " · folder missing"}`,
      icon: "folder",
      key: i < 9 ? String(i + 1) : "",
      group: "Projects · press a number",
      run: () => go(() => void useProject(p.id)),
      disabled: !canLeaveProject(),
      current: app.project?.id === p.id,
    }));
    // New is the form, Open the folder picker (backlog 047, 2026-09-14).
    // O is an overlay letter like N and I, not a chord: the chord set is
    // blocker 035/043's.
    rows.push({
      id: "new",
      label: "New project…",
      meta: "a name, a folder made for it",
      icon: "plus",
      key: "N",
      group: "Or",
      run: () => go(() => runMenuCommand("new_project")),
      disabled: !canLeaveProject(),
    });
    rows.push({
      id: "open",
      label: "Open project…",
      meta: "a folder you already have",
      icon: "folder",
      key: "O",
      group: "Or",
      run: () => go(() => runMenuCommand("add_project")),
      disabled: !canLeaveProject(),
    });
    rows.push({
      id: "import",
      label: "Import from Claude…",
      meta: "a claude.ai export",
      icon: "download",
      key: "I",
      group: "Or",
      run: () => go(() => runMenuCommand("import_claude")),
      disabled: app.busy,
    });
    if (app.project) {
      rows.push({
        id: "leave",
        label: "Leave project",
        meta: "unfiled chats",
        icon: "chevl",
        key: "0",
        group: "Or",
        run: () => go(() => void useProject(null)),
        disabled: !canLeaveProject(),
      });
    }
    return rows;
  });

  const commandRows = $derived.by((): Row[] => {
    const agent = app.draft.engine === "claude-code";
    // Claude Code: the CLI's aliases on their letters. The API engine: the
    // picker's models on ⌘⇧1…9, every provider alike (2026-09-14).
    // Item 511: each alias's number on the CLI now, as the composer's menu.
    const cliNow = currentCliVersion(cli.status?.installed, app.connection?.agent?.version);
    // ~~One row per alias on its letter, then each family's newest by full
    // id unless an alias shows it (511)~~ — item 518: one row per family,
    // as the composer's menu (`familyRows`): `Switch to Fable 5.2`, the
    // alias noted when it lags, its own row only while the chat is on it.
    const aliases = [...new Set([...MODEL_KEYS.map((k) => k.alias), ...modelList.models])];
    const keyOf = (a: string | null) => {
      const k = a ? MODEL_KEYS.find((m) => m.alias === a) : undefined;
      return k ? `${mod}${shift}${k.key}` : "";
    };
    const rows: Row[] = agent
      ? familyRows(aliases, newestModels(app.modelLists["anthropic"]), modelSeen.byAlias, cliNow, app.draft.agentModel).map((f) => ({
          id: `model:${f.key}`,
          label: `Switch to ${f.label}`,
          // ~~current ? "current" : "the CLI resolves it"~~ (item 511)
          meta: f.detail.replace(/^· /, ""),
          icon: f.on ? "check" : "chevr",
          key: keyOf(f.capAlias),
          group: "Model",
          run: () => go(() => void switchModel(f.pick)),
          current: f.on,
        }))
      : pickerModels().map((m, i) => {
          const current = app.draft.model === m;
          return {
            id: `model:${m}`,
            label: `Switch to ${m}`,
            meta: current ? "current" : providerLabel(app.draft.provider),
            icon: current ? "check" : "chevr",
            key: i < 9 ? `${mod}${shift}${i + 1}` : "",
            group: "Model",
            run: () => go(() => (i < 9 ? runMenuCommand(`model_${i + 1}`) : void switchModelAt(i + 1))),
            disabled: app.busy || app.connecting,
            current,
          };
        });
    rows.push({
      id: "engine",
      label: "Engine: Provider ⇄ Subscription",
      meta: agent ? "on the subscription — back to an API key" : "on an API key — to your subscription",
      icon: "term",
      key: `${mod}E`,
      group: "Model",
      run: () => go(() => runMenuCommand("engine")),
      disabled: app.busy || app.connecting,
    });
    // The provider pills, in the popover's order, on ⌘1…9 (review round
    // 1, 2026-09-13). Not on the Claude Code engine, which has no provider.
    if (!agent) {
      providerPills().forEach((p, i) => {
        const current = p.kind === app.draft.provider;
        rows.push({
          id: `provider:${p.kind}`,
          label: `Switch to ${providerLabel(p.kind)}`,
          meta: current ? "current" : usable(p) ? "" : "no key — add one in Settings",
          icon: current ? "check" : "key",
          key: i < 9 ? `${mod}${i + 1}` : "",
          group: "Provider",
          run: () => go(() => runMenuCommand(`provider_${i + 1}`)),
          disabled: !usable(p) || app.busy || app.connecting,
          current,
        });
      });
    }
    // Undo and redo (nightshift backlog 064): the rows say what they would
    // reverse, and are greyed when nothing can be.
    const undoing = undoLabel();
    const redoing = redoLabel();
    rows.push(
      {
        id: "undo",
        label: undoing ? `Undo ${undoing}` : "Undo",
        meta: undoing ? "the chat's or the list's newest change" : "nothing to undo",
        icon: "revert",
        key: `${mod}Z`,
        group: "Edit",
        run: () => go(() => runMenuCommand("undo_app")),
        disabled: !undoing || app.busy,
      },
      {
        id: "redo",
        label: redoing ? `Redo ${redoing}` : "Redo",
        meta: redoing ? "the change last undone" : "nothing to redo",
        icon: "refresh",
        key: `${mod}Y`,
        group: "Edit",
        run: () => go(() => runMenuCommand("redo_app")),
        disabled: !redoing || app.busy,
      },
    );
    rows.push(
      {
        id: "model",
        label: "Model & tasks",
        meta: "the popover",
        icon: "gear",
        key: `${mod}M`,
        group: "Panels",
        run: () => go(() => runMenuCommand("model")),
      },
      {
        id: "context",
        label: "Context",
        meta: agent ? "the CLI keeps its own — the gauge still counts" : "what the next request carries",
        icon: "cols",
        key: `${mod}${shift}C`,
        group: "Panels",
        run: () => go(() => runMenuCommand("context")),
        disabled: !app.connection,
      },
      // New terminal (nightshift backlog 113, board 12c's ⌘K row): a shell
      // in the project's folder, docked under the chat; dim without one.
      {
        id: "terminal",
        label: "New terminal",
        meta: terminalCwd() ? "a shell in the project folder" : "no folder — this chat has none",
        icon: "term",
        key: "⌃`",
        group: "Panels",
        run: () => go(() => void openTerminalFromBar()),
        disabled: !terminalCwd(),
      },
      // Item 503: what this chat's agent ran, as a view-only terminal.
      {
        id: "agent-commands",
        label: "Agent commands",
        meta: app.activeSessionId ? "this chat's commands and output, view only" : "no chat open",
        icon: "term",
        key: "",
        group: "Panels",
        run: () => go(() => app.activeSessionId && void openAgentTab(app.activeSessionId)),
        disabled: !app.activeSessionId,
      },
      // The two transcript toggles (nightshift backlog 052, 2026-09-14):
      // what the open transcript shows of a reply's working. The label
      // names the change the row makes, so the current state is readable
      // from the palette.
      {
        id: "toggle_thinking",
        label: transcript.thinking ? "Fold thinking to pills" : "Show thinking in every reply",
        meta: "transcript-wide; a click on one block still overrides",
        icon: "cols",
        key: `${mod}${shift}T`,
        group: "Panels",
        run: () => go(() => toggleTranscriptPref("thinking")),
        // Inert where the top-bar chip is (nightshift backlog 097).
        disabled: thinkingToggleDead(app.events, app.connection),
      },
      {
        id: "toggle_tools",
        label: transcript.tools ? "Fold tool calls to one line each" : "Show tool calls in full",
        meta: "transcript-wide; a click on one call still overrides",
        icon: "term",
        key: `${mod}${shift}B`,
        group: "Panels",
        run: () => go(() => toggleTranscriptPref("tool")),
      },
      {
        id: "projects",
        label: "Switch project…",
        meta: "1–9 inside",
        icon: "folder",
        key: `${mod}P`,
        group: "Go",
        run: () => go(() => runMenuCommand("projects")),
      },
      // Search everywhere (nightshift backlog 117, board 11c "from ⌘K"):
      // the panel in the sidebar's column; a collapsed sidebar reopens.
      {
        id: "search_everywhere",
        label: "Search chats…",
        meta: "this project · all chats · notes",
        icon: "search",
        key: isMac ? "⌥⌘F" : "Ctrl+Alt+F",
        group: "Go",
        run: () =>
          go(() => {
            if (app.layout.sidebarCollapsed) toggleSidebar();
            app.search.open = true;
          }),
      },
      // The two kinds (nightshift backlog 102, 2026-09-16): ⌘N a Claude
      // Code chat, ⌥⌘N a Chat. No plain "New chat" row — the sidebar's
      // wide button is that, and it makes the project's default kind.
      {
        id: "new_build",
        label: "New Claude Code chat",
        meta: "the project folder · all tools · Ask / Auto · plans",
        icon: "chat",
        key: `${mod}N`,
        group: "Go",
        run: () => go(() => runMenuCommand("new_build")),
        disabled: app.busy && !browseFree(),
      },
      {
        id: "new_talk",
        label: "New Chat",
        meta: "reads only · Nightloom's tools · the web · no folder",
        icon: "chat",
        key: isMac ? "⌥⌘N" : "Ctrl+Alt+N",
        group: "Go",
        run: () => go(() => runMenuCommand("new_talk")),
        disabled: app.busy && !browseFree(),
      },
      // The two other kinds (nightshift backlog 059, 2026-09-15), one
      // line each, beside the ordinary one.
      {
        id: "new_incognito",
        label: "New incognito chat",
        meta: "kept and marked · writes nothing · unread by other chats",
        icon: "chat",
        key: `${mod}${shift}N`,
        group: "Go",
        run: () => go(() => runMenuCommand("new_incognito")),
        disabled: app.busy && !browseFree(),
      },
      {
        id: "new_ephemeral",
        label: "New ephemeral chat",
        meta: "nothing is kept · gone when closed",
        icon: "chat",
        key: "",
        group: "Go",
        run: () => go(() => runMenuCommand("new_ephemeral")),
        disabled: app.busy && !browseFree(),
      },
      {
        id: "new_project",
        label: "New project…",
        meta: "a name, a folder made for it",
        icon: "plus",
        key: "",
        group: "Go",
        run: () => go(() => runMenuCommand("new_project")),
        disabled: !canLeaveProject(),
      },
      {
        id: "add_project",
        label: "Open project…",
        meta: "a folder you already have",
        icon: "folder",
        key: `${mod}O`,
        group: "Go",
        run: () => go(() => runMenuCommand("add_project")),
        disabled: !canLeaveProject(),
      },
      {
        id: "import",
        label: "Import from claude.ai…",
        meta: "instructions, knowledge and chats",
        icon: "download",
        key: "",
        group: "Go",
        run: () => go(() => runMenuCommand("import_claude")),
        disabled: app.busy,
      },
      // The dream's pending proposal for an always-loaded file, when there
      // is one — the project's first, since that is the more specific of
      // the two (memory-writer 6c, 2026-09-14).
      ...(app.proposals.instructions.length + app.proposals.memory.length > 0
        ? [
            {
              id: "proposals",
              label: "Review proposed instructions",
              meta: [
                app.proposals.instructions.length > 0
                  ? `${app.proposals.instructions.length} for ${app.project?.name ?? "the project"}`
                  : "",
                app.proposals.memory.length > 0 ? `${app.proposals.memory.length} for your memory` : "",
              ]
                .filter(Boolean)
                .join(", "),
              icon: "pencil" as IconName,
              key: "",
              group: "Go",
              run: () =>
                go(() =>
                  reviewProposal(app.proposals.instructions.length > 0 ? "instructions" : "memory"),
                ),
            },
          ]
        : []),
      {
        id: "settings",
        label: "Settings",
        meta: "keys, models, palette",
        icon: "gear",
        key: `${mod},`,
        group: "Go",
        run: () => go(() => runMenuCommand("settings")),
      },
    );
    return rows;
  });

  let filter = $state("");
  let selected = $state(0);
  let input = $state<HTMLInputElement | null>(null);

  const rows = $derived.by((): Row[] => {
    if (mode === "projects") return projectRows;
    const q = filter.trim().toLowerCase();
    return q
      ? commandRows.filter((r) => `${r.label} ${r.meta}`.toLowerCase().includes(q))
      : commandRows;
  });

  // Opening resets the cursor and the filter; the ⌘K box takes focus.
  $effect(() => {
    if (!mode) return;
    filter = "";
    selected = 0;
    if (mode === "commands") queueMicrotask(() => input?.focus());
  });
  // A filter that shrinks the list under the cursor leaves it in range.
  $effect(() => {
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
  });

  function move(d: number) {
    if (rows.length === 0) return;
    selected = (selected + d + rows.length) % rows.length;
  }
  function runSelected() {
    const r = rows[selected];
    if (r && !r.disabled) r.run();
  }

  function onKey(e: KeyboardEvent) {
    if (!mode) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      runSelected();
      return;
    }
    if (mode === "projects" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // A key that names a row runs it: digits for projects, N, O, I, 0.
      const k = e.key.length === 1 ? e.key.toUpperCase() : "";
      const hit = k && rows.find((r) => r.key === k);
      if (hit) {
        e.preventDefault();
        if (!hit.disabled) hit.run();
      }
    }
  }

  /** Group headings, emitted once per run of rows. */
  function heading(i: number): string | null {
    const g = rows[i].group;
    return i === 0 || rows[i - 1].group !== g ? g : null;
  }

  /** How many rows the group starting at `i` holds (item 570: the count
   *  after a Filament IV heading's rule). */
  function groupSize(i: number): number {
    let n = 0;
    while (i + n < rows.length && rows[i + n].group === rows[i].group) n++;
    return n;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if mode}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="scrim" onmousedown={(e) => e.target === e.currentTarget && close()}>
    <div class="pal" role="dialog" aria-label={mode === "projects" ? "Switch project" : "Commands"}>
      <div class="q">
        <Icon name="search" size={15} />
        {#if mode === "commands"}
          <input autocorrect="off" autocapitalize="off"
            bind:this={input}
            bind:value={filter}
            placeholder="Type a command…"
            autocomplete="off"
            spellcheck="false"
          />
        {:else}
          <span class="qt">Switch project…</span>
        {/if}
      </div>
      <div class="list">
        {#each rows as r, i (r.id)}
          {@const g = heading(i)}
          {#if g}<div class="g">{g}<i class="g-rule"></i><span class="g-n">{groupSize(i)}</span></div>{/if}
          <button
            class="row"
            class:on={i === selected}
            class:accent={r.id === "new"}
            class:current={r.current}
            disabled={r.disabled}
            onmouseenter={() => (selected = i)}
            onclick={() => r.run()}
          >
            {#if r.key}<Kbd keys={r.key} />{:else}<span class="nokey"></span>{/if}
            <Icon name={r.icon} size={14} />
            <span class="lbl">{r.label}</span>
            {#if r.current && mode === "projects"}<span class="chk"><Icon name="check" size={13} /></span>{/if}
            {#if r.meta}<span class="m">{r.meta}</span>{/if}
          </button>
        {:else}
          <div class="empty">Nothing matches.</div>
        {/each}
      </div>
      <div class="f">
        <span><Kbd keys="↑↓" /> move</span>
        <span><Kbd keys="↵" /> {mode === "projects" ? "open" : "run"}</span>
        <span><Kbd keys="esc" /> close</span>
        <span class="trigger">{mod}{mode === "projects" ? "P" : "K"}</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: clamp(40px, 14vh, 140px);
    z-index: 45;
  }
  .pal {
    width: 560px;
    max-width: calc(100vw - 2rem);
    max-height: calc(100% - 60px);
    display: flex;
    flex-direction: column;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  .q {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
    font-size: 15px;
    color: var(--dim);
    flex: none;
  }
  .q input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    font: inherit;
    font-size: 15px;
    color: var(--ink);
  }
  .q input::placeholder {
    color: var(--dim);
  }
  .qt {
    color: var(--dim);
  }
  .list {
    overflow-y: auto;
    min-height: 0;
    padding-bottom: 6px;
  }
  .g {
    padding: 10px 14px 4px;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 8px 14px;
    background: transparent;
    border: none;
    font: inherit;
    font-size: 13.5px;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }
  .row.on {
    background: var(--well);
  }
  .row:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .row :global(.ns-ico) {
    color: var(--dim);
  }
  .row.accent,
  .row.accent :global(.ns-ico) {
    color: var(--accent);
  }
  .row.current :global(.ns-ico) {
    color: var(--accent);
  }
  .nokey {
    width: 20px;
    flex: none;
  }
  /* The name never shrinks; the grey meta ellipsizes first (backlog 530). */
  .lbl {
    white-space: nowrap;
    flex: none;
  }
  .chk {
    display: inline-flex;
    color: var(--accent);
  }
  .m {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .empty {
    padding: 14px;
    font-size: 13px;
    color: var(--dim);
  }
  .f {
    display: flex;
    gap: 16px;
    align-items: center;
    padding: 8px 14px;
    border-top: 1px solid var(--line);
    font-size: 11px;
    color: var(--dim);
    flex: none;
  }
  .f span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .trigger {
    margin-left: auto;
    font-family: var(--mono);
  }
  /* Item 570: the heading's rule and count are Filament IV's alone. */
  .g-rule,
  .g-n {
    display: none;
  }

  /* Filament IV stage 6 (item 570, f4-palette.png). Every rule behind
     `:where(:root:not([data-layout="classic"]))`, so Classic keeps the
     rules above untouched: a card in front, the query in an accent-edged
     well, ruled mono headings with their counts, two-line rows (the name,
     the grey line under it) with the key at the right, flat key caps. */
  :global(:where(:root:not([data-layout="classic"]))) .pal {
    width: 600px;
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 22px 56px rgba(0, 0, 0, 0.6);
  }
  :global(:where(:root:not([data-layout="classic"]))) .q {
    margin: 10px 10px 4px;
    padding: 9px 12px;
    border: 1px solid var(--accent);
    border-radius: var(--r1);
    background: var(--term);
    color: var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .qt {
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .list {
    padding: 0 6px 6px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .g {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px 5px;
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .g-rule {
    display: block;
    flex: 1;
    height: 1px;
    background: var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .g-n {
    display: inline;
    letter-spacing: 0;
    color: var(--dim);
  }
  :global(:where(:root:not([data-layout="classic"]))) .row {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto auto;
    column-gap: 10px;
    row-gap: 1px;
    align-items: center;
    padding: 7px 8px;
    border-radius: var(--r1);
    font-size: 13.5px;
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .row.on {
    background: var(--well);
  }
  :global(:where(:root:not([data-layout="classic"]))) .row > :global(.ns-ico) {
    grid-column: 1;
    grid-row: 1;
  }
  :global(:where(:root:not([data-layout="classic"]))) .nokey {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .lbl {
    grid-column: 2;
    grid-row: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  :global(:where(:root:not([data-layout="classic"]))) .m {
    grid-column: 2;
    grid-row: 2;
    margin: 0;
    font-family: var(--sans);
    font-size: 11.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .chk {
    grid-column: 3;
    grid-row: 1 / span 2;
  }
  :global(:where(:root:not([data-layout="classic"]))) .row > :global(.kbd) {
    grid-column: 4;
    grid-row: 1 / span 2;
  }
  :global(:where(:root:not([data-layout="classic"]))) .pal :global(.kbd) {
    border: none;
    background: transparent;
    padding: 0;
    min-width: 0;
    height: auto;
    color: var(--dim);
    font-size: 11px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .empty {
    padding: 14px 8px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .f {
    padding: 9px 14px;
    font-family: var(--mono);
    font-size: 10.5px;
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .pal {
      animation: pal-rise 90ms ease-out;
    }
  }
  @keyframes pal-rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
</style>
