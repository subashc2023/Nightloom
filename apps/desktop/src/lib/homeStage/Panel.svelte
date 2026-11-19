<script lang="ts">
  // A stage panel: the app's control grammar (a fill, an edge, a shape), its ruled mono heading (`ns-cap`), and — when
  // `lock` — the app's lock-on brackets and scanline (AskLock, the "Claude asks you" card's arrival).
  import type { Snippet } from "svelte";
  import AskLock from "../AskLock.svelte";
  // Round 6: `keep` — the panel keeps its full height in its column; the panel under it gives up the room instead.
  let { title, sub = "", live = false, lock = false, flush = false, keep = false, children, tools }: { title: string; sub?: string; live?: boolean; lock?: boolean; flush?: boolean; keep?: boolean; children: Snippet; tools?: Snippet } = $props();
</script>

<section class="h9-panel" class:keep class:live class:lk-shell={lock} class:lockon={lock}>
  {#if lock}<AskLock header=".h9-ph-tx" />{/if}
  <header class="h9-ph">
    {#if live}<i class="h9-dot" aria-hidden="true"></i>{/if}
    <span class="ns-cap h9-ph-t"><span class="h9-ph-tx">{title}</span></span>
    {#if sub}<span class="h9-ph-sub">{sub}</span>{/if}
    {#if tools}<span class="h9-ph-tools">{@render tools()}</span>{/if}
  </header>
  <div class="h9-pb" class:flush>{@render children()}</div>
</section>
