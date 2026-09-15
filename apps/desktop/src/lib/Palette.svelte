<script lang="ts">
  import { app, pickerModels, providerPills, reviewProposal, runMenuCommand, switchModelAt, usable, useProject } from "./state.svelte";
  import { MODEL_KEYS, providerLabel } from "./catalog";
  import type { IconName } from "./icons";
  import Icon from "./Icon.svelte";
  import Kbd from "./Kbd.svelte";
  import { isMac } from "./platform";

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
      disabled: app.busy,
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
      disabled: app.busy,
    });
    rows.push({
      id: "open",
      label: "Open project…",
      meta: "a folder you already have",
      icon: "folder",
      key: "O",
      group: "Or",
      run: () => go(() => runMenuCommand("add_project")),
      disabled: app.busy,
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
        disabled: app.busy,
      });
    }
    return rows;
  });

  const commandRows = $derived.by((): Row[] => {
    const agent = app.draft.engine === "claude-code";
    // Claude Code: the CLI's aliases on their letters. The API engine: the
    // picker's models on ⌘⇧1…9, every provider alike (2026-09-14).
    const rows: Row[] = agent
      ? MODEL_KEYS.map((k) => {
          const current = app.draft.agentModel === k.alias;
          return {
            id: `model:${k.alias}`,
            label: `Switch to ${k.alias}`,
            meta: current ? "current" : "the CLI resolves it",
            icon: current ? "check" : "chevr",
            key: `${mod}${shift}${k.key}`,
            group: "Model",
            run: () => go(() => runMenuCommand(`model_${k.alias}`)),
            current,
          };
        })
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
      label: "Engine: Provider ⇄ Claude Code",
      meta: agent ? "on Claude Code — back to an API key" : "on an API key — to your subscription",
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
      {
        id: "projects",
        label: "Switch project…",
        meta: "1–9 inside",
        icon: "folder",
        key: `${mod}P`,
        group: "Go",
        run: () => go(() => runMenuCommand("projects")),
      },
      {
        id: "new_chat",
        label: "New chat",
        meta: "",
        icon: "chat",
        key: `${mod}N`,
        group: "Go",
        run: () => go(() => runMenuCommand("new_chat")),
        disabled: app.busy,
      },
      {
        id: "new_project",
        label: "New project…",
        meta: "a name, a folder made for it",
        icon: "plus",
        key: "",
        group: "Go",
        run: () => go(() => runMenuCommand("new_project")),
        disabled: app.busy,
      },
      {
        id: "add_project",
        label: "Open project…",
        meta: "a folder you already have",
        icon: "folder",
        key: `${mod}O`,
        group: "Go",
        run: () => go(() => runMenuCommand("add_project")),
        disabled: app.busy,
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
</script>

<svelte:window onkeydown={onKey} />

{#if mode}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="scrim" onmousedown={(e) => e.target === e.currentTarget && close()}>
    <div class="pal" role="dialog" aria-label={mode === "projects" ? "Switch project" : "Commands"}>
      <div class="q">
        <Icon name="search" size={15} />
        {#if mode === "commands"}
          <input
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
          {#if g}<div class="g">{g}</div>{/if}
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
  .lbl {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    flex: none;
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
</style>
