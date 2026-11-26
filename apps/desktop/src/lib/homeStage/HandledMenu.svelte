<script lang="ts">
  // Handled (item 946): what Home handled, as a notification list behind one button in the stage bar's corner — it
  // was a panel in Watching's main column, under Needs you. The button wears the unseen count; a click opens the
  // list downward (the shared HUD menu's motion in Jarvis; plain in Classic). A row opens for its detail and its
  // chat; opening it, or its check, marks that one seen; "Mark all seen" moves the feed's seen time, as before.
  // Seen rows stay listed, dimmed — nothing the panel showed is gone. Open or shut, the open row and the scroll are
  // kept with the stage's state (leaving Home, a tab switch, a restart). Kind A throughout: no model call.
  import Icon from "../Icon.svelte";
  import { tip } from "../tip";
  import { plainLine } from "./steps"; // Item 991: a row's line drops markdown marks
  import { hudIn, hudOut } from "../hudMenu";
  import { app, openRun } from "../state.svelte";
  import { home, markHomeSeen } from "../home.svelte";
  import { clock, dateLabel, feedTag } from "../home";
  import Btn from "./Btn.svelte";
  import Detail from "./Detail.svelte";
  import { bag } from "./stageState.svelte";
  import { handledRows, pruneMarked, unseenWords } from "./watch";
  import { arriveWhen } from "./arrive";
  import { classic } from "../layout.svelte";

  const ui = bag("handled", { open: false, scroll: 0, row: null as string | null, marked: {} as Record<string, number> });
  const h = $derived(handledRows(home.rows, home.seenAt, ui.marked));
  /** Item 873: a feed row's project is its id; his name for it, "Home" when none. */
  const placeName = (id: string | null) => (id ? (app.projects.find((p) => p.id === id)?.name ?? (app.project?.id === id ? app.project.name : id)) : "Home");
  const feedLight = (kind: string) =>
    /failed|stuck/.test(kind) ? "bad" : /question|approval|limit|waiting|hand_off/.test(kind) ? "warn" : /changes|started/.test(kind) ? "live" : "ok";

  // Item 944: the button arrives when Home's first handled row lands while he is looking (not at every open).
  let drawn = false;
  $effect(() => {
    const t = setTimeout(() => (drawn = true), 1500);
    return () => clearTimeout(t);
  });
  const late = arriveWhen(() => drawn && !classic());
  let root = $state<HTMLElement | null>(null);
  let btn = $state<HTMLElement | null>(null);
  const mark = (key: string) => {
    if (!ui.marked[key]) ui.marked = { ...ui.marked, [key]: 1 };
  };
  function toggleRow(key: string, unseen: boolean) {
    ui.row = ui.row === key ? null : key;
    if (unseen) mark(key);
  }
  async function all() {
    await markHomeSeen();
    ui.marked = pruneMarked(ui.marked, home.rows, home.seenAt);
  }
  // Marks of rows the feed no longer holds, or that "Mark all seen" (here or on the phone) has covered, are let go.
  $effect(() => {
    const kept = pruneMarked(ui.marked, home.rows, home.seenAt);
    if (home.rows.length && kept !== ui.marked) ui.marked = kept;
  });
  // A click outside, or Escape, shuts it (the list keeps its place for the next open).
  $effect(() => {
    if (!ui.open) return;
    const out = (e: Event) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) ui.open = false;
    };
    // Escape is taken here first (capture) and marked used, so the composer, an aside or a panel that also
    // listens for Escape does not act on the same key press.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      ui.open = false;
      btn?.focus();
    };
    window.addEventListener("pointerdown", out, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", out, true);
      window.removeEventListener("keydown", key, true);
    };
  });
  // The list's scroll: put back when it opens, kept (a moment after he stops) as he scrolls.
  let saving: ReturnType<typeof setTimeout> | null = null;
  // The list never runs past the foot of Home's stage (the stage clips it, and the composer sits below): its
  // height is what is left between the button and the stage's foot, kept as the window is resized.
  function fit(node: HTMLElement) {
    const size = () => {
      const stage = node.closest<HTMLElement>("[data-home-stage]");
      if (!stage || !btn) return;
      const room = stage.getBoundingClientRect().bottom - btn.getBoundingClientRect().bottom - 8 - 12;
      node.style.maxHeight = `${Math.max(160, Math.min(540, Math.floor(room)))}px`;
    };
    size();
    window.addEventListener("resize", size);
    return { destroy: () => window.removeEventListener("resize", size) };
  }
  function place(node: HTMLElement) {
    node.scrollTop = ui.scroll;
    const on = () => {
      if (saving) clearTimeout(saving);
      saving = setTimeout(() => (ui.scroll = Math.round(node.scrollTop)), 150);
    };
    node.addEventListener("scroll", on, { passive: true });
    return {
      destroy() {
        node.removeEventListener("scroll", on);
        if (saving) clearTimeout(saving);
      },
    };
  }
