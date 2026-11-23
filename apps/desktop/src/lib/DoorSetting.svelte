<script lang="ts">
  // Item 767: Settings → Outside control. One switch — read only (the
  // default) or start and message — and the two lines he pastes to use it.
  import CopyButton from "./CopyButton.svelte";
  import { doorExample, doorMcpConfig } from "./door";
  import { door, loadDoorCard, setDoorWrites } from "./door.svelte";
  import { COPIED_MS } from "./copyIcon";

  let copied = $state<"cli" | "mcp" | null>(null);
  async function copy(which: "cli" | "mcp", text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = which;
      setTimeout(() => (copied = copied === which ? null : copied), COPIED_MS);
    } catch {
      // The text is selectable beside the button.
    }
  }

  $effect(() => {
    void loadDoorCard();
  });
</script>

<label class="dream-auto" data-door-switch>
  <input type="checkbox" checked={door.card?.writes ?? false} disabled={!door.card} onchange={(e) => void setDoorWrites(e.currentTarget.checked)} />
  <span>Let them start chats and send messages</span>
</label>
<p class="note small">
  {#if door.card?.writes}
    On: a script or another agent on this Mac can start a chat in any project and message any chat that is not
    incognito. Each runs on your Claude plan. Switch it off and the next try is refused.
  {:else}
    Off: they can list and read chats, nothing more. A try to start or message one is refused and told to ask you.
  {/if}
</p>
{#if door.card && !door.card.socket}
  <p class="note small door-warn">This window is not listening (a development build on your real home does not). The switch is still kept.</p>
{/if}
{#if door.problem}<p class="note small door-warn">{door.problem}</p>{/if}
{#if door.card}
  <div class="door-line">
    <span class="door-what">From a terminal</span>
    <code>{doorExample(door.card)}</code>
    <CopyButton copied={copied === "cli"} label="Copy the command" onclick={() => void copy("cli", doorExample(door.card!))} />
  </div>
  <div class="door-line">
    <span class="door-what">For another agent (MCP)</span>
    <code class="door-json">{doorMcpConfig(door.card, "Claude desktop")}</code>
    <CopyButton copied={copied === "mcp"} label="Copy the MCP entry" onclick={() => void copy("mcp", doorMcpConfig(door.card!, "Claude desktop"))} />
  </div>
{/if}

<style>
  .door-warn {
    color: var(--danger, #e0755f);
  }
  .door-line {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
    align-items: start;
    margin-top: 10px;
  }
  .door-what {
    grid-column: 1 / -1;
    font-size: 12px;
    opacity: 0.7;
  }
  .door-line code {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 12px;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .door-json {
    white-space: pre-wrap;
  }
</style>
