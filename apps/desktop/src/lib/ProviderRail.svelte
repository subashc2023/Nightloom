<script lang="ts">
  import {
    app,
    applyDraft,
    bornKind,
    chatKind,
    currentModelId,
    declaredKind,
    KIND_LINES,
    kindLabel,
    kindSwitchCost,
    kindWorkspace,
    loadContextLimits,
    openModelInstructions,
    pickerModels,
    providerPills,
    switchChatKind,
    chatFolders,
    setChatFolders,
    setProjectFolders,
    useEngine,
    usable,
    usePrompt,
  } from "./state.svelte";
  import * as api from "./api";
  import { fmtTokens } from "./tokens";
  import {
    AGENT_MODELS,
    MODEL_KEYS,
    formatWindow,
    modelsFor,
    providerLabel,
    sanitizeThinking,
    thinkingSupport,
  } from "./catalog";
  import { effortDefaultLabel } from "./effortDefaults";
  import Hint from "./Hint.svelte";
  import Icon from "./Icon.svelte";
  import Kbd from "./Kbd.svelte";
  import { isMac } from "./platform";

  /**
   * The Model pane of the popover, redesigned 2026-09-13 (nightshift
   * surface-redesign-2026-09-13, canvas rows 3 and 6; blocker 031). The
   * knobs are the ones the rail always had — every handler below predates
   * the redesign — laid out so the two questions Swaraag asked answer
   * themselves: the engine is two cards that each say who is billed, and
   * every switch carries a `?` with the sentence that used to be its
   * tooltip. Provider is a row of pills, Model a radio list with each id's
   * ⌘⇧ key and context window, Thinking a segmented control.
   */

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

  // The current selection stays listed even if settings later hide it. The
  // same list `switchProvider` counts, so pill n and ⌘⇧n agree.
  const providers = $derived(providerPills());
  // The same list `switchModelAt` counts, so row n's cap is ⌘⇧n.
  const models = $derived(pickerModels());
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

  function pickProvider(kind: string) {
    if (kind === app.draft.provider) return;
    app.draft.provider = kind;
    onProviderChange();
  }
  function pickModel(m: string) {
    if (m === app.draft.model) return;
    app.draft.model = m;
    onModelChange();
  }
  function pickThinking(v: string) {
    if (v === app.draft.thinkingMode) return;
    app.draft.thinkingMode = v;
    apply();
  }

  /** The approval segment on the Claude Code engine (backlogs 084, 085):
   *  four positions over three draft fields. Auto is the default, the two
   *  asking positions sit together, Off last. */
  type ApprovalPosition = "auto" | "ask" | "plan" | "off";
  const APPROVAL: { value: ApprovalPosition; label: string; title: string }[] = [
    { value: "auto", label: "Auto", title: "Claude Code's classifier decides each call (`auto`)" },
    { value: "ask", label: "Ask", title: "Pauses on each write, command, question or plan; the transcript asks" },
    { value: "plan", label: "Plan", title: "Reads only, until you approve the plan on its card (`plan`)" },
    { value: "off", label: "Off", title: "Every call runs unasked (`bypassPermissions`)" },
  ];
  /** The line under the segment, one per position (the design's board 3b,
   *  2026-09-16 — "the line under the control changes with it"). Off's is
   *  the warning, drawn in the markup. */
  const APPROVAL_LINE: Record<ApprovalPosition, string> = {
    auto: "The CLI's classifier decides each call; what it can't approve is denied, not asked.",
    ask: "Calls that change files, run commands or leave this machine wait for you — the card at the foot of the turn.",
    plan: "Reads only, then a plan for you to approve before anything is edited.",
    off: "Every call runs unasked, including bash.",
  };
  const approvalPosition = $derived<ApprovalPosition>(
    !app.draft.approval ? "off"
    : app.draft.agentPlan ? "plan"
    : app.draft.agentAsk ? "ask"
    : "auto",
  );
  function pickApproval(v: ApprovalPosition) {
    if (v === approvalPosition) return;
    app.draft.approval = v !== "off";
    app.draft.agentAsk = v === "ask" || v === "plan";
    app.draft.agentPlan = v === "plan";
    apply();
  }

  // The radio list past six rows gets a filter; the list itself is what
  // Settings switched on, in the picker's order.
  let modelFilter = $state("");
  const shownModels = $derived.by(() => {
    const q = modelFilter.trim().toLowerCase();
    return q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  });
  // Context windows for the rows, from the backend's table; blank when unknown.
  $effect(() => {
    if (!agentMode) void loadContextLimits(app.draft.provider, models);
  });
  const windows = $derived(app.contextLimits[app.draft.provider] ?? {});

  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";
  /**
   * The ⌘⇧ cap for a row: its number in the picker (2026-09-14, his second
   * look — "anthropic shouldn't be special": every provider's models are
   * numbered the same way; the letters are Claude Code's). Numbered in the
   * unfiltered list, so typing in the filter does not renumber the rows.
   */
  function keyFor(id: string): string | null {
    const i = models.indexOf(id);
    return i >= 0 && i < 9 ? `${mod}${shift}${i + 1}` : null;
  }
  /**
   * The Claude Code model as pills (review round 1, 2026-09-13): the CLI's
   * aliases, each with its ⌘⇧ key, and *other…* for a full id typed into
   * the field the pills replaced. The field stays for anything the pills
   * do not name, so nothing the old box accepted is refused.
   */
  const AGENT_PILLS = AGENT_MODELS.filter(Boolean);
  let agentOther = $state(false);
  const agentIsAlias = $derived(AGENT_PILLS.includes(app.draft.agentModel.trim()));
  const showAgentField = $derived(agentOther || (!agentIsAlias && app.draft.agentModel.trim() !== ""));
  function pickAgentModel(alias: string) {
    agentOther = false;
    if (alias === app.draft.agentModel) return;
    app.draft.agentModel = alias;
    apply();
  }
  /** The CLI's effort levels (backlog 076), as `claude --help` lists them,
   *  after *default* — the empty value, which sends no `--effort` at all
   *  (review F15, 2026-09-16), as the fallback pills have `none`. */
  const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
  /**
   * What *default* resolves to for the chosen model — the value the
   * segment's first position names (`default · high`), his ask of review
   * round 1 (2026-09-16): "there should be something signaling what the
   * default on that specific model is". Read from backlog 100's table
   * (`effortDefaults.ts`, the documented default per model and engine):
   * a level, `none` for a model with no effort control (Haiku 4.5), `?`
   * when the table has not heard of the model — the empty alias, a
   * foreign id. A `?` is never drawn as a value.
   */
  const effortDefaultText = $derived(effortDefaultLabel("claude-code", app.draft.agentModel));
  /** The line under the Effort segment, one per state (board 3b revised). */
  const effortLine = $derived.by(() => {
    const picked = app.draft.agentEffort;
    const model = app.draft.agentModel.trim() || "the model";
    const d = effortDefaultText;
    if (d === "none") return `${model} has no effort control; the flag is accepted but the docs say it does nothing`;
    if (!picked) {
      return d === "?"
        ? "the CLI has not said what this model's default is; leaving it is still the model's own"
        : `the model's own — ${model} · ${d} on Claude Code`;
    }
    return d === "?" ? "set for this chat" : `set for this chat · the default would be ${d}`;
  });
  function pickEffort(e: string) {
    if (e === app.draft.agentEffort) return;
    app.draft.agentEffort = e;
    apply();
  }
  function pickFallback(alias: string) {
    if (alias === app.draft.agentFallback) return;
    app.draft.agentFallback = alias;
    apply();
  }
  function agentKey(alias: string): string | null {
    const k = MODEL_KEYS.find((m) => m.alias === alias);
    return k ? `${mod}${shift}${k.key}` : null;
  }
  // Back from the library: land on the dropdown that now names the prompt.
  // Back from a model's instruction file: land on the model list, whose
  // pencil opened it.
  let promptSect = $state<HTMLElement | null>(null);
  let modelSect = $state<HTMLElement | null>(null);
  $effect(() => {
    if (app.railScrollTo === "prompt" && promptSect) {
      promptSect.scrollIntoView({ block: "center" });
      app.railScrollTo = null;
    } else if (app.railScrollTo === "model" && modelSect) {
      modelSect.scrollIntoView({ block: "center" });
      app.railScrollTo = null;
    }
  });
  /**
   * The model whose instruction file the pencil opens (nightshift backlog
   * 044): the selected id, or on the Claude Code engine the selected alias
   * — null on that engine's *default*, which names nothing to file under.
   */
  const instructModel = $derived(currentModelId());
  /** Settings takes the popover's place rather than stacking on it. */
  function openSettings() {
    app.showRail = false;
    app.showSettings = true;
  }
  /** The library opens in the popover's place and hands back to it on close. */
  function openPrompts() {
    app.showRail = false;
    app.promptsFrom = "rail";
    app.showPrompts = true;
  }
  /** `effort: low` → `low`, `budget…` → `budget`: the segment is short. */
  function seg(label: string): string {
    return label.replace(/^effort:\s*/, "").replace(/…$/, "");
  }
  /** Short names for the pills; the full label is the tooltip. */
  const PILL: Record<string, string> = {
    "openai-chat": "Local",
    gemini: "Gemini",
  };

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

  /**
   * The open chat's kind (nightshift backlog 102): Claude Code · Chat on
   * the subscription engine, Build · Chat on the provider engine. Read
   * from the log, or the pending kind before the first message. ~~Fixed
   * at creation (blocker 143's default), so the rail states it and does
   * not switch it~~ — switchable since backlog 144 (2026-09-17; blocker
   * 143 answered): the Kind row is the same two-row picker the New chat ▾
   * menu has, and picking the other kind takes effect on the next turn.
   * `declared` is what the request is built for, which a switch leaves
   * alone (the cached prefix with it): a Chat switched from Claude Code
   * keeps its folder and its tool list and simply has the writers refused
   * — so the folder row below reads the *declaration*, not the kind.
   */
  const kind = $derived(chatKind(app.events));
  const declared = $derived(declaredKind(app.events));
  const isChat = $derived(declared === "chat");
  const engineName = $derived(app.connection?.engine ?? app.draft.engine);
  const KIND_ROWS: { kind: "build" | "chat" }[] = [{ kind: "build" }, { kind: "chat" }];

  /** The pending switch, waiting on its one-line confirm: the kind picked
   *  and, for a switch to Claude Code on a chat born as a Chat, the folder
   *  it will run in (the project's, or a pick). */
  let pendingKind = $state<"build" | "chat" | null>(null);
  let pendingFolder = $state<string | null>(null);

  /** What the confirm line says the switch costs and changes — the four
   *  downsides measured for backlog 144, each named only where it applies. */
  const switchLine = $derived.by(() => {
    if (!pendingKind) return "";
    if (pendingKind === "chat") {
      return `From the next turn the shell, file edits, subagents and plans are refused; reads, search and the web stay. The folder stays${
        app.project?.root ? ` (${app.project.root})` : ""
      } and the cache is kept — the tools stay declared, the model is told at the top of your next message.`;
    }
    const cost = kindSwitchCost(app.events, "build");
    const folder = pendingFolder ?? app.project?.root ?? null;
    const parts = ["From the next turn every tool is on, under the approval setting below."];
    if (declared === "chat") {
      parts.push(
        folder
          ? `Runs in ${folder}${
              engineName === "claude-code"
                ? " — the CLI's memory and CLAUDE.md now come from there"
                : ""
            }.`
          : "Pick a folder first — this project has none.",
      );
      parts.push(
        cost && cost > 0
          ? `Switching re-warms the cache: ~${fmtTokens(cost)} tokens written once, since the tools were never declared on this chat.`
          : "The tools are declared from here on.",
      );
    } else {
      parts.push("The cache is kept — the tools were declared all along.");
    }
    return parts.join(" ");
  });

  function askSwitch(to: "build" | "chat") {
    if (to === kind) {
      pendingKind = null;
      return;
    }
    pendingKind = to;
    pendingFolder = to === "build" ? kindWorkspace(app.events) : null;
  }

  /**
   * The extra folders (nightshift backlog 143): what the connection was
   * granted — the project's and the chat's own, each with its source and,
   * on the API engine, the `@alias` the tools spell it by. Two ways in:
   * *Add for this chat…* records a `folders` event on the log, *Add for
   * the project…* writes the registry; either reconnects so the grant
   * holds from the next turn. × takes one back the same way it came.
   */
  const folders = $derived(app.connection?.folders ?? []);
  async function addFolder(scope: "chat" | "project") {
    const picked = await api.pickFolder(
      scope === "chat" ? "A folder this chat may see" : "A folder every chat in this project may see",
      app.project?.root ?? undefined,
    );
    if (!picked) return;
    if (scope === "chat") {
      await setChatFolders([...chatFolders(app.events), picked]);
    } else {
      await setProjectFolders([...(app.project?.extra_folders ?? []), picked]);
    }
  }
  async function removeFolder(path: string, source: string) {
    if (source === "project") {
      await setProjectFolders((app.project?.extra_folders ?? []).filter((f) => f !== path));
    } else {
      await setChatFolders(chatFolders(app.events).filter((f) => f !== path));
    }
  }

  async function pickSwitchFolder() {
    const picked = await api.pickFolder("Folder for this Claude Code chat", app.project?.root ?? undefined);
    if (picked) pendingFolder = picked;
  }

  async function confirmSwitch() {
    const to = pendingKind;
    if (!to) return;
    if (to === "build" && declared === "chat" && !pendingFolder && !app.project?.root) return;
    const folder = to === "build" && declared === "chat" ? (pendingFolder ?? undefined) : undefined;
    pendingKind = null;
    pendingFolder = null;
    await switchChatKind(to, folder);
  }

  // The long-form explanations live on the control they explain — as the
  // `?` beside each one now, where they used to be tooltips.
  const workspaceTitle = $derived(
    isChat
      ? "A Chat has no folder: it runs in a neutral, empty directory (~/.nightloom/chat), whatever the project's folder is. Switch the kind above, or start a Claude Code chat, for the folder."
      : kind === "chat"
        ? `Switched to a Chat from Claude Code: the folder stays and the writers are refused (${app.project?.root ?? app.connection?.workspace ?? "the folder"}).`
        : app.project
        ? `Set by the project ${app.project.name}. A project is its folder — leave the project to point the tools elsewhere.`
        : app.connection
          ? `${app.connection.workspace}\n\nThe file tools refuse paths outside this folder. bash is not confined.`
          : "The folder the file tools are rooted at. Defaults to where the app was launched.",
  );

  const hasReach = $derived(
    !agentMode &&
      !!app.connection &&
      (app.connection.mcp.length > 0 || app.draft.web || app.draft.tools),
  );
