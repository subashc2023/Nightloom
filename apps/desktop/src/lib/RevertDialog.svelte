<script lang="ts">
  /**
   * Revert, confirmed first. The dialog sits over the preview the backend
   * computed — target, head, commits, stat, dirty check — and the
   * destructive button stays disabled until the checkbox is ticked. Nothing
   * runs until then; a dirty tree disables it outright, as the backend
   * would refuse anyway.
   */
  import type { RevertPreview } from "./types";
  import { revertShift } from "./state.svelte";
  import { short } from "./nightshift";
  import Icon from "./Icon.svelte";

  let {
    shiftId,
    preview,
    onclose,
  }: { shiftId: string; preview: RevertPreview; onclose: () => void } = $props();

  let agreed = $state(false);
  let busy = $state(false);

  /** `8 changed, 935 insertions(+), 3 deletions(−)` — git's own last line. */
  const summary = $derived.by(() => {
    const lines = preview.stat.trim().split("\n");
    return lines[lines.length - 1]?.trim() ?? "";
  });
  const stat = $derived.by(() => {
    const lines = preview.stat.trim().split("\n");
    return lines.slice(0, -1).join("\n");
  });

  async function go() {
    busy = true;
    const done = await revertShift(shiftId);
    busy = false;
    if (done) onclose();
  }

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={key} />

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="ns-card dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="revert-title"
    tabindex="-1"
  >
    <div class="head">
      <span class="warn"><Icon name="revert" size={20} /></span>
      <h2 id="revert-title">Revert shift {shiftId}?</h2>
    </div>
    <p class="lead">
      This runs <span class="ns-mono">git reset --hard {short(preview.target)}</span>
      in the contract root. Nothing is done automatically; it happens only when
      you confirm below.
    </p>
    <div class="facts">
      <span class="ns-k">discards</span>
      <span>
        <strong>{preview.commits} commit{preview.commits === 1 ? "" : "s"}</strong>
        · {short(preview.target)} → {short(preview.head)}
      </span>
      <span class="ns-k">files</span>
      <span class="ns-mono small">{summary || "nothing"}</span>
      <span class="ns-k">tree</span>
      {#if preview.dirty}
        <span class="ns-pill failed self"><span class="dot"></span>dirty — the revert is refused until it is clean</span>
      {:else}
        <span class="ns-pill done self"><span class="dot"></span>clean — a dirty tree would refuse</span>
      {/if}
    </div>
    {#if stat}
      <pre class="stat">{stat}</pre>
    {/if}
    <label class="agree">
      <input type="checkbox" bind:checked={agreed} disabled={preview.dirty} />
      I have read the list above and want these commits gone from
      <span class="ns-mono">HEAD</span>.
    </label>
    <div class="actions">
      <button class="ns-btn" onclick={onclose} disabled={busy}>Cancel</button>
      <button
        class="ns-btn danger"
        disabled={!agreed || preview.dirty || busy}
        onclick={() => void go()}
      >
        {busy ? "Resetting…" : `Reset to ${short(preview.target)}`}
      </button>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 25;
  }
  .dialog {
    width: 560px;
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
    padding: 22px 24px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    border-color: var(--line2);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .warn {
    color: var(--failed);
    display: inline-flex;
  }
  h2 {
    font-family: var(--serif);
    font-size: 22px;
    font-weight: 500;
    margin: 0;
  }
  .lead {
    margin: 0;
    color: var(--ink2);
    font-size: 14px;
  }
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 16px;
    font-size: 13px;
    align-items: center;
  }
  .small {
    font-size: 12px;
  }
  .self {
    justify-self: start;
  }
  .stat {
    margin: 0;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px 12px;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--dim);
    max-height: 200px;
    overflow: auto;
  }
  .agree {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
  }
  .agree input {
    accent-color: var(--accent);
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  /* Filament IV stage 6 (item 570): the dialog is a card in front with a
     ruled head — the title in the light sans, not the serif — the facts'
     keys as mono capitals, Cancel and the action on the right. Behind
     `:where(:root:not([data-layout="classic"]))`; Classic's rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .dialog {
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65);
    padding: 20px 22px 18px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .head {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) h2 {
    font-family: var(--sans);
    font-weight: 400;
    font-size: 19px;
    letter-spacing: -0.005em;
  }
  :global(:where(:root:not([data-layout="classic"]))) .facts .ns-k {
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink2);
    padding-top: 4px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .actions {
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  :global(:where(:root:not([data-layout="classic"]))) .stat {
    background: var(--term);
    border-radius: var(--r1);
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .dialog {
      animation: dialog-rise 90ms ease-out;
    }
  }
  @keyframes dialog-rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
</style>
