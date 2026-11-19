<script lang="ts">
  // Watch (item 845; 809 round 6) — Home has nothing of its own to do. This is also Home's own new-chat page: what
  // Home reaches, what needs him, what it handled since he looked, and its steps — on live data, never a script.
  //   Sources   — his connectors (item 804's check) and what macOS keeps on this Mac (item 808). Open a row: A.
  //               "Check all": asks Claude Code what Home reaches now — no model request (A). Each row's own
  //               Check now asks about that source alone: a connector through `claude mcp get`, a Mac source by
  //               re-reading its macOS permission (never a dialog) — A.
  //   Needs you — the app's own needs-you rows (item 753), every project. "Answer" opens the Needs-you view (A; the
  //               answer itself is that view's card, kind C).
  //   Handled   — Home's feed since he last looked. "Mark all seen" moves the seen time (A).
  import Icon from "../../Icon.svelte";
  import type { IconName } from "../../icons";
  import { app, openRun } from "../../state.svelte";
  import { home, homeDone, markHomeSeen, checkReach, refreshSources, checkingOne, checkSource } from "../../home.svelte";
  import { clock, dateLabel, feedTag, reachName, reachStatusWords, type FeedRow } from "../../home";
  import { needsNow } from "../../needsBoard.svelte";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Btn from "../Btn.svelte";
  import Detail from "../Detail.svelte";
  import Loading from "../Loading.svelte";
  import { bag } from "../stageState.svelte";
  import { sourceRows } from "../watch";
  import { nudge } from "../tasks.svelte";

  const ui = bag("watch", { open: null as string | null });
  const toggle = (id: string) => (ui.open = ui.open === id ? null : id);

  const sources = $derived(sourceRows(home.reach, home.sources, reachName, reachStatusWords, clock));
  const needs = $derived(needsNow().filter((r) => r.state !== "working"));
  const since = $derived(homeDone());
  const handled = $derived<FeedRow[]>((since.length ? since : home.rows.slice(-12)).slice().reverse());
  const checked = $derived(home.reach?.checked_at ? `checked ${clock(home.reach.checked_at)}` : "not checked yet");
  // Check now on one source is one of the four that start a short Home turn (846 §2, blocker 2143): the check itself
  // is code (no model); once it is back, Home is told what it found and may act on it.
  async function checkOne(id: string) {
    await checkSource(id);
    const s = sources.find((x) => x.id === id);
    if (s) nudge({ name: "Watching", view: "watch" }, `you checked ${s.name} now — ${s.state}`);
  }
  async function check() {
    await Promise.all([checkReach(), refreshSources()]);
  }
</script>

