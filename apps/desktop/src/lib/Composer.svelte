<script lang="ts">
  import { app, send, cancelTurn } from "./state.svelte";

  let text = $state("");
  let ta = $state<HTMLTextAreaElement | null>(null);

  const MAX_HEIGHT = 200; // ~8 rows

  function autogrow() {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, MAX_HEIGHT) + "px";
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const t = text.trim();
    if (!t || !app.connection || app.busy) return;
    text = "";
    requestAnimationFrame(autogrow);
    void send(t);
  }
</script>

<div class="composer">
  <div class="row">
    <textarea
      bind:this={ta}
      bind:value={text}
      rows="1"
      placeholder={app.connection ? "Message…" : ""}
      disabled={!app.connection}
      oninput={autogrow}
      {onkeydown}
    ></textarea>
    {#if app.busy}
      <button class="action stop" onclick={() => void cancelTurn()}>
        Stop
      </button>
    {:else}
      <button
        class="action"
        onclick={submit}
        disabled={!app.connection || !text.trim()}
      >
        Send
      </button>
    {/if}
  </div>
  {#if !app.connection}
    <div class="hint">connect a provider to start</div>
  {/if}
</div>

<style>
  .composer {
    background: var(--panel);
    border-top: 1px solid var(--border);
    padding: 0.75rem 1rem;
  }
  .row {
    max-width: 46rem;
    margin: 0 auto;
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
  }
  textarea {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.55rem 0.75rem;
    font-size: 0.92rem;
    font-family: inherit;
    line-height: 1.45;
    resize: none;
    max-height: 200px;
    overflow-y: auto;
  }
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  textarea:disabled {
    opacity: 0.5;
  }
  .action {
    background: var(--accent);
    color: #0d0d14;
    border: none;
    border-radius: 10px;
    padding: 0.55rem 1rem;
    font-size: 0.88rem;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  }
  .action:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .action:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .action.stop {
    background: transparent;
    color: var(--error);
    border: 1px solid rgba(246, 109, 124, 0.4);
  }
  .hint {
    max-width: 46rem;
    margin: 0.4rem auto 0;
    color: var(--dim);
    font-size: 0.75rem;
  }
</style>
