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
  <!-- Item 525 (Filament IV): a card in front, like the composer under it —
       the live dot, the name, who holds it in the signal colour while Claude
       does, where the page is, and real buttons. -->
  <div class="cb-chip" data-phase={ph} data-held={status?.held_by ?? "model"} role="status" aria-label="Claude's browser">
    <span class="dot" aria-hidden="true"></span>
    {#if ph === "live"}
      <span class="label"><b>Claude's browser</b> <span class="held">{status?.held_by === "user" ? "You have it" : "Claude has it"}</span></span>
      <span class="where mono" use:tip={status?.title ? `${status.title}\n${status.url}` : (status?.url ?? "")}>{host || "blank page"}</span>
      <span class="acts">
        <button class="ns-btn small" use:tip={"Watch it live in a tab beside this chat, and click or type in it yourself"} onclick={() => void openBrowserTab(chat)}
          >{open ? "Show" : "Open"}</button
        >
        <button class="ns-btn small" use:tip={"Hide this offer; the browser keeps running"} onclick={() => dismissChip(chat)}>Dismiss</button>
      </span>
    {:else}
      <span class="label"><b>Claude's browser closed</b></span>
      <span class="where">its pages and logins went with it; Claude starts a new one when it next uses the browser</span>
      <span class="acts">
        <button class="ns-btn small" onclick={() => dismissChip(chat)}>Dismiss</button>
      </span>
    {/if}
  </div>
{/if}

<style>
  .cb-chip {
    max-width: 760px;
    margin: 0 auto 8px;
    padding: 6px 8px 6px 12px;
    background: var(--raised);
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    font-size: 12.5px;
    color: var(--ink2);
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--dim);
  }
  /* Live is the signal colour, with the lit level's halo; his turn at the
     page is his colour. Still: a browser stays up between turns, and
     nothing moves while the app is idle. */
  [data-phase="live"] .dot {
    background: var(--signal);
    box-shadow: var(--glow-live);
  }
  [data-phase="live"][data-held="user"] .dot {
    background: var(--accent);
    box-shadow: none;
  }
  [data-phase="ended"] .dot {
    background: var(--failed);
  }
  .label {
    flex: none;
    white-space: nowrap;
  }
  .label b {
    font-weight: 600;
    color: var(--ink);
  }
  .held {
    margin-left: 6px;
    color: var(--signal);
  }
  [data-held="user"] .held {
    color: var(--accent);
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
  .where.mono {
    font-family: var(--mono);
    font-size: 11px;
  }
  .acts {
    display: flex;
    gap: 6px;
    flex: none;
  }
</style>
