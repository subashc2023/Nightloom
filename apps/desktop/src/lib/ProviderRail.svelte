<script lang="ts">
  import { app, applyDraft, useEngine, usable, usePrompt } from "./state.svelte";
  import {
    AGENT_MODELS,
    isProviderVisible,
    modelsFor,
    providerLabel,
    sanitizeThinking,
    thinkingSupport,
  } from "./catalog";

  const agentMode = $derived(app.draft.engine === "claude-code");
  const agent = $derived(app.connection?.agent ?? null);

  /**
   * The last turn's plan window, phrased. This is the only figure in an
   * agent turn that is about what the turn actually spent — the dollar total
   * beside it is the CLI's estimate of what the same turn *would* have cost
   * on the API, which is worth showing precisely because it is the number
   * not being charged.
   */
  const plan = $derived.by(() => {
    const p = app.agentTurn?.plan;
    if (!p) return null;
    const window = p.rateLimitType ?? "plan";
    const status = p.status ?? "unknown";
    return `${window} window ${status}${p.isUsingOverage ? ", on overage" : ""}`;
  });

  // The current selection stays listed even if settings later hide it.
  const providers = $derived(
    app.providers.filter(
      (p) => isProviderVisible(p.kind, app.prefs) || p.kind === app.draft.provider,
    ),
  );
  const selected = $derived(app.providers.find((p) => p.kind === app.draft.provider));
  const models = $derived.by(() => {
    const list = modelsFor(app.draft.provider, app.prefs, selected?.default_model ?? null);
    if (app.draft.model && !list.includes(app.draft.model)) {
      list.unshift(app.draft.model);
    }
    return list;
  });
  const locked = $derived(app.busy || app.connecting);
  const thinking = $derived(thinkingSupport(app.draft.provider, app.draft.model));

  const apply = () => void applyDraft();

  function onProviderChange() {
    const sel = app.providers.find((p) => p.kind === app.draft.provider);
    const list = modelsFor(app.draft.provider, app.prefs, sel?.default_model ?? null);
    app.draft.model =
      sel?.default_model && list.includes(sel.default_model)
        ? sel.default_model
        : (list[0] ?? "");
    sanitizeThinking(app.draft);
    if (app.draft.model) apply();
  }

  function onModelChange() {
    sanitizeThinking(app.draft);
    apply();
  }

  /**
   * The chat is running a system prompt that is not in the library — either
   * typed before the library existed, or one whose saved entry was deleted.
   * It gets its own dropdown entry rather than reading as "None", which
   * would claim there is no system prompt while one is on every request.
   */
  const custom = $derived(
    app.draft.system.trim() !== "" &&
      !app.prompts.some((p) => p.id === app.draft.promptId),
  );

  // The long-form explanations live on the control they explain, not beside
  // it: the rail is 240px wide, and a paragraph per knob is most of the panel.
  const workspaceTitle = $derived(
    app.project
      ? `Set by the project ${app.project.name}. A project is its folder — leave the project to point the tools elsewhere.`
      : app.connection
        ? `${app.connection.workspace}\n\nThe file tools refuse paths outside this folder. bash is not confined.`
        : "The folder the file tools are rooted at. Defaults to where the app was launched.",
  );
</script>

