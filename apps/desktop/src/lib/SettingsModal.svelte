<script lang="ts">
  import { app, setPrefs } from "./state.svelte";
  import { CURATED } from "./catalog";

  let drafts = $state<Record<string, string>>({});

  function providerVisible(kind: string): boolean {
    return !app.prefs.hiddenProviders.includes(kind);
  }
  function toggleProvider(kind: string) {
    setPrefs((p) => {
      const i = p.hiddenProviders.indexOf(kind);
      if (i >= 0) p.hiddenProviders.splice(i, 1);
      else p.hiddenProviders.push(kind);
    });
  }
  function modelVisible(kind: string, model: string): boolean {
    return !(app.prefs.hiddenModels[kind] ?? []).includes(model);
  }
  function toggleModel(kind: string, model: string) {
    setPrefs((p) => {
      const hidden = (p.hiddenModels[kind] ??= []);
      const i = hidden.indexOf(model);
      if (i >= 0) hidden.splice(i, 1);
      else hidden.push(model);
    });
  }
  function addCustom(kind: string) {
    const model = (drafts[kind] ?? "").trim();
    if (!model) return;
    setPrefs((p) => {
      const custom = (p.customModels[kind] ??= []);
      if (!custom.includes(model) && !(CURATED[kind] ?? []).includes(model)) {
        custom.push(model);
      }
    });
    drafts[kind] = "";
  }
  function removeCustom(kind: string, model: string) {
    setPrefs((p) => {
      const custom = p.customModels[kind] ?? [];
      const i = custom.indexOf(model);
      if (i >= 0) custom.splice(i, 1);
    });
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Escape") app.showSettings = false;
  }
</script>

<svelte:window {onkeydown} />

<div class="modal">
  <div class="head">
    <span class="title">Providers &amp; models</span>
    <button
      class="close"
      aria-label="Close settings"
      onclick={() => (app.showSettings = false)}
    >
      ✕
    </button>
  </div>
  <div class="hint">
    Choose what the connection dropdowns offer. Unchecked entries are hidden,
    not deleted.
  </div>

  <div class="body">
    {#each app.providers as p (p.kind)}
      <section class="provider">
        <label class="row provider-row">
          <input
            type="checkbox"
            checked={providerVisible(p.kind)}
            onchange={() => toggleProvider(p.kind)}
          />
          <span class="name">{p.kind}</span>
          {#if !p.available}
            <span class="tag">no API key</span>
          {/if}
        </label>
        {#if providerVisible(p.kind)}
          <div class="models">
            {#each CURATED[p.kind] ?? [] as m (m)}
              <label class="row">
                <input
                  type="checkbox"
                  checked={modelVisible(p.kind, m)}
                  onchange={() => toggleModel(p.kind, m)}
                />
                <span class="model">{m}</span>
              </label>
            {/each}
            {#each app.prefs.customModels[p.kind] ?? [] as m (m)}
              <div class="row custom">
                <span class="model">{m}</span>
                <button
                  class="remove"
                  aria-label={`Remove ${m}`}
                  onclick={() => removeCustom(p.kind, m)}
                >
                  ✕
                </button>
              </div>
            {/each}
            <form
              class="add"
              onsubmit={(e) => {
                e.preventDefault();
                addCustom(p.kind);
              }}
            >
              <input
                type="text"
                bind:value={drafts[p.kind]}
                placeholder="add model id…"
              />
              <button type="submit" disabled={!(drafts[p.kind] ?? "").trim()}>
                add
              </button>
            </form>
          </div>
        {/if}
      </section>
    {/each}
  </div>
</div>

<style>
  .modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 26rem;
    max-width: calc(100vw - 320px);
    max-height: calc(100vh - 7rem);
    display: flex;
    flex-direction: column;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.9rem 1.1rem 0;
  }
  .title {
    font-size: 0.95rem;
  }
  .close {
    background: transparent;
    border: none;
    color: var(--dim);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.2rem 0.4rem;
    border-radius: 6px;
  }
  .close:hover {
    color: var(--text);
    background: #1b1830;
  }
  .hint {
    color: var(--dim);
    font-size: 0.75rem;
    padding: 0.25rem 1.1rem 0.6rem;
  }
  .body {
    overflow-y: auto;
    padding: 0 1.1rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
  }
  .provider {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.55rem 0.7rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.82rem;
    padding: 0.12rem 0;
    cursor: pointer;
  }
  .row input[type="checkbox"] {
    accent-color: var(--accent);
    flex-shrink: 0;
  }
  .provider-row .name {
    font-weight: 600;
  }
  .tag {
    color: var(--dim);
    font-size: 0.7rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 0.45rem;
  }
  .models {
    margin: 0.35rem 0 0 1.35rem;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .model {
    font-family: var(--mono);
    font-size: 0.76rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .custom {
    cursor: default;
    justify-content: space-between;
  }
  .remove {
    background: transparent;
    border: none;
    color: var(--dim);
    cursor: pointer;
    font-size: 0.7rem;
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
  }
  .remove:hover {
    color: var(--error);
  }
  .add {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }
  .add input {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
    font-size: 0.76rem;
    font-family: var(--mono);
  }
  .add input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .add button {
    background: transparent;
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .add button:hover:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .add button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
