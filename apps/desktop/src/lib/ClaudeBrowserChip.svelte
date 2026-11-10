<script lang="ts">
  /**
   * The chat's offer of Claude's browser (nightshift item 508): above the
   * composer beside the preview chip (item 430), from the first time the
   * chat's browser reports live. It offers — Open (or Show, when the tab is
   * already open) brings the tab up beside the chat on his click; nothing
   * opens by itself. It says where the page is and who holds it; once the
   * browser has closed it says so and offers only Dismiss.
   */
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { browserTabOpen, browsers, chipShown, dismissChip, openBrowserTab, phase, readStatus, startBrowsers } from "./claudeBrowser.svelte";

  let { chat }: { chat: string } = $props();

  $effect(() => {
    void startBrowsers();
    void readStatus(chat);
  });

  const shown = $derived(chipShown(chat));
  const ph = $derived(phase(chat));
  const status = $derived(browsers.byChat[chat] ?? null);
  // Read the workspace so Open / Show follows the tab being opened or closed.
  const open = $derived.by(() => {
    void app.tabs;
    return browserTabOpen(chat);
  });
  const host = $derived.by(() => {
    try {
      return status?.url ? new URL(status.url).host || status.url : "";
    } catch {
      return status?.url ?? "";
    }
  });
</script>

{#if shown}
  <div class="cb-chip" data-phase={ph} role="status" aria-label="Claude's browser">
    <span class="dot" aria-hidden="true"></span>
    {#if ph === "live"}
      <span class="ns-chip mono label">Claude's browser · {status?.held_by === "user" ? "you have it" : "Claude has it"}</span>
      <span class="where mono" use:tip={status?.title ? `${status.title}\n${status.url}` : (status?.url ?? "")}>{host || "blank page"}</span>
      <span class="acts">
        <button class="ns-btn ghost small" use:tip={"Watch it live in a tab beside this chat, and click or type in it yourself"} onclick={() => void openBrowserTab(chat)}
          >{open ? "Show" : "Open"}</button
        >
        <button class="ns-btn ghost small" use:tip={"Hide this offer; the browser keeps running"} onclick={() => dismissChip(chat)}>Dismiss</button>
      </span>
    {:else}
      <span class="ns-chip mono label">Claude's browser closed</span>
      <span class="where mono">its pages and logins went with it; Claude starts a new one when it next uses the browser</span>
      <span class="acts">
        <button class="ns-btn ghost small" onclick={() => dismissChip(chat)}>Dismiss</button>
      </span>
    {/if}
  </div>
{/if}

<style>
  .cb-chip {
    max-width: 760px;
    margin: 0 auto 0.5rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line2);
    border-radius: 8px;
    font-size: 13px;
    color: var(--ink);
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
  }
  [data-phase="live"] .dot {
    background: var(--done);
  }
  [data-phase="ended"] .dot {
    background: var(--failed);
  }
  .label {
    flex: none;
  }
  .where {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--dim);
    font-size: 12px;
  }
  .acts {
    display: flex;
    gap: 4px;
    flex: none;
  }
</style>