</script>

<!-- Item 944: the button arrives with the first thing Home handles; a Home that has handled nothing has none. -->
{#if home.rows.length > 0 || ui.open}
<span class="hm" bind:this={root} data-handled use:late>
  <button class="hm-btn" class:on={ui.open} class:has={h.unseen > 0} bind:this={btn} aria-haspopup="dialog" aria-expanded={ui.open} onclick={() => (ui.open = !ui.open)} use:tip={ui.open ? "" : h.unseen ? `What Home handled\n${h.unseen} you have not seen` : "What Home handled\nAll seen"}>
    <Icon name="check" size={13} /><span class="hm-t">Handled</span>
    {#if h.unseen > 0}<span class="hm-n" aria-label="{h.unseen} not seen">{unseenWords(h.unseen)}</span>{/if}
    <span class="hm-chev" class:open={ui.open} aria-hidden="true">▾</span>
  </button>
  {#if ui.open}
    <div class="hm-menu hud-m" role="dialog" aria-label="Handled" use:fit in:hudIn|global={{ anchor: btn }} out:hudOut|global>
      <div class="hm-head">
        <span class="hm-cap">Handled</span>
        <span class="hm-sub">{h.unseen ? `${h.unseen} not seen` : h.list.length ? "all seen" : ""}</span>
        {#if h.unseen}<Btn small icon="check" disabled={home.marking} tip={"Every row is seen\nThey stay listed"} onclick={() => void all()}>Mark all seen</Btn>{/if}
      </div>
      <div class="hm-list" use:place>
        {#each h.list as r, i (r.key)}
          {@const f = r.row}
          {@const where = placeName(f.project)}
          <!-- Item 873: what each one was — its chat's title (the row's label) and where — not "Finished" alone. -->
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="h9-item h9-open hm-row" class:seen={!r.unseen} class:isopen={ui.row === r.key} style:--i={Math.min(i, 8)} onclick={() => toggleRow(r.key, r.unseen)}>
            <i class="hm-light {r.unseen ? feedLight(f.kind) : 'off'}"></i>
            <span class="hm-main">
              <span class="hm-ft">{f.label ?? plainLine(f.line)}</span>
              <span class="hm-fsub">{f.label ? plainLine(f.line) : feedTag(f.kind)} · {where}</span>
            </span>
            <span class="h9-mono h9-dim hm-at">{clock(f.at)}</span>
            {#if r.unseen}<button class="hm-seen" aria-label="Mark seen — {f.label ?? f.line}" use:tip={"Mark seen\nIt stays listed"} onclick={(e) => (e.stopPropagation(), mark(r.key))}><Icon name="check" size={12} /></button>{:else}<span class="hm-seen gap" aria-hidden="true"></span>{/if}
          </div>
          {#if ui.row === r.key}
            <Detail rows={[["When", `${dateLabel(f.at)}, ${clock(f.at)}`], ["What", `${feedTag(f.kind)} — ${f.line}`], ["Where", where], ...(f.label ? ([["From", f.label]] as [string, string][]) : [])]}>
              {#if f.chat}<Btn small icon="chat" onclick={() => (mark(r.key), void openRun({ session: f.chat!, project: f.project, onScreen: false }))}>Open chat</Btn>{/if}
            </Detail>
          {/if}
        {/each}
        {#if h.more > 0}<span class="h9-dim hm-none">{h.more} older, seen — not shown</span>{/if}
        {#if h.list.length === 0}<span class="h9-dim hm-none">Nothing handled yet — what Home files lands here</span>{/if}
      </div>
    </div>
  {/if}
</span>
{/if}

<style>
  .hm { position: relative; flex: none; display: inline-flex; }
  .hm-btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px 0 9px; border: 1px solid var(--line2); border-radius: var(--r1); background: var(--well); color: var(--ink2); font: 500 12px var(--sans); cursor: pointer; transition: border-color 140ms, color 140ms, box-shadow 200ms; }
  .hm-btn:hover, .hm-btn.on { color: var(--ink); border-color: color-mix(in srgb, var(--accent) 55%, var(--line2)); }
  .hm-btn.has { border-color: color-mix(in srgb, var(--accent) 45%, var(--line2)); }
  .hm-btn.on { box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 26%, transparent), inset 0 0 8px color-mix(in srgb, var(--accent) 10%, transparent); }
  .hm-n { flex: none; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--accent); color: #1a1205; font: 600 10px/16px var(--mono); text-align: center; box-shadow: var(--glow-accent); }
  .hm-chev { font-size: 9px; color: var(--dim); transition: transform 180ms; }
  .hm-chev.open { transform: rotate(180deg); }
  .hm-menu { position: absolute; z-index: 40; top: calc(100% + 8px); right: 0; width: min(400px, calc(100vw - 32px)); max-height: min(540px, calc(100vh - 230px)); display: flex; flex-direction: column; border: 1px solid var(--line2); border-radius: var(--r2); overflow: hidden; background-color: color-mix(in srgb, var(--paper) 96%, var(--accent)); }
  /* Jarvis: the shared menu's glass is see-through; this list is long and sits over Needs you, so it is solid. */
  :global(:root:not([data-layout="classic"])) .hm-menu.hm-menu.hud-m { background: linear-gradient(180deg, var(--raised), color-mix(in srgb, var(--raised) 55%, var(--term))); }
  .hm-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 9px 12px 8px; border-bottom: 1px solid var(--line); }
  .hm-cap { font: 500 10.5px var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink2); }
  .hm-sub { flex: 1; min-width: 0; font: 10.5px var(--mono); color: var(--dim); letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hm-list { flex: 1; min-height: 0; overflow: hidden auto; overscroll-behavior: contain; padding: 4px 6px 8px; scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }
  .hm-row { align-items: center; animation: hm-drop 240ms cubic-bezier(0.2, 0.9, 0.25, 1.05) backwards; animation-delay: calc(var(--i, 0) * 28ms + 90ms); }
  @keyframes hm-drop { from { opacity: 0; transform: translateY(-7px); } }
  .hm-row.seen .hm-ft { color: var(--ink2); }
  .hm-row.seen { opacity: 0.72; }
  .hm-row.seen:hover, .hm-row.seen.isopen { opacity: 1; }
  .hm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .hm-ft { min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hm-fsub { min-width: 0; font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hm-at { flex: none; font-size: 11px; }
  .hm-seen { flex: none; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: none; color: var(--dim); cursor: pointer; }
  .hm-seen.gap { cursor: default; }
  button.hm-seen:hover, button.hm-seen:focus-visible { color: var(--done); border-color: var(--line2); background: var(--well); }
  .hm-light { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--line2); display: inline-block; }
  .hm-light.ok { background: var(--done); box-shadow: 0 0 6px color-mix(in srgb, var(--done) 65%, transparent); }
  .hm-light.off { background: transparent; box-shadow: inset 0 0 0 1.5px var(--line2); }
  .hm-light.warn { background: var(--partial); box-shadow: 0 0 7px color-mix(in srgb, var(--partial) 70%, transparent); }
  .hm-light.bad { background: var(--failed); box-shadow: 0 0 7px color-mix(in srgb, var(--failed) 70%, transparent); }
  .hm-light.live { background: var(--signal); box-shadow: 0 0 6px color-mix(in srgb, var(--signal) 65%, transparent); }
  .hm-none { display: block; padding: 8px 6px 4px; font-size: 12px; }
  /* Classic and calm: the same button and list, plain — no glow, no drop. */
  :global([data-layout="classic"]) .hm-btn.on, :global([data-light="calm"]) .hm-btn.on { box-shadow: none; }
  :global([data-layout="classic"]) .hm-n, :global([data-light="calm"]) .hm-n { box-shadow: none; }
  :global([data-layout="classic"]) .hm-light, :global([data-light="calm"]) .hm-light { box-shadow: none; }
  :global([data-layout="classic"]) .hm-light.off, :global([data-light="calm"]) .hm-light.off { box-shadow: inset 0 0 0 1.5px var(--line2); }
  :global([data-layout="classic"]) .hm-row { animation: none; }
  @media (prefers-reduced-motion: reduce) { .hm-row { animation: none; } .hm-chev { transition: none; } }
</style>