<div class="rail">
  <div class="engines" role="group" aria-label="Engine">
    <button
      class:on={!agentMode}
      disabled={locked}
      onclick={() => void useEngine("provider")}
      title="An API key and Nightloom's own loop: tools, approval gate, sidecar and context editing."
    >
      Provider
    </button>
    <button
      class:on={agentMode}
      disabled={locked}
      onclick={() => void useEngine("claude-code")}
      title="Drive the signed-in Claude Code CLI, so turns are billed to your Claude subscription instead of an API key. It owns the loop, the tools and the history."
    >
      Claude Code
    </button>
  </div>

  <div class="status" title={app.connection?.workspace ?? ""}>
    {#if app.connecting}
      <span class="dot pending"></span><span class="dim">connecting…</span>
    {:else if app.connection}
      <span class="dot ok"></span>
      <span class="conn">{app.connection.provider}</span>
      <span class="sep">·</span>
      <span class="conn model">{app.connection.model}</span>
    {:else}
      <span class="dot off"></span><span class="dim">not connected</span>
    {/if}
  </div>

  {#if agentMode}
    <div class="group">
      <div class="row">
        <span class="lbl">Binary</span>
        <input
          type="text"
          bind:value={app.draft.agentBinary}
          onchange={apply}
          placeholder="claude"
          disabled={locked}
          title={agent?.version
            ? `${agent.binary} — ${agent.version}`
            : "The Claude Code CLI to run. Left empty, `claude` is looked for on PATH and then in the usual install locations (~/.local/bin, /opt/homebrew/bin, /usr/local/bin). Give an absolute path if it lives somewhere else."}
        />
      </div>

      <div class="row">
        <span class="lbl">Model</span>
        <input
          type="text"
          list="agent-models"
          bind:value={app.draft.agentModel}
          onchange={apply}
          placeholder="default"
          disabled={locked}
          title="An alias (fable, opus, sonnet, haiku) or a full model id. The CLI resolves it; the snapshot it picked is shown above once a turn has run."
        />
        <datalist id="agent-models">
          {#each AGENT_MODELS.filter(Boolean) as m (m)}
            <option value={m}></option>
          {/each}
        </datalist>
      </div>

      {#if agent}
        <p class="note" class:warn={!agent.subscription}>
          {#if agent.subscription}
            Billed to your Claude subscription — <code>ANTHROPIC_API_KEY</code> is
            withheld from the CLI.
          {:else}
            An API key in the environment will be used, and the API billed.
          {/if}
        </p>
        {#if agent.resume}
          <p class="note">
            Continuing Claude Code session <code>{agent.resume.slice(0, 8)}</code>.
          </p>
        {/if}
      {/if}
    </div>
  {:else}
  <div class="group">
    <div class="row">
      <span class="lbl">Provider</span>
      <select bind:value={app.draft.provider} onchange={onProviderChange} disabled={locked}>
        {#each providers as p (p.kind)}
          <option value={p.kind} disabled={!usable(p)}>
            {providerLabel(p.kind)}{usable(p) ? "" : " — no key"}
          </option>
        {/each}
      </select>
    </div>

    <div class="row">
      <span class="lbl">Model</span>
      {#if models.length > 0}
        <select
          bind:value={app.draft.model}
          onchange={onModelChange}
          disabled={locked}
          title={app.draft.model}
        >
          {#each models as m (m)}
            <option value={m}>{m}</option>
          {/each}
        </select>
      {:else}
        <input
          type="text"
          bind:value={app.draft.model}
          onchange={onModelChange}
          placeholder="model id"
          disabled={locked}
        />
      {/if}
    </div>

    {#if app.draft.provider === "openai-chat"}
      <div class="row">
        <span class="lbl">Base URL</span>
        <input
          type="text"
          bind:value={app.draft.baseUrl}
          onchange={apply}
          placeholder="localhost:11434/v1"
          disabled={locked}
        />
      </div>
    {/if}

    <div class="row">
      <span class="lbl">Thinking</span>
      <select
        bind:value={app.draft.thinkingMode}
        onchange={apply}
        disabled={locked}
        title={thinking.note}
      >
        {#each thinking.choices as c (c.value)}
          <option value={c.value}>{c.label}</option>
        {/each}
      </select>
    </div>

    {#if app.draft.thinkingMode === "budget"}
      <div class="row">
        <span class="lbl">Budget</span>
        <input
          type="number"
          bind:value={app.draft.budget}
          onchange={apply}
          min="1"
          step="1024"
          disabled={locked}
        />
      </div>
    {/if}
  </div>
  {/if}

  <div class="group">
    <label
      class="sw"
      title={agentMode
        ? "Claude Code's own tools — Read, Edit, Bash and the rest. Off runs it with none."
        : "read_file, edit_file, bash, grep and the rest — rooted at the folder below."}
    >
      <span>Tools</span>
      <input type="checkbox" bind:checked={app.draft.tools} onchange={apply} disabled={locked} />
    </label>

    {#if app.draft.tools}
      <label
        class="sw"
        title={agentMode
          ? "Claude Code runs its own permission checks in `dontAsk` mode: anything not already permitted is refused. Off is `bypassPermissions`."
          : "Calls that change files or run commands wait for you in the transcript. Reads and task-list writes never ask."}
      >
        <span>{agentMode ? "Restrict permissions" : "Ask before writing"}</span>
        <input
          type="checkbox"
          bind:checked={app.draft.approval}
          onchange={apply}
          disabled={locked}
        />
      </label>
      {#if !app.draft.approval}
        <p class="warn">Every call runs unasked, including <code>bash</code>.</p>
      {/if}
      {#if agentMode}
        <!-- Said rather than implied: the switch above is the familiar one
             and the gate behind it is not. Nightloom's approval prompt gates
             calls its own engine is about to run, and this engine runs its
             own — headless, with nobody to ask. -->
        <p class="note">
          Claude Code decides these itself. Nightloom's approval prompt does not
          run on this engine.
        </p>
      {/if}

      {#if !agentMode}
      <label
        class="sw"
        title="web_fetch reads a URL, web_search finds one. Both leave this machine, and both ask first."
      >
        <span>Web access</span>
        <input type="checkbox" bind:checked={app.draft.web} onchange={apply} disabled={locked} />
      </label>

      <label
        class="sw"
        title="Offers compact_context, so the model can ask for its own history to be summarised at the end of a turn. Off means only you compact, from the button above the transcript."
      >
        <span>Self-compaction</span>
        <input
          type="checkbox"
          bind:checked={app.draft.selfCompact}
          onchange={apply}
          disabled={locked}
        />
      </label>
      {/if}
    {/if}

    {#if agentMode}
      <label
        class="sw"
        title="Run without the host's CLAUDE.md, hooks, plugins and MCP servers. This is --safe-mode and not --bare: bare mode never reads OAuth credentials, so it would put the turn back on an API key."
      >
        <span>Safe mode</span>
        <input
          type="checkbox"
          bind:checked={app.draft.agentSafeMode}
          onchange={apply}
          disabled={locked}
        />
      </label>
    {:else}
      <label class="sw" title="Identity, environment, AGENTS.md instructions and the notes index.">
        <span>Preamble</span>
        <input
          type="checkbox"
          bind:checked={app.draft.preamble}
          onchange={apply}
          disabled={locked}
        />
      </label>

      <label class="sw" title="Clock, context gauge and task list, appended to each turn.">
        <span>Per-turn status</span>
        <input
          type="checkbox"
          bind:checked={app.draft.sidecar}
          onchange={apply}
          disabled={locked}
        />
      </label>
    {/if}
  </div>

  {#if app.draft.tools}
    <div class="group">
      <div class="row">
        <span class="lbl">Folder</span>
        <input
          class="path"
          class:tail={!!app.project}
          type="text"
          value={app.project
            ? (app.project.root ?? app.connection?.workspace ?? "")
            : app.draft.workspace}
          oninput={(e) => {
            if (!app.project) app.draft.workspace = e.currentTarget.value;
          }}
          onchange={apply}
          placeholder="launch folder"
          title={workspaceTitle}
          disabled={locked || !!app.project}
          readonly={!!app.project}
        />
      </div>

      {#if !agentMode && app.connection && app.connection.mcp.length > 0}
        <div class="row mcp-row">
          <span class="lbl">MCP</span>
          <div class="mcp">
            {#each app.connection.mcp as server (server.name)}
              <span
                class="chip"
                class:failed={server.error !== null}
                title={server.error ??
                  `${server.tools} tool${server.tools === 1 ? "" : "s"} — MCP tools always ask before running.`}
              >
                {server.name}
                <b>{server.error ? "✕" : server.tools}</b>
              </span>
            {/each}
          </div>
        </div>
      {/if}

      {#if !agentMode && app.connection && app.draft.web}
        <div class="row mcp-row">
          <span class="lbl">Web</span>
          <div class="mcp">
            <span
              class="chip"
              title="Read a URL. It cannot run JavaScript, so a page built in the browser comes back empty."
            >
              web_fetch
            </span>
            {#if app.connection.search}
              <!-- The whole chain, arrowed. A query goes to one of them, but
                   which one depends on whether the ones before it answered,
                   so all of them can see a query and all of them are named. -->
              <span
                class="chip"
                title="Queries are sent to {app.connection.search}, in that order — the next one only if the one before it cannot answer."
              >
                web_search
              </span>
            {:else}
              <span class="none">no search key — add one in Settings</span>
            {/if}
          </div>
        </div>
      {/if}

      {#if !agentMode && app.connection && app.draft.tools}
        <div class="row mcp-row">
          <span class="lbl">Review</span>
          <div class="mcp">
            {#if app.connection.reviewers.length > 0}
              {#each app.connection.reviewers as reviewer (reviewer.name)}
                <span
                  class="chip"
                  title="{reviewer.model} — a second opinion on a document. It reads the file and this workspace, never this conversation."
                >
                  {reviewer.name}
                </span>
              {/each}
            {:else}
              <span class="none"
                >no second provider — add another API key in Settings</span
              >
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <div class="group">
    <div class="row">
      <span class="lbl">System</span>
      <select
        value={app.draft.promptId ?? (custom ? "__custom" : "")}
        onchange={(e) => {
          const v = e.currentTarget.value;
          if (v === "__custom") return; // already showing it
          void usePrompt(v || null);
        }}
        disabled={locked}
        title={app.draft.system ||
          (agentMode
            ? "Appended to Claude Code's own system prompt."
            : "No system prompt beyond the preamble.")}
      >
        <option value="">None</option>
        {#if custom}
          <option value="__custom">Custom (unsaved)</option>
        {/if}
        {#each app.prompts as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
      <button
        class="icon"
        title="Saved system prompts"
        onclick={() => (app.showPrompts = true)}>✎</button
      >
    </div>
  </div>

  {#if agentMode && app.agentTurn}
    <div class="group">
      {#if plan}
        <p class="note">plan: {plan}</p>
      {/if}
      {#if app.agentTurn.cost_usd != null}
        <p
          class="note dim"
          title="What the same turn would have cost on the API. Under a subscription it is not charged — which is the only reading of this number that is true."
        >
          last turn ≈ ${app.agentTurn.cost_usd.toFixed(4)} on the API — not charged
        </p>
      {/if}
    </div>
  {/if}

  {#if app.connectError}
    <div class="error">{app.connectError}</div>
  {/if}

  <div class="spacer"></div>
  <button class="manage" onclick={() => (app.showSettings = true)}>
    Providers &amp; models…
  </button>
</div>

<style>
  /* Chrome (panel background, left border) belongs to RightRail now;
     this is one pane inside its tab strip. */
  .rail {
    display: flex;
    flex-direction: column;
    padding: 0.6rem 0.7rem 0.7rem;
    overflow-y: auto;
    min-height: 0;
    flex: 1;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.72rem;
    min-height: 1.2rem;
    padding-bottom: 0.6rem;
    overflow: hidden;
  }
  .conn {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .conn.model {
    color: var(--dim);
    flex-shrink: 1;
  }
  .sep {
    color: var(--dim);
    opacity: 0.5;
  }
  .dim {
    color: var(--dim);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.ok {
    background: #6fdc8c;
  }
  .dot.off {
    background: var(--dim);
  }
  .dot.pending {
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  /* Hairline-separated bands, so the rail scans as four short blocks
     rather than one long column of labelled boxes. */
  .group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.55rem 0;
    border-top: 1px solid var(--border);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .lbl {
    font-size: 0.68rem;
    color: var(--dim);
    width: 3.9rem;
    flex-shrink: 0;
  }
  select,
  input[type="text"],
  input[type="number"] {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.25rem 0.35rem;
    font-size: 0.76rem;
    font-family: inherit;
    width: 100%;
    min-width: 0;
  }
  .path {
    font-family: var(--mono);
    font-size: 0.68rem;
    text-overflow: ellipsis;
  }
  /* rtl keeps the tail of a long path visible — the leaf folder is the part
     worth reading, and it is the part ltr clips. Only on the read-only
     (project-set) field: it puts the caret at the wrong end while typing. */
  .path.tail {
    direction: rtl;
    text-align: left;
  }
  select:focus,
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  select:disabled,
  input:disabled {
    opacity: 0.55;
  }
  option:disabled {
    color: var(--dim);
  }

  /* Pill switches: the label reads as a statement, the pill as its state. */
  .sw {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.78rem;
    cursor: pointer;
    padding: 0.1rem 0;
  }
  .sw input {
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    width: 26px;
    height: 15px;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--border);
    position: relative;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .sw input::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--dim);
    transition:
      transform 0.15s ease,
      background 0.15s ease;
  }
  .sw input:checked {
    background: rgba(139, 124, 246, 0.35);
  }
  .sw input:checked::after {
    transform: translateX(11px);
    background: var(--accent);
  }
  .sw input:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .warn {
    margin: 0;
    font-size: 0.68rem;
    line-height: 1.3;
    color: var(--error);
    opacity: 0.85;
  }
  .warn code {
    font-family: var(--mono);
    font-size: 0.64rem;
  }

  /* A statement of fact about the connection, where .warn is a caution. */
  .note {
    margin: 0;
    font-size: 0.68rem;
    line-height: 1.35;
    color: var(--dim);
  }
  .note.dim {
    opacity: 0.75;
  }
  .note.warn {
    color: var(--error);
  }
  .note code {
    font-family: var(--mono);
    font-size: 0.64rem;
  }

  /* Two buttons reading as one control, so the choice looks like a mode and
     not like two things you could have both of. */
  .engines {
    display: flex;
    gap: 1px;
    padding: 0 0 0.55rem;
  }
  .engines button {
    flex: 1;
    padding: 0.28rem 0.3rem;
    font-size: 0.68rem;
    font-family: inherit;
    color: var(--dim);
    background: var(--panel-alt, rgba(127, 127, 127, 0.08));
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .engines button:first-child {
    border-radius: 3px 0 0 3px;
  }
  .engines button:last-child {
    border-radius: 0 3px 3px 0;
  }
  .engines button.on {
    color: var(--fg);
    background: var(--bg);
    border-color: var(--accent);
  }
  .engines button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .icon {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.75rem;
    line-height: 1;
    padding: 0.3rem 0.4rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .icon:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .mcp-row {
    align-items: flex-start;
  }
  .none {
    font-size: 0.68rem;
    color: var(--dim);
  }
  .mcp {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    font-size: 0.68rem;
    color: var(--dim);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip b {
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .chip.failed,
  .chip.failed b {
    color: var(--error);
    border-color: rgba(246, 109, 124, 0.35);
  }

  .error {
    color: var(--error);
    background: rgba(246, 109, 124, 0.08);
    border: 1px solid rgba(246, 109, 124, 0.3);
    border-radius: 6px;
    padding: 0.4rem 0.5rem;
    font-size: 0.72rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin-top: 0.5rem;
  }
  .spacer {
    flex: 1;
    min-height: 0.5rem;
  }
  .manage {
    background: transparent;
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
    font-size: 0.74rem;
    cursor: pointer;
    text-align: left;
  }
  .manage:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
