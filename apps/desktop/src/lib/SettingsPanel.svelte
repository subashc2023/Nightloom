<script lang="ts">
  import { app, connect } from "./state.svelte";

  let provider = $state("anthropic");
  let model = $state("");
  let baseUrl = $state("");
  let thinkingMode = $state("default");
  let budget = $state(8192);
  let system = $state("");
  let tools = $state(false);
  let error = $state<string | null>(null);
  let connecting = $state(false);

  const selected = $derived(app.providers.find((p) => p.kind === provider));
  const modelPlaceholder = $derived(selected?.default_model ?? "model id");

  function optionDisabled(p: { kind: string; available: boolean }): boolean {
    if (p.available) return false;
    // openai-chat can point at a local server without an API key.
    return !(p.kind === "openai-chat" && baseUrl.trim() !== "");
  }

  function thinkingString(): string {
    if (thinkingMode === "budget") return `budget=${Math.max(1, Math.floor(budget))}`;
    if (thinkingMode.startsWith("effort-")) return `effort=${thinkingMode.slice(7)}`;
    return "default";
  }

  async function doConnect() {
    if (connecting) return;
    connecting = true;
    error = null;
    try {
      await connect({
        provider,
        model: model.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        thinking: thinkingString(),
        system: system.trim() || undefined,
        tools,
      });
    } catch (e) {
      error = String(e);
    } finally {
      connecting = false;
    }
  }
</script>

<div class="panel">
  <div class="panel-title">Connect a provider</div>

  <label class="field">
    <span>Provider</span>
    <select bind:value={provider}>
      {#each app.providers as p (p.kind)}
        <option value={p.kind} disabled={optionDisabled(p)}>
          {p.kind}{optionDisabled(p) ? " — no API key" : ""}
        </option>
      {/each}
      {#if app.providers.length === 0}
        <option value="anthropic">anthropic</option>
      {/if}
    </select>
  </label>

  <label class="field">
    <span>Model</span>
    <input type="text" bind:value={model} placeholder={modelPlaceholder} />
  </label>

  <label class="field">
    <span>Base URL</span>
    <input type="text" bind:value={baseUrl} placeholder="default endpoint" />
  </label>

  <div class="field-row">
    <label class="field">
      <span>Thinking</span>
      <select bind:value={thinkingMode}>
        <option value="default">default</option>
        <option value="effort-low">effort: low</option>
        <option value="effort-medium">effort: medium</option>
        <option value="effort-high">effort: high</option>
        <option value="budget">budget…</option>
      </select>
    </label>
    {#if thinkingMode === "budget"}
      <label class="field budget">
        <span>Budget tokens</span>
        <input type="number" bind:value={budget} min="1" step="1024" />
      </label>
    {/if}
  </div>

  <label class="field">
    <span>System prompt <em>(optional)</em></span>
    <textarea rows="3" bind:value={system} placeholder=""></textarea>
  </label>

  <label class="check">
    <input type="checkbox" bind:checked={tools} />
    <span>enable built-in tools</span>
  </label>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <button class="connect" onclick={doConnect} disabled={connecting}>
    {connecting ? "Connecting…" : "Connect"}
  </button>
</div>

<style>
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.1rem 1.2rem;
    width: 24rem;
    max-width: calc(100vw - 300px);
    max-height: calc(100vh - 8rem);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .panel-title {
    font-size: 0.95rem;
    color: var(--text);
    margin-bottom: 0.15rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex: 1;
  }
  .field > span {
    font-size: 0.75rem;
    color: var(--dim);
  }
  .field em {
    font-style: normal;
    opacity: 0.7;
  }
  .field-row {
    display: flex;
    gap: 0.75rem;
  }
  .field-row .budget {
    max-width: 9rem;
  }
  select,
  input[type="text"],
  input[type="number"],
  textarea {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.45rem 0.6rem;
    font-size: 0.85rem;
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
  option:disabled {
    color: var(--dim);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
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
    padding: 0.5rem 0.7rem;
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .connect {
    background: var(--accent);
    color: #0d0d14;
    border: none;
    border-radius: 8px;
    padding: 0.55rem 0.75rem;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .connect:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .connect:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
