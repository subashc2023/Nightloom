<script lang="ts">
  /**
   * The chat's ⋯ sheet rows (item 300, F4: A10, A12). The Claude iOS app's
   * ⋯ menu is short — Rename, Star, Add to project, Delete — and always on
   * screen (`inferred`, his reference app); so the common rows come first
   * and few, the rest wait under "More", and a row this host cannot do is
   * left out instead of greyed. Stop and Delete sit last, in their own group,
   * where the sheet's own scroll always reaches them.
   */
  import type { Snippet } from "svelte";

  type Icon = "new" | "mac" | "pencil" | "sliders" | "play" | "swap" | "pulse" | "aside" | "council" | "compact" | "stop" | "trash" | "chev";

  interface Props {
    icon: Snippet<[Icon]>;
    readOnly: boolean;
    canAct: boolean;
    busyHere: boolean;
    /** Why the log cannot change now (a turn runs, the host is away). */
    blocked: string | null;
    /** The project New chat starts in, named when the chat is read-only. */
    newLabel: string;
    /** "Open on the Mac" is shown (the host is the Mac). */
    macRow: boolean;
    macDisabled: boolean;
    aside: boolean;
    asideTag: string | null;
    council: boolean;
    kind: string | undefined;
    compact: boolean;
    context: boolean;
    onrail: () => void;
    onrename: () => void;
    onmac: () => void;
    onnew: () => void;
    onaside: () => void;
    oncouncil: () => void;
    oncontinue: () => void;
    onkind: () => void;
    oncompact: () => void;
    oncontext: () => void;
    onstop: () => void;
    ondelete: () => void;
  }
  let p: Props = $props();

  let more = $state(false);
  const build = $derived(p.kind === "build");
  const hasMore = $derived(
    (!p.readOnly && (p.macRow || p.aside || p.council || p.context)) || (!p.readOnly && p.canAct),
  );
</script>

<div class="cm">
  <div class="cm-menu">
    {#if !p.readOnly}
      <button onclick={p.onrename}>{@render p.icon("pencil")} Rename</button>
    {/if}
    <button data-act="rail" onclick={p.onrail}>{@render p.icon("sliders")} Model and settings</button>
    <button onclick={p.onnew}>{@render p.icon("new")} {p.newLabel}</button>
    {#if hasMore}
      <button class="cm-more" aria-expanded={more} onclick={() => (more = !more)}>
        <span class="cm-dots" aria-hidden="true">…</span>
        <span class="cm-grow">{more ? "Fewer" : "More"}</span>
        <span class="cm-chev" class:open={more}>{@render p.icon("chev")}</span>
      </button>
    {/if}
  </div>

  {#if more}
    <div class="cm-menu">
      {#if !p.readOnly && p.aside}
        <button onclick={p.onaside}>
          {@render p.icon("aside")}
          <span class="cm-grow">Ask aside<small>A side question that stays out of this chat</small></span>
          {#if p.asideTag}<span class="cm-tag">{p.asideTag}</span>{/if}
        </button>
      {/if}
      {#if !p.readOnly && p.council}
        <button onclick={p.oncouncil}>{@render p.icon("council")} <span class="cm-grow">Ask the council<small>Several models answer the same question</small></span></button>
      {/if}
      {#if !p.readOnly && p.canAct}
        <button onclick={p.oncontinue} disabled={!!p.blocked}>
          {@render p.icon("play")}
          <span class="cm-grow">Continue<small>Have the model carry on where its last reply stopped</small></span>
        </button>
        <button onclick={p.onkind} disabled={!!p.blocked}>
          {@render p.icon("swap")}
          <span class="cm-grow">
            {build ? "Make it a plain chat" : "Make it a build chat"}
            <small>{build ? "This chat can edit files and run commands; a plain chat only talks" : "This chat only talks; a build chat can edit files and run commands"}</small>
          </span>
        </button>
        {#if p.compact}
          <button data-act="compact" onclick={p.oncompact} disabled={!!p.blocked}>
            {@render p.icon("compact")}
            <span class="cm-grow">Compact<small>Summarise earlier turns to free up room</small></span>
          </button>
        {/if}
      {/if}
      {#if !p.readOnly && p.context}
        <button data-act="context" onclick={p.oncontext}>{@render p.icon("pulse")} <span class="cm-grow">Context<small>What the model is sent, and how much room is left</small></span></button>
      {/if}
      {#if !p.readOnly && p.macRow}
        <button onclick={p.onmac} disabled={p.macDisabled}>{@render p.icon("mac")} Open on the Mac</button>
      {/if}
    </div>
  {/if}

  {#if p.busyHere || (!p.readOnly && p.canAct)}
    <div class="cm-menu">
      {#if p.busyHere}
        <button class="danger" onclick={p.onstop}>{@render p.icon("stop")} Stop the turn</button>
      {/if}
      {#if !p.readOnly && p.canAct}
        <button class="danger" data-act="delete" onclick={p.ondelete} disabled={!!p.blocked}>{@render p.icon("trash")} Delete</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cm {
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: none;
  }
  .cm-menu {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
    flex: none;
  }
  .cm-menu button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 6px 16px;
    box-sizing: border-box;
    cursor: pointer;
    font-size: 16px;
  }
  .cm-menu button + button {
    border-top: 1px solid var(--line);
  }
  .cm-menu button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .cm-menu button.danger,
  .cm-menu button.danger :global(.ico) {
    color: var(--failed);
  }
  .cm-menu :global(.ico) {
    color: var(--ink2);
  }
  .cm-grow {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .cm-grow small {
    font-size: 12px;
    color: var(--dim);
    line-height: 1.3;
  }
  .cm-dots {
    width: 22px;
    text-align: center;
    color: var(--ink2);
    font-weight: 600;
    flex: none;
  }
  .cm-chev {
    display: inline-flex;
    transform: rotate(90deg);
  }
  .cm-chev.open {
    transform: rotate(-90deg);
  }
  .cm-tag {
    font-size: 11px;
    font-weight: 500;
    color: var(--accent-ink);
    background: var(--accent-soft);
    padding: 2px 8px;
    border-radius: 999px;
    flex: none;
  }
</style>