<div class="h9-grid">
  <div class="h9-row">
    <div class="h9-col h9-fill">
      <Panel title="Sources" sub={checked} live={home.checking}>
        {#snippet tools()}<Btn small icon="refresh" disabled={home.checking} tip={"Ask Claude Code what Home reaches now\nNo model request"} onclick={() => void check()}>{home.checking ? "Checking…" : "Check all"}</Btn>{/snippet}
        {#each sources as s, i (s.id)}
          {@const busy = home.checking || !!checkingOne[s.id]}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="h9-item w-src h9-open h9-stagein" style:--i={i} class:cur={busy} class:h9-brk={!!checkingOne[s.id]} class:isopen={ui.open === s.id} onclick={() => toggle(s.id)}>
            {#if checkingOne[s.id]}<i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i>{/if}
            <span class="w-ico" class:hot={s.hot}><Icon name={s.icon as IconName} size={14} /></span>
            <span class="w-main">
              <span class="w-name">{s.name}</span>
              <span class="w-res" class:hot={s.hot} class:h9-caret={busy}>{busy ? "checking" : s.state}</span>
            </span>
            <span class="w-chk"><Btn small icon="refresh" disabled={busy} label="Check {s.name} now" tip={s.id.startsWith("c:") ? `Check ${s.name} now\nAsks Claude Code about it alone; no model request` : `Check ${s.name} now\nReads its macOS permission again; never asks`} onclick={() => void checkOne(s.id)} /></span>
            <span class="h9-chev">▸</span>
          </div>
          {#if ui.open === s.id}<Detail rows={s.detail}><Btn small icon="refresh" disabled={busy} onclick={() => void checkOne(s.id)}>{checkingOne[s.id] ? "Checking…" : "Check now"}</Btn></Detail>{/if}
        {/each}
        {#if sources.length === 0}<Loading label={home.reach === null ? "Reading what Home can reach" : "No sources yet — connect one in Settings → Home"} lines={2} />{/if}
      </Panel>
    </div>
    <div class="h9-col h9-fill">
      <Panel title="Needs you" sub={String(needs.length)} lock={needs.length > 0}>
        <div class="w-needs">
          {#each needs as n (n.id)}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="nd h9-open" class:isopen={ui.open === "n" + n.id} onclick={() => toggle("n" + n.id)}>
              <span class="nd-who">{n.tag} · {n.where}<span class="g"></span><span class="h9-chev">▸</span></span>
              <p class="nd-q">{n.title}</p>
              {#if ui.open === "n" + n.id}
                <Detail rows={[["What", n.detail || n.title], ["Where", n.where]]} />
              {/if}
              <span class="h9-acts">
                <Btn kind="send" icon="reply" small tip={"Opens the Needs-you view\nYour answer is typed there"} onclick={() => (app.showNeeds = true)}>Answer</Btn>
                {#if n.chat}<Btn small icon="chat" onclick={() => void openRun({ session: n.chat!, project: n.project, onScreen: false })}>Open chat</Btn>{/if}
              </span>
            </div>
          {/each}
          {#if needs.length === 0}<Loading label="Nothing needs you — Home is watching" lines={2} />{/if}
        </div>
      </Panel>
      <Panel title="Handled" sub={since.length ? `${since.length} since you looked` : "latest"}>
        {#snippet tools()}{#if since.length}<Btn small icon="check" disabled={home.marking} onclick={() => void markHomeSeen()}>Mark all seen</Btn>{/if}{/snippet}
        {#each handled as f (f.at + f.line)}
          {@const k = "f" + f.at + f.line}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="h9-item h9-open h9-stagein w-feed" class:isopen={ui.open === k} onclick={() => toggle(k)}><span class="h9-chev">▸</span><span class="w-ft">{f.line}</span><span class="h9-mono h9-dim">{feedTag(f.kind)} · {clock(f.at)}</span></div>
          {#if ui.open === k}
            <Detail rows={[["When", `${dateLabel(f.at)}, ${clock(f.at)}`], ["Where", f.project ?? "Home"], ...(f.label ? ([["From", f.label]] as [string, string][]) : [])]}>
              {#if f.chat}<Btn small icon="chat" onclick={() => void openRun({ session: f.chat!, project: f.project, onScreen: false })}>Open chat</Btn>{/if}
            </Detail>
          {/if}
        {/each}
        {#if handled.length === 0}<span class="h9-dim w-none">Nothing handled yet — what Home files lands here</span>{/if}
      </Panel>
    </div>
  </div>
  <div class="h9-col h9-wide"><Panel title="Home's steps" live={app.busy} flush><Steps id="watch" /></Panel></div>
</div>

<style>
  .w-src { align-items: center; position: relative; }
  .w-ico { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--r1); background: var(--well); border: 1px solid var(--line2); color: var(--ink2); flex: none; transition: color 200ms, border-color 200ms, box-shadow 200ms; }
  .w-ico.hot { color: var(--accent-ink); border-color: var(--accent); box-shadow: var(--glow-accent); }
  .w-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .w-name { font-size: 13px; font-weight: 500; }
  .w-res { font-size: 11.5px; color: var(--dim); transform-origin: left; align-self: flex-start; }
  .w-res.hot { color: var(--accent-ink); }
  .w-chk { flex: none; opacity: 0.55; transition: opacity 120ms; }
  .w-src:hover .w-chk, .w-src.isopen .w-chk, .w-chk:focus-within { opacity: 1; }
  .w-needs { display: flex; flex-direction: column; gap: 8px; }
  .w-feed { align-items: baseline; }
  .w-ft { flex: 1; min-width: 0; font-size: 12.5px; }
  .w-none { display: block; padding: 6px 2px; font-size: 12px; }
</style>
