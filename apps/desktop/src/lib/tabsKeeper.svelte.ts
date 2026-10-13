/**
 * The tab workspace's keeper (nightshift backlog 201): watches the panes,
 * their tabs and the terminal docks' shells, and writes the workspace to
 * localStorage under its project, debounced — the way
 * `asides.svelte.ts` writes the aside threads — and at once on
 * `pagehide`. `tabsStore.ts` is the pure part; `state.svelte.ts` holds
 * the owner and does the write (`flushTabs`) and the read-back
 * (`restoreTabs`). Imported for its effect, from `App.svelte`.
 */
import { untrack } from "svelte";
import { app, flushTabs } from "./state.svelte";
import { term } from "./terminal.svelte";

const SAVE_DELAY_MS = 250;
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  flushTabs();
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY_MS);
}

if (typeof window !== "undefined") {
  $effect.root(() => {
    $effect(() => {
      // Read what a save depends on: every pane, its tabs' contents in
      // order, its front tab, the focus, and which dock each shell is in.
      const ws = app.tabs;
      void ws.focused;
      for (const p of ws.panes) {
        void p.active;
        for (const t of p.tabs) void JSON.stringify(t.content);
      }
      for (const s of term.shells) void s.pane;
      untrack(schedule);
    });
  });
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}
