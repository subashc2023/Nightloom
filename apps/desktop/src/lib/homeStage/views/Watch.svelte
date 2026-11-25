<script lang="ts">
  // Watch (item 845; 809 round 6) — Home has nothing of its own to do. This is also Home's own new-chat page: what
  // Home reaches, what needs him, what it handled since he looked, and its steps — on live data, never a script.
  //   Sources   — his connectors (item 804's check) and what macOS keeps on this Mac (item 808). Open a row: A.
  //               "Check all": asks Claude Code what Home reaches now — no model request (A). Each row's own
  //               Check now asks about that source alone: a connector through `claude mcp get`, a Mac source by
  //               re-reading its macOS permission (never a dialog) — A.
  //   Needs you — the app's own needs-you rows (item 753) that wait on him in his chats, every project; Nightshift's
  //               blockers and shipped items are one quiet line (item 945). "Answer" opens the Needs-you view (A; the
  //               answer itself is that view's card, kind C).
  //   Handled   — item 946: no longer a panel here; it is the Handled button in the stage bar's corner
  //               (`HandledMenu.svelte`), so Needs you has the column.
  import Icon from "../../Icon.svelte";
  import { app, openRun } from "../../state.svelte";
  import { home, checkReach, refreshSources, checkingOne, checkSource } from "../../home.svelte";
  import { clock, reachName, reachStatusWords } from "../../home";
  import { homeNeedsNow, needs as board, replyTo, setDraft, dropEnded } from "../../needsBoard.svelte";
  import { withNote } from "../../askQuestions";
  import { nightshiftWords, type NeedRow } from "../../needsYou";
  import Panel from "../Panel.svelte";
  import Steps from "../Steps.svelte";
  import Btn from "../Btn.svelte";
  import Detail from "../Detail.svelte";
  import Loading from "../Loading.svelte";
  import { bag } from "../stageState.svelte";
  import { sourceRows, sourceGroups } from "../watch";
  import { tip } from "../../tip";
  import { nudge } from "../tasks.svelte";
  import MathText from "../../MathText.svelte";

  const ui = bag("watch", { open: null as string | null, reply: null as string | null });
  // Item 874: what each Needs-you card's first button says and does — it opens the card's own reply box.
  const REPLY_LABEL: Record<NonNullable<NeedRow["reply"]>, string> = { "answer-ask": "Answer", "answer-blocker": "Answer", message: "Reply", "follow-up": "Follow up" };
  const REPLY_TIP: Record<NonNullable<NeedRow["reply"]>, string> = {
    "answer-ask": "Answer here\nSent as your next message",
    "answer-blocker": "Answer here\nFiled as the blocker's answer",
    message: "Reply here\nSent in that chat",
    "follow-up": "Something wrong?\nIt becomes a new item",
  };
  async function send(n: NeedRow, words: string) {
    if (await replyTo(n, words)) {
      setDraft(n.id, "");
      if (ui.reply === n.id) ui.reply = null;
    }
  }
  const focusOnce = (el: HTMLInputElement) => {
    el.focus({ preventScroll: true });
  };
  const toggle = (id: string) => (ui.open = ui.open === id ? null : id);

  const sources = $derived(sourceRows(home.reach, home.sources, reachName, reachStatusWords, clock));
  const groups = $derived(sourceGroups(sources));
  // Item 945: Home lists what waits on him in his chats; Nightshift's blockers and shipped items are one quiet line.
  const mine = $derived(homeNeedsNow());
  const needs = $derived(mine.rows);
  const elsewhere = $derived(nightshiftWords(mine));
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
        <!-- Item 873: each service one group with its own mark and tint (sourceLook.ts) — a service with several
             accounts is one heading over a line per account, so Gmail ×3 reads once; every row keeps a status light
             (its reason on hover) and its own Check now. -->
        {#each groups as g, gi (g.service)}
          {@const solo = g.rows.length === 1}
          {@const same = g.rows.every((r) => r.state === g.rows[0].state && r.light === g.rows[0].light)}
          <div class="w-grp h9-stagein" class:solo style:--i={gi} style:--tint={g.tint}>
            {#if !solo}
              <div class="w-ghead">
                <span class="w-ico"><Icon name={g.icon} size={15} /></span>
                <span class="w-main">
                  <span class="w-name">{g.service}<span class="w-n">×{g.rows.length}</span></span>
                  {#if same}<span class="w-res w-{g.rows[0].light}" use:tip={g.rows[0].why}><i class="w-light {g.rows[0].light}"></i>{g.rows.length} accounts · {g.rows[0].state}</span>{:else}<span class="w-res">{g.rows.length} accounts</span>{/if}
                </span>
              </div>
            {/if}
            {#each g.rows as s (s.id)}
              {@const busy = home.checking || !!checkingOne[s.id]}
              <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
              <div class="h9-item w-src h9-open" class:w-acct={!solo} class:cur={busy} class:h9-brk={!!checkingOne[s.id]} class:isopen={ui.open === s.id} onclick={() => toggle(s.id)}>
                {#if checkingOne[s.id]}<i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i>{/if}
                {#if solo}<span class="w-ico"><Icon name={s.icon} size={15} /></span>{:else}<i class="w-light {s.light}" use:tip={s.why}></i>{/if}
                <span class="w-main">
                  <span class="w-name">{solo ? s.name : s.short}</span>
                  {#if solo || !same || busy}<span class="w-res w-{s.light}" class:h9-caret={busy} use:tip={busy ? "" : s.why}>{#if solo}<i class="w-light {s.light}"></i>{/if}{busy ? "checking" : s.state}</span>{/if}
                </span>
                <span class="w-chk"><Btn small icon="refresh" disabled={busy} label="Check {s.name} now" tip={s.id.startsWith("c:") ? `Check ${s.name} now\nAsks Claude Code about it alone; no model request` : `Check ${s.name} now\nReads its macOS permission again; never asks`} onclick={() => void checkOne(s.id)} /></span>
                <span class="h9-chev">▸</span>
              </div>
              {#if ui.open === s.id}<Detail rows={s.detail}><Btn small icon="refresh" disabled={busy} onclick={() => void checkOne(s.id)}>{checkingOne[s.id] ? "Checking…" : "Check now"}</Btn></Detail>{/if}
            {/each}
          </div>
        {/each}
        {#if sources.length === 0}<Loading label={home.reach === null ? "Reading what Home can reach" : "No sources yet — connect one in Settings → Home"} lines={2} />{/if}
      </Panel>
    </div>
    <div class="h9-col h9-fill">
      <Panel title="Needs you" sub={String(needs.length)} lock={needs.length > 0}>
        <div class="w-needs">
          {#each needs as n (n.id)}
            {@const busy = !!board.sending[n.id]}
            {@const draft = board.drafts[n.id] ?? ""}
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="nd h9-open" class:isopen={ui.open === "n" + n.id} onclick={() => toggle("n" + n.id)}>
              <span class="nd-who">{n.tag} · {n.where}<span class="g"></span><span class="h9-chev">▸</span></span>
              <p class="nd-q"><MathText text={n.title} /></p>
              {#if ui.open === "n" + n.id}
                <Detail rows={[["What", n.detail || n.title], ...(n.detail && n.detail !== n.title ? ([["Chat", n.title]] as [string, string][]) : []), ["Where", n.where]]} />
              {/if}
              {#if ui.reply === n.id && n.reply}
                <!-- Item 874: the answer is typed on the card itself (the Needs-you view's own reply, `replyTo`); the
                     draft is the Needs-you view's kept draft — leaving the card, the view or the app keeps it. -->
                <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                <span class="w-answer" onclick={(e) => e.stopPropagation()}>
                  {#if n.ask && n.ask.options.length}
                    <span class="nd-opts">{#each n.ask.options as o (o)}<Btn small disabled={busy} tip={"Send this answer\nWhat you typed goes with it"} onclick={() => void send(n, withNote(o, draft))}>{o}</Btn>{/each}</span>
                  {/if}
                  <span class="nd-reply">
                    <input placeholder={n.replyHint} aria-label={`${n.replyHint} — ${n.title}`} value={draft} disabled={busy} use:focusOnce oninput={(e) => setDraft(n.id, e.currentTarget.value)} onkeydown={(e) => { if (e.key === "Enter" && !e.isComposing) void send(n, e.currentTarget.value); else if (e.key === "Escape") ui.reply = null; }} />
                    <Btn kind="send" small disabled={busy || !draft.trim()} onclick={() => void send(n, draft)}>{busy ? "Sending…" : "Send"}</Btn>
                  </span>
                </span>
              {/if}
              <span class="h9-acts">
                {#if n.reply}
                  <Btn kind="send" icon="reply" small on={ui.reply === n.id} tip={REPLY_TIP[n.reply]} onclick={() => (ui.reply = ui.reply === n.id ? null : n.id)}>{REPLY_LABEL[n.reply]}</Btn>
                {:else}
                  <Btn kind="send" icon="reply" small tip={"Opens the Needs-you view\nEverything waiting on you"} onclick={() => (app.showNeeds = true)}>Open</Btn>
                {/if}
                {#if n.chat}<Btn small icon="chat" tip={"Opens this chat\nIn its own project"} onclick={() => void openRun({ session: n.chat!, project: n.project, onScreen: false })}>Open chat</Btn>{/if}
                {#if (n.kind === "done" || n.kind === "failed") && n.chat}<Btn small icon="check" tip={"Seen — off this list\nThe chat is untouched"} onclick={() => dropEnded(n.chat!)}>Mark seen</Btn>{/if}
                {#if draft && ui.reply !== n.id}<span class="nd-hint">draft kept — “{draft.length > 40 ? draft.slice(0, 40) + "…" : draft}”</span>{/if}
              </span>
            </div>
          {/each}
          {#if needs.length === 0}<Loading label="Nothing needs you — Home is watching" lines={2} />{/if}
          <!-- Item 945: Nightshift's open blockers and shipped items are not listed here (he answers those where he
               runs Nightshift); one quiet line says how many, and opens the Needs-you view, which lists every one. -->
          {#if elsewhere}<button class="w-else" use:tip={"Not listed on Home\nOpens the Needs-you view"} onclick={() => (app.showNeeds = true)}><span class="w-else-t">Nightshift · {elsewhere}</span><span class="w-else-go">in Needs you →</span></button>{/if}
        </div>
      </Panel>
    </div>
  </div>
  <div class="h9-col h9-wide"><Panel title="Home's steps" live={app.busy} flush><Steps id="watch" /></Panel></div>
</div>

<style>
  /* Item 873: each source group wears its service's tint (--tint, from sourceLook.ts) — a low-alpha fill and edge on
     its mark, the mark itself in the tint, a soft glow on hover in Jarvis; Classic and calm keep the tint on the mark
     alone. */
  .w-grp { --tint-soft: color-mix(in srgb, var(--tint) 13%, transparent); --tint-edge: color-mix(in srgb, var(--tint) 42%, transparent); position: relative; display: flex; flex-direction: column; padding: 2px 0; }
  .w-grp + .w-grp { margin-top: 2px; }
  .w-ghead { display: flex; align-items: center; gap: 10px; padding: 7px 9px 3px; min-width: 0; }
  .w-src { align-items: center; position: relative; }
  .w-ico { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 7px; background: linear-gradient(160deg, color-mix(in srgb, var(--tint) 20%, transparent), var(--tint-soft) 70%); border: 1px solid var(--tint-edge); color: var(--tint); flex: none; transition: box-shadow 200ms, border-color 200ms; }
  .w-grp:hover .w-ico { border-color: color-mix(in srgb, var(--tint) 70%, transparent); box-shadow: 0 0 12px color-mix(in srgb, var(--tint) 38%, transparent), inset 0 0 6px color-mix(in srgb, var(--tint) 18%, transparent); }
  .w-grp .w-src:hover { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--tint) 70%, transparent); }
  .w-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .w-name { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .w-n { margin-left: 7px; font: 500 10.5px var(--mono); color: var(--tint); opacity: 0.85; letter-spacing: 0.04em; }
  .w-res { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--dim); transform-origin: left; align-self: flex-start; max-width: 100%; }
  .w-res.w-warn { color: var(--partial); }
  .w-res.w-bad { color: var(--failed); }
  /* The account lines under a service's heading: hung off a thin rule in its tint, aligned under its name. */
  .w-acct { margin-left: 23px; padding-left: 16px; border-left: 1px solid var(--tint-edge); border-radius: 0 var(--r1) var(--r1) 0; padding-top: 5px; padding-bottom: 5px; }
  .w-acct .w-name { font-weight: 400; color: var(--ink2); font-size: 12.5px; }
  .w-acct:hover .w-name, .w-acct.isopen .w-name { color: var(--ink); }
  /* The status light: read by the scan (ok), there but not read (idle), off (a ring), needs him (warn, bad). */
  .w-light { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--line2); display: inline-block; }
  .w-light.ok { background: var(--done); box-shadow: 0 0 6px color-mix(in srgb, var(--done) 65%, transparent); }
  .w-light.idle { background: color-mix(in srgb, var(--done) 35%, var(--well2)); }
  .w-light.off { background: transparent; box-shadow: inset 0 0 0 1.5px var(--line2); }
  .w-light.warn { background: var(--partial); box-shadow: 0 0 7px color-mix(in srgb, var(--partial) 70%, transparent); }
  .w-light.bad { background: var(--failed); box-shadow: 0 0 7px color-mix(in srgb, var(--failed) 70%, transparent); }
  .w-chk { flex: none; opacity: 0.55; transition: opacity 120ms; }
  .w-src:hover .w-chk, .w-src.isopen .w-chk, .w-chk:focus-within { opacity: 1; }
  .w-needs { display: flex; flex-direction: column; gap: 8px; }
  .w-else { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 4px 2px; border: 0; background: none; color: var(--dim); font: 11.5px var(--sans); text-align: left; cursor: pointer; }
  .w-else-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .w-else-go { flex: none; margin-left: auto; font: 10.5px var(--mono); letter-spacing: 0.04em; opacity: 0.75; }
  .w-else:hover, .w-else:focus-visible { color: var(--ink2); }
  .w-answer { display: flex; flex-direction: column; gap: 6px; cursor: default; }
  .w-answer :global(.nd-reply) { flex-wrap: wrap; }
  .w-answer :global(.nd-reply input) { flex: 1 1 140px; }
  .h9-acts .nd-hint { align-self: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* Classic and calm: the same marks and lights, plain — the tint on the mark, no fill, no glow. */
  :global([data-layout="classic"]) .w-ico, :global([data-light="calm"]) .w-ico { background: var(--well); border-color: var(--line2); box-shadow: none; }
  :global([data-layout="classic"]) .w-grp:hover .w-ico, :global([data-light="calm"]) .w-grp:hover .w-ico { box-shadow: none; border-color: var(--line2); }
  :global([data-layout="classic"]) .w-light, :global([data-light="calm"]) .w-light { box-shadow: none; }
  :global([data-layout="classic"]) .w-light.off, :global([data-light="calm"]) .w-light.off { box-shadow: inset 0 0 0 1.5px var(--line2); }
</style>