</script>

<!-- The pencil beside the selected model (nightshift backlog 044): opens
     the editor on `~/.nightloom/models/<id>.md`, the file read into the
     preamble of a chat on this model and no other. Under the list rather
     than inside a row, because the rows are buttons and a button cannot
     hold one. The popover closes and comes back on Save, the same round
     trip as the system-prompt pencil. On the Claude Code engine the file
     is named after the alias, and *default* names nothing. -->
{#snippet instructionsRow()}
  <div class="row mi">
    <span class="lbl">Instructions</span>
    {#if instructModel}
      <span class="mi-id" title={instructModel}>{instructModel}</span>
      <button
        class="icon"
        title={`Instructions for ${instructModel} only — ~/.nightloom/models/`}
        aria-label={`Instructions for ${instructModel}`}
        disabled={locked}
        onclick={() => openModelInstructions(instructModel!, "rail")}><Icon name="pencil" size={13} /></button
      >
    {:else}
      <span class="mi-id dim">pick a model to give it its own</span>
    {/if}
    <Hint
      text="A file this model alone reads, on top of your memory and under the project's instructions — for how you want this one to talk. Settings lists every model that has one."
    />
  </div>
{/snippet}

<div class="rail">
  <!-- The engine as two cards, each saying who pays and who runs the loop:
       the answer to "what's the difference between Provider and Claude
       Code", on the control itself. -->
  <div class="eng" role="radiogroup" aria-label="Engine">
    <button
      class="ecard"
      class:on={!agentMode}
      role="radio"
      aria-checked={!agentMode}
      disabled={locked}
      onclick={() => void useEngine("provider")}
    >
      <span class="radio"></span>
      <span class="ebody">
        <span class="et">
          Provider
          <span class="ns-pill grey"><Icon name="key" size={11} />your API key</span>
        </span>
        <span class="ed">Your own key, billed per token. Nightloom runs the loop: tools, approval gate, context editing.</span>
      </span>
    </button>
    <button
      class="ecard"
      class:on={agentMode}
      role="radio"
      aria-checked={agentMode}
      disabled={locked}
      onclick={() => void useEngine("claude-code")}
    >
      <span class="radio"></span>
      <span class="ebody">
        <span class="et">
          Subscription
          <span class="ns-pill grey"><Icon name="term" size={11} />your Claude plan</span>
        </span>
        <span class="ed">The signed-in <code>claude</code> CLI, billed to your plan. Its own loop, tools, permissions and history — a Claude Code or a Chat kind, below.</span>
      </span>
    </button>
  </div>

  <!-- The kind (nightshift backlog 102, boards 8a/8b; switchable since
       backlog 144): the same two rows the sidebar's New chat ▾ menu has,
       the dot on the kind the chat is now. Picking the other one shows the
       confirm line and takes effect on the next turn. -->
  <div class="row kind-row">
    <span class="lbl">Kind</span>
    <span class="kind-name">{kindLabel(kind, engineName)}{#if kind !== bornKind(app.events)} <span class="kind-tag">switched</span>{/if}</span>
    <Hint
      text="Claude Code — the project folder, all tools, approval as set below, plan mode within reach. Chat — read-only tools plus Nightloom's own (search chats, notes), the web, its own Chat instructions layer, no working directory. Presets over the same dials: change any of them for this chat and the kind stays. Switchable here for this chat, from the next turn: to a Chat, the tools stay declared and the writers are refused, so the cache is kept; to Claude Code on a chat born as a Chat, the tools are declared once, which re-warms the cache."
    />
  </div>
  <div class="kind-pick" role="radiogroup" aria-label="Kind">
    {#each KIND_ROWS as k (k.kind)}
      <button
        class="kind-opt"
        class:on={k.kind === kind}
        role="radio"
        aria-checked={k.kind === kind}
        disabled={locked}
        onclick={() => askSwitch(k.kind)}
      >
        <span class="kind-glyph" aria-hidden="true">{k.kind === kind ? "●" : "○"}</span>
        <span class="kind-text">
          <span class="kind-opt-name">{kindLabel(k.kind, engineName)}</span>
          <span class="kind-line">{KIND_LINES[k.kind]}</span>
        </span>
      </button>
    {/each}
  </div>
  {#if pendingKind}
    <div class="kind-confirm" role="group" aria-label="Confirm the kind switch">
      <p class="kind-confirm-line">
        <strong>Switch to {kindLabel(pendingKind, engineName)}?</strong>
        {switchLine}
      </p>
      <div class="kind-confirm-btns">
        {#if pendingKind === "build" && declared === "chat"}
          <button class="ns-btn" onclick={() => void pickSwitchFolder()}>Pick a folder…</button>
        {/if}
        <button
          class="ns-btn accent"
          disabled={pendingKind === "build" && declared === "chat" && !pendingFolder && !app.project?.root}
          onclick={() => void confirmSwitch()}
        >
          Switch
        </button>
        <button class="ns-btn" onclick={() => (pendingKind = null)}>Keep {kindLabel(kind, engineName)}</button>
      </div>
    </div>
  {:else if kind !== declared}
    <p class="kind-line kind-note">A Chat over a Claude Code chat: the folder and the tool list stay, the writers are refused when called.</p>
  {/if}

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
    {#if agent}
      <div class="ncard" class:warn={!agent.subscription}>
        {#if agent.subscription}
          Billed to your Claude subscription — <code>ANTHROPIC_API_KEY</code> is
          withheld from the CLI.
        {:else}
          An API key in the environment will be used, and the API billed.
        {/if}
        {#if agent.resume}
          Continuing Claude Code session <code>{agent.resume.slice(0, 8)}</code>.
        {/if}
      </div>
    {/if}

    <section class="sect" bind:this={modelSect}>
      <div class="sect-h">
        <span class="ns-k">Model</span>
        <span class="sub">the CLI resolves the alias</span>
      </div>
      <div class="pv" role="radiogroup" aria-label="Model">
        <button
          class="p"
          class:on={app.draft.agentModel.trim() === "" && !agentOther}
          role="radio"
          aria-checked={app.draft.agentModel.trim() === "" && !agentOther}
          disabled={locked}
          title="Whatever the CLI defaults to"
          onclick={() => pickAgentModel("")}
        >
          default
        </button>
        {#each AGENT_PILLS as a (a)}
          {@const cap = agentKey(a)}
          <button
            class="p"
            class:on={app.draft.agentModel.trim() === a && !agentOther}
            role="radio"
            aria-checked={app.draft.agentModel.trim() === a && !agentOther}
            disabled={locked}
            title={cap ? `${a} — ${cap}` : a}
            onclick={() => pickAgentModel(a)}
          >
            {a}
            {#if cap}<Kbd keys={cap} />{/if}
          </button>
        {/each}
        <button
          class="p"
          class:on={showAgentField}
          role="radio"
          aria-checked={showAgentField}
          disabled={locked}
          title="A full model id, typed"
          onclick={() => (agentOther = true)}
        >
          other…
        </button>
      </div>
      {#if showAgentField}
        <div class="row">
          <span class="lbl">Id</span>
          <input
            type="text"
            bind:value={app.draft.agentModel}
            onchange={apply}
            placeholder="claude-opus-5"
            disabled={locked}
          />
          <Hint
            text="A full model id the CLI accepts. The snapshot it picked is shown in the status line once a turn has run. ⌘⇧S / O / F / H (Command + Shift + the letter) set an alias from anywhere."
          />
        </div>
      {/if}
      {#if app.agentTurn?.model}
        <p class="note">last turn ran <code>{app.agentTurn.model}</code></p>
      {/if}
      {@render instructionsRow()}
    </section>
  {:else}
    <section class="sect">
      <div class="sect-h"><span class="ns-k">Provider</span></div>
      <div class="pv" role="radiogroup" aria-label="Provider">
        {#each providers as p, i (p.kind)}
          <button
            class="p"
            class:on={p.kind === app.draft.provider}
            class:dis={!usable(p)}
            role="radio"
            aria-checked={p.kind === app.draft.provider}
            disabled={locked || !usable(p)}
            title={usable(p)
              ? `${providerLabel(p.kind)}${i < 9 ? ` — ${mod}${i + 1}` : ""}`
              : `${providerLabel(p.kind)} — no key; add one in Settings`}
            onclick={() => pickProvider(p.kind)}
          >
            <span class="d" class:no={!usable(p)}></span>
            {PILL[p.kind] ?? providerLabel(p.kind)}
            {#if i < 9}<Kbd keys={String(i + 1)} dim={!usable(p)} />{/if}
          </button>
        {/each}
      </div>
      <div class="more bare"><span>{mod}number switches anywhere</span></div>
    </section>

    <section class="sect" bind:this={modelSect}>
      <div class="sect-h">
        <span class="ns-k">Model</span>
        <span class="sub">{models.length} in the picker · Settings picks which</span>
      </div>
      {#if models.length > 0}
        <div class="ml" role="radiogroup" aria-label="Model">
          {#if models.length > 6}
            <input
              class="mfilter"
              type="text"
              bind:value={modelFilter}
              placeholder="filter…"
              disabled={locked}
            />
          {/if}
          {#each shownModels as m (m)}
            {@const cap = keyFor(m)}
            <button
              class="r"
              class:on={m === app.draft.model}
              role="radio"
              aria-checked={m === app.draft.model}
              disabled={locked}
              title={m}
              onclick={() => pickModel(m)}
            >
              <span class="rad"></span>
              <span class="id">{m}</span>
              {#if cap}<Kbd keys={cap} />{/if}
              <span class="cx">{formatWindow(windows[m])}</span>
            </button>
          {:else}
            <div class="more">nothing matches</div>
          {/each}
          <div class="more">
            <span>{mod}{shift}number switches anywhere</span>
          </div>
        </div>
      {:else}
        <div class="row">
          <span class="lbl">Model</span>
          <input
            type="text"
            bind:value={app.draft.model}
            onchange={onModelChange}
            placeholder="model id"
            disabled={locked}
          />
          <Hint text="Nothing is switched on for this provider yet. Type a model id, or turn ids on in Settings." />
        </div>
      {/if}

      {@render instructionsRow()}

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
          <Hint text="The server speaking the OpenAI chat/completions format — a local runtime (Ollama, LM Studio, llama.cpp, vLLM) or a custom host." />
        </div>
      {/if}
    </section>

    <section class="sect">
      <div class="sect-h">
        <span class="ns-k">Thinking</span>
        <Hint text={thinking.note} side="right" />
      </div>
      <div class="segs" role="radiogroup" aria-label="Thinking">
        {#each thinking.choices as c (c.value)}
          <button
            class:on={c.value === app.draft.thinkingMode}
            role="radio"
            aria-checked={c.value === app.draft.thinkingMode}
            disabled={locked}
            title={c.label}
            onclick={() => pickThinking(c.value)}
          >
            {seg(c.label)}
          </button>
        {/each}
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
          <Hint text="Thinking tokens per turn, below the model's max output tokens." />
        </div>
      {/if}
    </section>
  {/if}

  <section class="sect">
    <div class="sect-h"><span class="ns-k">Behaviour</span></div>
    <label class="swq">
      <span class="t">Tools</span>
      <Hint
        text={agentMode
          ? "Claude Code's own tools — Read, Edit, Bash and the rest. Off runs it with none."
          : "read_file, edit_file, bash, grep and the rest — rooted at the workspace folder below."}
      />
      <input type="checkbox" class="sw" bind:checked={app.draft.tools} onchange={apply} disabled={locked} />
    </label>

    {#if app.draft.tools && !agentMode}
      <label class="swq sub">
        <span class="t">Ask before writing</span>
        <Hint
          text="Calls that change files or run commands wait for you in the transcript. Reads and task-list writes never ask."
        />
        <input
          type="checkbox"
          class="sw"
          bind:checked={app.draft.approval}
          onchange={apply}
          disabled={locked}
        />
      </label>
      {#if !app.draft.approval}
        <p class="warn sub-note">Every call runs unasked, including <code>bash</code>.</p>
      {/if}
    {/if}
    {#if app.draft.tools && agentMode}
      <!-- Approval on the Claude Code engine (nightshift backlogs 084 and
           085, the design's Rail board): one four-way segment in the
           thinking-segments idiom, Auto · Ask · Plan · Off, over the same
           three draft fields the two switches it replaces were bound to —
           `approval` (off = the Off position, `bypassPermissions`),
           `agentAsk` (the defer hook, backlog 084) and `agentPlan`
           (`plan` mode under the same hook, backlog 085). -->
      <div class="approval sub-note">
        <div class="swq">
          <span class="t">Approval</span>
          <Hint
            text="Auto: Claude Code's own classifier decides each call, and one it cannot approve is refused rather than left waiting. Ask: it pauses on each write, command, question or plan and the transcript asks you. Plan: it only reads until you approve its plan on the card, then goes on as Ask or Auto, your pick there. Off: `bypassPermissions`, every call runs unasked. Reads in the workspace never ask."
          />
        </div>
        <div class="segs" role="radiogroup" aria-label="Approval">
          {#each APPROVAL as c (c.value)}
            <button
              class:on={c.value === approvalPosition}
              class:off={c.value === "off" && approvalPosition === "off"}
              role="radio"
              aria-checked={c.value === approvalPosition}
              disabled={locked}
              title={c.title}
              onclick={() => pickApproval(c.value)}
            >
              {c.label}
            </button>
          {/each}
        </div>
        {#if !app.draft.approval}
          <p class="warn">Every call runs unasked, including <code>bash</code>.</p>
        {:else}
          <p class="note">{APPROVAL_LINE[approvalPosition]}</p>
        {/if}
      </div>
      {#if !(app.draft.approval && app.draft.agentAsk)}
        <!-- Said rather than implied: the switch above is the familiar one
             and the gate behind it is not. Nightloom's approval prompt gates
             calls its own engine is about to run, and this engine runs its
             own — headless, with nobody to ask. With Ask on, it does ask,
             through the CLI's own pause (backlog 084), so the sentence is
             withheld then. -->
        <p class="note sub-note">
          Claude Code decides these itself. Nightloom's approval prompt does not
          run on this engine, and neither do rewind, compaction, the Context tab
          or attachments.
        </p>
      {/if}
    {/if}
    {#if agentMode}
      <!-- Effort and the fallback model (nightshift backlog 076; the
           design's Rail board puts them here, under Approval, each a
           labelled control with its `?`): the six-way segment whose first
           position names what *default* resolves to when that is known
           (review round 1, board 3b revised), and the alias pills with
           `none` first. Both go to the CLI as flags (`--effort`,
           `--fallback-model`) and are saved with the rest of the rail. -->
      <div class="ctl">
        <div class="swq">
          <span class="t">Effort</span>
          <Hint
            text="Claude Code's --effort: how hard the model thinks per turn. default sends no flag and leaves it to the model — high on Fable 5.1, Opus 5 and Sonnet 5, the same as the API's; a level saved in ~/.claude/settings.json (effortLevel, or /effort from a terminal) wins over it. xhigh and max spend more thinking tokens and time, low fewer. A level the model does not support falls back to one it does."
          />
        </div>
        <div class="segs" role="radiogroup" aria-label="Effort">
          {#each EFFORTS as e (e)}
            <button
              class:on={e === app.draft.agentEffort}
              class:d={!e}
              role="radio"
              aria-checked={e === app.draft.agentEffort}
              disabled={locked}
              title={e
                ? `--effort ${e}`
                : effortDefaultText === "?"
                  ? "no --effort flag; the model's own default, which the docs do not name for this model"
                  : `no --effort flag; the model's own default, ${effortDefaultText}`}
              onclick={() => pickEffort(e)}
            >
              {#if e}
                {e}
              {:else}
                default
                <span class="dv" class:unk={effortDefaultText === "?"}>· {effortDefaultText}</span>
              {/if}
            </button>
          {/each}
        </div>
        <p class="note">{effortLine}</p>
      </div>
      <div class="ctl">
        <div class="swq">
          <span class="t">Fallback model</span>
          <Hint
            text="Claude Code's --fallback-model: the alias it retries a turn with when the model above is overloaded or unavailable. none sends no fallback. Kept on the chat like the model; the Last turn section says which one ran."
          />
        </div>
        <div class="pv" role="radiogroup" aria-label="Fallback model">
          <button
            class="p"
            class:on={app.draft.agentFallback.trim() === ""}
            role="radio"
            aria-checked={app.draft.agentFallback.trim() === ""}
            disabled={locked}
            title="No fallback"
            onclick={() => pickFallback("")}
          >
            none
          </button>
          {#each AGENT_PILLS as a (a)}
            <button
              class="p"
              class:on={app.draft.agentFallback.trim() === a}
              role="radio"
              aria-checked={app.draft.agentFallback.trim() === a}
              disabled={locked}
              title="--fallback-model {a}"
              onclick={() => pickFallback(a)}
            >
              {a}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if app.draft.tools}
      {#if !agentMode}
        <label class="swq sub">
          <span class="t">Web access</span>
          <Hint text="web_fetch reads a URL, web_search finds one. Both leave this machine, and both ask first." />
          <input type="checkbox" class="sw" bind:checked={app.draft.web} onchange={apply} disabled={locked} />
        </label>

        <label class="swq sub">
          <span class="t">Self-compaction</span>
          <Hint text="Offers compact_context, so the model can ask for its own history to be summarised at the end of a turn. Off means only you compact, from the button above the transcript." />
          <input
            type="checkbox"
            class="sw"
            bind:checked={app.draft.selfCompact}
            onchange={apply}
            disabled={locked}
          />
        </label>

        <!-- On screen rather than implied by the tools switch, because it is a
             change in *reach*: tools alone has always meant "may write inside
             this folder", and the knowledge base is a second directory outside
             it. -->
        <label class="swq sub">
          <span class="t">Knowledge base</span>
          <Hint text="Gives the model your knowledge base as @kb — an index of it in the system prompt, and read, write and search over it with the file tools. Off keeps the model inside the workspace." />
          <input
            type="checkbox"
            class="sw"
            bind:checked={app.draft.knowledge}
            onchange={apply}
            disabled={locked}
          />
        </label>
        {#if app.draft.knowledge && app.connection?.knowledge}
          <p class="note sub-note">
            Reads and writes <code>{app.connection.knowledge.dir}</code>, outside
            the workspace.
          </p>
        {/if}
      {/if}
    {/if}

    {#if agentMode}
      <label class="swq">
        <span class="t">Safe mode</span>
        <Hint text="Run without your Claude Code setup: no user CLAUDE.md, hooks, skills, allowlist or other MCP servers. Nightloom's own tools (search_chats, read_chat, remember, fetch_page) stay. The project folder's CLAUDE.md still loads. Not --bare, which would put the turn back on an API key." />
        <input
          type="checkbox"
          class="sw"
          bind:checked={app.draft.agentSafeMode}
          onchange={apply}
          disabled={locked}
        />
      </label>
    {/if}

    <!-- Shown on both engines (2026-09-14): the preamble crosses to Claude
         Code now, appended ahead of the system prompt below, so the switch
         that gates it has to be reachable there too. Identity and
         environment stay behind on that engine — the CLI has its own. -->
    <label class="swq">
      <span class="t">Preamble</span>
      <Hint
        text={agentMode
          ? "Your AGENTS.md, the project's, the notes index and the knowledge base index, appended to Claude Code's own system prompt. Off sends only the system prompt below."
          : "Identity, environment, AGENTS.md instructions and the notes index."}
      />
      <input
        type="checkbox"
        class="sw"
        bind:checked={app.draft.preamble}
        onchange={apply}
        disabled={locked}
      />
    </label>

    {#if !agentMode}
      <label class="swq">
        <span class="t">Per-turn status</span>
        <Hint text="Clock, context gauge and task list, appended to each turn." />
        <input
          type="checkbox"
          class="sw"
          bind:checked={app.draft.sidecar}
          onchange={apply}
          disabled={locked}
        />
      </label>
    {/if}
  </section>

  {#if app.draft.tools}
    <section class="sect">
      <div class="sect-h">
        <span class="ns-k">Workspace</span>
        {#if isChat}<span class="sub">none on a Chat</span>{:else if app.project}<span class="sub">set by the project</span>{/if}
      </div>
      <div class="row">
        <span class="lbl">Folder</span>
        <span class="fld-wrap">
          {#if isChat}
            <!-- A Chat has no folder (backlog 102): the neutral directory,
                 stated rather than offered as a field. -->
            <span class="path locked dim-path" title={workspaceTitle}>no folder — a Chat runs in a neutral, empty directory</span>
          {:else}
            {#if app.project}<span class="lock"><Icon name="lock" size={12} /></span>{/if}
            <input
              class="path"
              class:tail={!!app.project}
              class:locked={!!app.project}
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
          {/if}
        </span>
        <Hint text={workspaceTitle} />
      </div>

      <!-- Extra folders (nightshift backlog 143): the folders this chat may
           see beyond the project's home — granted per chat or per project,
           on both engines. -->
      <div class="row fold-row">
        <span class="lbl">Folders</span>
        <div class="fold-list">
          {#each folders as f (f.path)}
            <div class="fold-item" title={f.alias ? `${f.alias}/… reaches ${f.path}` : f.path}>
              {#if f.alias}<code class="fold-alias">{f.alias}</code>{/if}
              <span class="fold-path">{f.path}</span>
              <span class="fold-src">{f.source === "project" ? "project" : "this chat"}</span>
              <button
                class="fold-x"
                title={f.source === "project" ? "Stop granting this folder to the project's chats" : "Stop granting this folder to this chat"}
                aria-label="Remove {f.path}"
                disabled={locked}
                onclick={() => void removeFolder(f.path, f.source)}
              >×</button>
            </div>
          {:else}
            <span class="dim fold-none">{isChat ? "none — a Chat sees no folder" : "none beyond the folder above"}</span>
          {/each}
          {#if !isChat}
            <div class="fold-add">
              <button class="ns-btn" disabled={locked} onclick={() => void addFolder("chat")}>Add a folder for this chat…</button>
              {#if app.project}<button class="ns-btn" disabled={locked} onclick={() => void addFolder("project")}>…for the project</button>{/if}
            </div>
          {/if}
        </div>
        <Hint
          text="A project is not one folder: its content may live in others. A folder added here is readable and editable by the model without an approval per read — on Claude Code as an extra working directory (--add-dir), on the provider engine as a named tree the file tools reach by its @alias. Per chat: recorded on the chat's log, kept on reload, inherited by a fork. Per project: every chat in the project, from its next turn. Notes and AGENTS.md stay in the folder above."
        />
      </div>

      {#if hasReach}
        <div class="row reach-row">
          <span class="lbl">Reach</span>
          <div class="chips">
            {#if app.connection && app.connection.mcp.length > 0}
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
            {/if}
            {#if app.connection && app.draft.web}
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
                  web_search <b>{app.connection.search}</b>
                </span>
              {:else}
                <span class="none">no search key — add one in Settings</span>
              {/if}
            {/if}
            {#if app.connection && app.draft.tools}
              {#if app.connection.reviewers.length > 0}
                {#each app.connection.reviewers as reviewer (reviewer.name)}
                  <span
                    class="chip"
                    title="{reviewer.model} — a second opinion on a document. It reads the file and this workspace, never this conversation."
                  >
                    review <b>{reviewer.name}</b>
                  </span>
                {/each}
              {:else}
                <span class="none">review: needs a second provider's key</span>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
    </section>
  {/if}

  <section class="sect" bind:this={promptSect}>
    <div class="sect-h">
      <span class="ns-k">System prompt</span>
      {#if agentMode}<span class="sub">appended to Claude Code's own</span>{/if}
    </div>
    <div class="row">
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
        aria-label="Saved system prompts"
        onclick={openPrompts}><Icon name="pencil" size={13} /></button
      >
    </div>
  </section>

  {#if agentMode}
    <!-- The binary at the foot, not the head (review round 1, 2026-09-13):
         it is set once and read never, and the pane used to open on it. -->
    <section class="sect">
      <div class="sect-h"><span class="ns-k">CLI</span></div>
      <div class="row">
        <span class="lbl">Binary</span>
        <input
          type="text"
          bind:value={app.draft.agentBinary}
          onchange={apply}
          placeholder="claude"
          disabled={locked}
          title={agent?.version ? `${agent.binary} — ${agent.version}` : ""}
        />
        <Hint
          text="The Claude Code CLI to run. Left empty, `claude` is looked for on PATH and then in the usual install locations (~/.local/bin, /opt/homebrew/bin, /usr/local/bin). Give an absolute path if it lives somewhere else."
        />
      </div>
      {#if agent?.version}
        <p class="note indent">found: <code>{agent.binary}</code> — {agent.version}</p>
      {/if}
    </section>
  {/if}

  {#if agentMode && app.agentTurn}
    <section class="sect">
      <div class="sect-h"><span class="ns-k">Last turn</span></div>
      {#if plan}
        <p class="note">plan: {plan}</p>
      {/if}
      {#if agent}
        <!-- The design's Rail board (2026-09-16): what the turn ran with —
             the effort as sent, the fallback as sent, the permission mode
             the CLI reported. Whether the fallback was *used* is not in
             the stream (backlog 076 measured `modelUsage` naming the
             primary alone), so the line names it rather than claiming. -->
        <p class="note">
          effort {agent.effort ?? "default"} · {agent.fallback_model
            ? `fallback ${agent.fallback_model}`
            : "no fallback"}
          {#if agent.permission_mode}
            · <code>{agent.permission_mode}</code>
          {/if}
        </p>
      {/if}
      {#if app.agentTurn.cost_usd != null}
        <p
          class="note"
          title="What the same turn would have cost on the API. Under a subscription it is not charged — which is the only reading of this number that is true."
        >
          ≈ ${app.agentTurn.cost_usd.toFixed(4)} on the API — <span class="ok">not charged</span>
        </p>
      {/if}
    </section>
  {/if}

  {#if app.connectError}
    <div class="error">{app.connectError}</div>
  {/if}

  <div class="spacer"></div>
  <button class="manage" onclick={openSettings}>
    <Icon name="gear" size={13} />
    Providers, keys &amp; models…
    <Kbd keys="{mod}," />
  </button>
</div>

<style>
  /* Chrome (panel background, left border) belongs to RightRail now;
     this is one pane inside its tab strip. */
  .rail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 10px 12px 12px;
    overflow-y: auto;
    min-height: 0;
    flex: 1;
    scrollbar-width: thin;
  }

  /* The engine cards. */
  .eng {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ecard {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 9px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ecard.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .ecard:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .ecard:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .radio {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid var(--line2);
    flex: none;
    margin-top: 2px;
    position: relative;
  }
  .ecard.on .radio {
    border-color: var(--accent);
  }
  .ecard.on .radio::after {
    content: "";
    position: absolute;
    inset: 2.5px;
    border-radius: 50%;
    background: var(--accent);
  }
  .ebody {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .et {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 500;
  }
  .et .ns-pill {
    margin-left: auto;
    font-size: 10px;
    padding: 0 6px;
  }
  .ed {
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--dim);
  }
  .ecard.on .ed {
    color: var(--ink2);
  }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-family: var(--mono);
    color: var(--dim);
    min-height: 1.2rem;
    overflow: hidden;
  }
  .conn {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex-shrink: 0;
    color: var(--ink2);
  }
  .conn.model {
    color: var(--dim);
    flex-shrink: 1;
  }
  .sep {
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
    background: var(--done);
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

  /* The blue fact card of the agent engine; red when the key is the API's. */
  .ncard {
    padding: 7px 9px;
    border-radius: 6px;
    background: var(--live-soft);
    color: var(--live);
    font-size: 11.5px;
    line-height: 1.4;
  }
  .ncard.warn {
    background: var(--failed-soft);
    color: var(--failed);
  }
  .ncard code {
    font-family: var(--mono);
    font-size: 10.5px;
  }

  /* Sections: a small uppercase label with a rule running to the edge. */
  .sect {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sect-h {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 2px;
  }
  .sect-h::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .sect-h .sub {
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .lbl {
    font-size: 11.5px;
    color: var(--dim);
    width: 56px;
    flex-shrink: 0;
  }
  select,
  input[type="text"],
  input[type="number"] {
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12.5px;
    font-family: inherit;
    width: 100%;
    min-width: 0;
  }
  .fld-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
  }
  .lock {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--dim);
    display: inline-flex;
    pointer-events: none;
  }
  .path {
    font-family: var(--mono);
    font-size: 11.5px;
    text-overflow: ellipsis;
  }
  .path.locked {
    padding-left: 26px;
  }
  /* A Chat's folder row (backlog 102): the sentence where the field is,
     in the field's shape, dimmed. */
  .dim-path {
    font-family: inherit;
    color: var(--dim);
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 11.5px;
    width: 100%;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .dim-path.locked {
    padding-left: 8px;
  }
  /* The kind row under the engine cards (backlog 102): the name in the
     ink, the one-line gloss under it in the dim. */
  .kind-row {
    padding: 8px 0 0;
  }
  .kind-name {
    flex: 1;
    font-size: 12.5px;
  }
  .kind-line {
    margin: 2px 0 8px 64px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--dim);
  }
  /* The picker (backlog 144): two rows in the sidebar menu's shape — a
     dot, the name, the one-line gloss — and the confirm line under them. */
  .kind-pick {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 4px 0 6px 64px;
  }
  .kind-opt {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 4px 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .kind-opt.on {
    border-color: var(--line2);
    background: var(--accent-soft);
  }
  .kind-opt:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .kind-opt:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }
  .kind-opt .kind-line {
    margin: 1px 0 0;
  }
  .kind-glyph {
    flex: none;
    width: 12px;
    font-size: 10px;
    line-height: 18px;
    color: var(--accent);
  }
  .kind-text {
    display: flex;
    flex-direction: column;
  }
  .kind-opt-name {
    font-size: 12.5px;
  }
  .kind-tag {
    font-size: 10.5px;
    color: var(--dim);
    margin-left: 4px;
  }
  .kind-confirm {
    margin: 0 0 8px 64px;
    padding: 8px 10px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--paper);
  }
  .kind-confirm-line {
    margin: 0 0 8px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--dim);
  }
  .kind-confirm-line strong {
    color: var(--ink);
    font-weight: 600;
  }
  .kind-confirm-btns {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .kind-note {
    margin-top: 0;
  }
  /* Extra folders (backlog 143): a list under the Folder row, each with its
     alias, path, source and an ×; the add buttons under it. */
  .fold-row {
    align-items: flex-start;
  }
  .fold-list {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .fold-item {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
    font-size: 11.5px;
  }
  .fold-alias {
    flex: none;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink2);
  }
  .fold-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    color: var(--ink);
  }
  .fold-src {
    flex: none;
    font-size: 10.5px;
    color: var(--dim);
  }
  .fold-x {
    flex: none;
    border: none;
    background: none;
    color: var(--dim);
    font: inherit;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }
  .fold-x:hover:not(:disabled) {
    color: var(--ink);
  }
  .fold-none {
    font-size: 11.5px;
  }
  .fold-add {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 2px;
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
  .note.indent {
    padding-left: 64px;
  }

  /* Provider pills: the dot is the key. */
  .pv {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .pv .p {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border: 1px solid var(--line2);
    border-radius: 999px;
    font: inherit;
    font-size: 12px;
    color: var(--ink2);
    background: var(--paper);
    cursor: pointer;
  }
  .pv .p .d {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--done);
  }
  .pv .p .d.no {
    background: var(--line2);
  }
  .pv .p.on {
    border-color: var(--accent);
    color: var(--ink);
    background: var(--accent-soft);
  }
  .pv .p.dis {
    opacity: 0.5;
    cursor: default;
  }
  .pv .p:disabled:not(.dis) {
    cursor: default;
  }
  .pv .p:hover:not(:disabled) {
    border-color: var(--dim);
  }
  /* The key cap inside a pill: smaller than the list's, no bottom lip. */
  .pv .p :global(.kbd) {
    height: 15px;
    min-width: 15px;
    padding: 0 3px;
    font-size: 9.5px;
    border-bottom-width: 1px;
    margin-left: 1px;
  }
  .more.bare {
    padding: 0 2px;
    border-top: none;
    display: flex;
    justify-content: flex-end;
    font-size: 11px;
    color: var(--dim);
  }

  /* The model list: radio rows. */
  .ml {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--paper);
    overflow: hidden;
  }
  .mfilter {
    border: none !important;
    border-bottom: 1px solid var(--line) !important;
    border-radius: 0 !important;
    background: transparent !important;
  }
  .ml .r {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: none;
    border-top: 1px solid var(--line);
    background: transparent;
    color: var(--ink2);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
    width: 100%;
  }
  .ml .r:first-child {
    border-top: none;
  }
  .ml .r:hover:not(:disabled) {
    color: var(--ink);
  }
  .ml .r:disabled {
    cursor: default;
  }
  .ml .r .rad {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1.5px solid var(--line2);
    flex: none;
    position: relative;
  }
  .ml .r.on {
    background: var(--accent-soft);
    color: var(--ink);
  }
  .ml .r.on .rad {
    border-color: var(--accent);
  }
  .ml .r.on .rad::after {
    content: "";
    position: absolute;
    inset: 2px;
    border-radius: 50%;
    background: var(--accent);
  }
  .ml .r .id {
    font-family: var(--mono);
    font-size: 11.5px;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ml .r .cx {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--dim);
    min-width: 30px;
    text-align: right;
  }
  .ml .more {
    padding: 6px 10px;
    font-size: 11px;
    color: var(--dim);
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: flex-end;
  }
  /* The instructions row under the list: the id the pencil opens a file for. */
  .mi .mi-id {
    flex: 1;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mi .mi-id.dim {
    font-family: inherit;
    color: var(--dim);
  }

  /* Thinking as a segmented control. */
  .segs {
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line2);
    border-radius: 8px;
    background: var(--paper);
  }
  .segs button {
    flex: 1;
    padding: 4px 4px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .segs button:hover:not(:disabled) {
    color: var(--ink);
  }
  .segs button.on {
    background: var(--accent);
    color: var(--paper);
    font-weight: 500;
  }
  .segs button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  /* The approval segment (backlogs 084, 085): Off reads as the warning
     it is when it is the position chosen. */
  .segs button.on.off {
    background: var(--error);
  }
  .approval {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .approval .swq {
    cursor: default;
  }
  /* A labelled control under Behaviour (the design's Rail board): the
     label row with its `?`, the segment or pills, the line under it. */
  .ctl {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ctl .swq {
    cursor: default;
  }
  /* The Effort segment's *default* position names the model's own value
     (board 3b revised, 2026-09-16): wider than the levels, the value dim
     beside the word, italic and fainter while it is unknown. */
  .segs button.d {
    flex: 1.6;
  }
  .segs .dv {
    font-size: 10.5px;
    opacity: 0.75;
  }
  .segs .dv.unk {
    font-style: italic;
    opacity: 0.6;
  }

  /* Switch rows: the label, its `?`, the pill. */
  .swq {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    cursor: pointer;
  }
  .swq .t {
    font-size: 12.5px;
    color: var(--ink);
    flex: 1;
  }
  .swq.sub,
  .sub-note {
    margin-left: 2px;
    padding-left: 12px;
    border-left: 2px solid var(--line);
  }
  .sw {
    appearance: none;
    -webkit-appearance: none;
    margin: 0;
    width: 26px;
    height: 15px;
    flex-shrink: 0;
    border-radius: 999px;
    background: var(--line2);
    position: relative;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .sw::after {
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
  .sw:checked {
    background: var(--accent);
  }
  .sw:checked::after {
    transform: translateX(11px);
    background: var(--accent);
    box-shadow: inset 0 0 0 2px var(--paper);
  }
  .sw:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .warn {
    margin: 0;
    font-size: 11px;
    line-height: 1.35;
    color: var(--error);
    opacity: 0.85;
  }
  .warn code {
    font-family: var(--mono);
    font-size: 10.5px;
  }
  /* A statement of fact about the connection, where .warn is a caution. */
  .note {
    margin: 0;
    font-size: 11px;
    line-height: 1.35;
    color: var(--dim);
  }
  .note .ok {
    color: var(--done);
  }
  /* `anywhere` rather than `break-word`: a Windows path has no space and no
     hyphen to break at, so without it the longest run sets the rail's width
     and the whole column grows a horizontal scrollbar. */
  .note code {
    font-family: var(--mono);
    font-size: 10.5px;
    overflow-wrap: anywhere;
  }

  .icon {
    background: transparent;
    border: 1px solid var(--line2);
    border-radius: 6px;
    color: var(--dim);
    padding: 6px 8px;
    cursor: pointer;
    flex-shrink: 0;
    display: inline-flex;
  }
  .icon:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .reach-row {
    align-items: flex-start;
  }
  .reach-row .lbl {
    padding-top: 2px;
  }
  .none {
    font-size: 11px;
    color: var(--dim);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-size: 11px;
    color: var(--ink2);
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 1px 8px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip b {
    font-weight: 600;
    color: var(--ink);
    font-family: var(--mono);
    font-size: 10.5px;
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
  }
  .spacer {
    flex: 1;
    min-height: 0.25rem;
  }
  .manage {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 6px;
    border: 1px solid var(--line2);
    background: var(--sheet);
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    flex: none;
  }
  .manage:hover {
    border-color: var(--dim);
  }
</style>
