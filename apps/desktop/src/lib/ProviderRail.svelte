<script lang="ts">
  import { app, applyDraft, usable } from "./state.svelte";
  import {
    isProviderVisible,
    modelsFor,
    providerLabel,
    sanitizeThinking,
    thinkingSupport,
  } from "./catalog";

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
</script>

<aside class="rail">
  <div class="status">
    {#if app.connecting}
      <span class="dot pending"></span><span>connecting…</span>
    {:else if app.connection}
      <span class="dot ok"></span>
      <span class="conn">{app.connection.provider} · {app.connection.model}</span>
    {:else}
      <span class="dot off"></span><span class="dim">not connected</span>
    {/if}
  </div>

  <label class="field">
    <span>Provider</span>
    <select bind:value={app.draft.provider} onchange={onProviderChange} disabled={locked}>
      {#each providers as p (p.kind)}
        <option value={p.kind} disabled={!usable(p)}>
          {providerLabel(p.kind)}{usable(p) ? "" : " — no API key"}
        </option>
      {/each}
    </select>
  </label>

  <label class="field">
    <span>Model</span>
    {#if models.length > 0}
      <select bind:value={app.draft.model} onchange={onModelChange} disabled={locked}>
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
  </label>

  {#if app.draft.provider === "openai-chat"}
    <label class="field">
      <span>Base URL</span>
      <input
        type="text"
        bind:value={app.draft.baseUrl}
        onchange={apply}
        placeholder="http://localhost:11434/v1"
        disabled={locked}
      />
    </label>
  {/if}

  <label class="field">
    <span>Thinking</span>
    <select bind:value={app.draft.thinkingMode} onchange={apply} disabled={locked}>
      {#each thinking.choices as c (c.value)}
        <option value={c.value}>{c.label}</option>
      {/each}
    </select>
    <p class="hint">{thinking.note}</p>
  </label>
  {#if app.draft.thinkingMode === "budget"}
    <label class="field">
      <span>Budget tokens</span>
      <input
        type="number"
        bind:value={app.draft.budget}
        onchange={apply}
        min="1"
        step="1024"
        disabled={locked}
      />
    </label>
  {/if}

  <label class="check">
    <input type="checkbox" bind:checked={app.draft.tools} onchange={apply} disabled={locked} />
    <span>built-in tools</span>
  </label>

  <label class="field">
    <span>System prompt</span>
    <textarea
      rows="3"
      bind:value={app.draft.system}
      onchange={apply}
      placeholder="optional"
      disabled={locked}
    ></textarea>
  </label>

  {#if app.connectError}
    <div class="error">{app.connectError}</div>
  {/if}

  <div class="spacer"></div>
  <button class="manage" onclick={() => (app.showSettings = true)}>
    Providers &amp; models…
  </button>
</aside>

<style>
  .rail {
    background: var(--panel);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    padding: 0.75rem;
    overflow-y: auto;
    min-height: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.78rem;
    min-height: 1.2rem;
  }
  .conn {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dim {
    color: var(--dim);
  }
  .dot {
    width: 8px;
    height: 8px;
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
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .field > span {
    font-size: 0.72rem;
    color: var(--dim);
  }
  .hint {
    margin: 0;
    font-size: 0.68rem;
    line-height: 1.35;
    color: var(--dim);
  }
  select,
  input[type="text"],
  input[type="number"],
  textarea {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.55rem;
    font-size: 0.8rem;
    font-family: inherit;
    width: 100%;
  }
  textarea {
    resize: vertical;
  }
  select:focus,
  input:focus,
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  select:disabled,
  input:disabled,
  textarea:disabled {
    opacity: 0.55;
  }
  option:disabled {
    color: var(--dim);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .check input {
    accent-color: var(--accent);
  }
  .error {
    color: var(--error);
    background: rgba(246, 109, 124, 0.08);
    border: 1px solid rgba(246, 109, 124, 0.3);
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    font-size: 0.75rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .spacer {
    flex: 1;
  }
  .manage {
    background: transparent;
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    font-size: 0.78rem;
    cursor: pointer;
    text-align: left;
  }
  .manage:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
