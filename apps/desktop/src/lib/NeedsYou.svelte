<script lang="ts">
  import { fitToText } from "./boxGrow";
  /**
   * Needs you (nightshift item 753, 2026-11-16): one view of every chat, helper, blocker and shipped item
   * in every project, grouped by state — Waiting on you, Ready for review, Working — and answerable in
   * place: a question's answers are buttons, and every row that takes words has a reply box (an answer, a
   * blocker's decision, a message to the chat, a follow-up item). His words: "I'm scrolling through all of
   * the stuff and I miss it". The rows are `needsYou.ts`; what a reply does is `needsBoard.svelte.ts`.
   *
   * Kept across closing and reopening: the folded groups, the scroll, and every half-typed reply (the
   * drafts survive a restart; only sending one clears it).
   */
  import { untrack } from "svelte";
  import { tip } from "./tip";
  import { app } from "./state.svelte";
  import { openRun } from "./state/running.svelte";
  import { relativeTime, relativeTimeLong } from "./time";
  import { withNote } from "./askQuestions";
  import { NEED_EMPTY, groupNeeds, type NeedRow } from "./needsYou";
  import { needs, needsNow, refreshBoard, replyTakesFiles, replyTo, reviewProposalRow, setDraft, setFold } from "./needsBoard.svelte";
  // Item 983: files on a reply that goes to a chat as his message (an answer, a message) ride that message.
  import { readDraft, removeAttachment, setDraftAttachments } from "./drafts.svelte";
  import { acceptFiles } from "./attachFiles.svelte";
  import { addToast } from "./state/toasts.svelte";
  import { chipsReady, needsReplyFilesKey } from "./answerFiles";
  import AskLock from "./AskLock.svelte";
  import StartCards from "./StartCards.svelte";
  import { look } from "./askMotion";
  // Item 974: in a row, a digit focuses its answer n; Enter sends it.
  import { keyPicks } from "./cardKeys";
  import { clock, feedTag, type FeedRow } from "./home";
  import { home, homeDone, homeProject, markHomeSeen, refreshHome } from "./home.svelte";

  const groups = $derived(groupNeeds(needsNow()));
  let listEl = $state<HTMLElement | null>(null);

  // Once per opening: untracked, or the read of `needs.loading` inside makes each refresh's end start the next.
  $effect(() => {
    untrack(() => {
      void refreshBoard(true);
      // Item 763 (H2): the feed is read, never marked seen, by opening the view.
      void refreshHome();
    });
  });
  const hasHome = $derived(!!homeProject() || !!home.info);
  const done = $derived(homeDone());
  /** A feed row's project, as the list knows it: by id, else by name. */
  function feedProject(row: FeedRow): { id: string | null; name: string } {
    const p = app.projects.find((x) => x.id === row.project) ?? app.projects.find((x) => x.name === row.project);
    return p ? { id: p.id, name: p.name } : { id: row.project, name: row.project ?? "unfiled chats" };
  }
  async function openFeed(row: FeedRow): Promise<void> {
    if (!row.chat) return;
    app.showNeeds = false;
    await openRun({ session: row.chat, project: feedProject(row).id, onScreen: false });
  }
  // The scroll he left it at (the rows are there at mount; the files' rows arrive after and sit below).
  $effect(() => {
    if (listEl) listEl.scrollTop = needs.scroll;
  });
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") app.showNeeds = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function open(row: NeedRow): Promise<void> {
    if (!row.chat) return;
    app.showNeeds = false;
    await openRun({ session: row.chat, project: row.project, onScreen: false });
  }
  async function send(row: NeedRow, words: string): Promise<void> {
    const key = needsReplyFilesKey(row.id);
    const files = replyTakesFiles(row) ? readDraft(key).attachments : [];
    if (!chipsReady(files)) {
      addToast("A file is still converting — send when it is ready");
      return;
    }
    if (await replyTo(row, words, [...files])) {
      setDraft(row.id, "");
      if (files.length) setDraftAttachments(key, []);
    }
  }
  /** Item 983: files dropped or pasted on a row's reply box (a text paste stays text). */
  function takeFiles(row: NeedRow, list: FileList | null | undefined, e: Event): void {
    const got = Array.from(list ?? []);
    if (!replyTakesFiles(row) || got.length === 0) return;
    e.preventDefault();
    void acceptFiles(needsReplyFilesKey(row.id), got);
  }
  /** An answer button: the label, with whatever he typed in the row's box as his comment on it (712's form). */
  function pick(row: NeedRow, label: string): void {
    void send(row, withNote(label, needs.drafts[row.id]));
  }
  function grow(el: HTMLTextAreaElement): void {
    fitToText(el);
  }
  /** Wave K (Lock-on): a row that leaves — answered, decided, sent — turns green and folds away in Jarvis,
   *  fades in Classic, and simply goes under reduce motion. */
  function rowOut(node: HTMLElement): { duration: number; css?: (t: number) => string } {
    const kind = look();
    if (kind === "none") return { duration: 0 };
    if (kind === "classic") return { duration: 160, css: (t) => `opacity: ${t}` };
    const h = node.offsetHeight;
    return {
      duration: 420,
      css: (t) => {
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        return `height: ${(e * h).toFixed(1)}px; padding-top: ${(9 * e).toFixed(2)}px; padding-bottom: ${(9 * e).toFixed(2)}px; overflow: hidden; opacity: ${Math.min(1, e * 1.6).toFixed(3)}; box-shadow: inset 2px 0 0 var(--done); background: linear-gradient(90deg, color-mix(in srgb, var(--done) 14%, transparent), transparent 70%);`;
      },
    };
  }
  const when = (at: number | null) => (at ? relativeTime(new Date(at).toISOString()) : "");
</script>

<div class="modal lk-shell" role="dialog" aria-label="Needs you">
  <AskLock header=".pane-title" />
  <header class="pane-head">
    <h2 class="pane-title">Needs you</h2>
    <span class="slug">every project · answer in place</span>
    <span class="spacer"></span>
    <button class="ns-btn ghost small" onclick={() => void refreshBoard(true)} disabled={needs.loading} use:tip={"Re-read the blockers and shipped items"}
      >{needs.loading ? "Reading…" : "Refresh"}</button
    >
    <button class="ns-btn ghost small" aria-label="Close" onclick={() => (app.showNeeds = false)}>×</button>
  </header>
  {#if needs.problem}<div class="problem">Some projects could not be read — {needs.problem}</div>{/if}
  <div class="list" bind:this={listEl} use:keyPicks={{ scope: ".row", pick: ".answer" }} onscroll={(e) => (needs.scroll = e.currentTarget.scrollTop)}>
    <!-- Item 763 H5: Home's Start cards wait on him first. -->
    {#if hasHome}<div class="start-cards"><StartCards /></div>{/if}
    {#each groups as g (g.state)}
      <!-- Item 968: Decided for you starts folded (its own "opened" mark) and wears no count. -->
      {@const folded = g.state === "decided" ? needs.folds["decided-open"] !== "1" : needs.folds[g.state] === "1"}
      <section class="group" data-state={g.state}>
        <button class="group-head" aria-expanded={!folded} onclick={() => (g.state === "decided" ? setFold("decided-open", folded) : setFold(g.state, !folded))}>
          <span class="chev" class:folded aria-hidden="true">▾</span>
          <span class="group-name">{g.label}</span>
          <!-- No number on Decided; the empty span still closes Jarvis's "[ … ]" bracket. -->
          {#if g.state !== "decided"}<span class="count">{g.rows.length}</span>{:else}<span class="count" aria-hidden="true"></span>{/if}
        </button>
        {#if !folded}
          {#if g.rows.length === 0}
            <div class="empty">{NEED_EMPTY[g.state]}</div>
          {/if}
          {#each g.rows as row, k (row.id)}
            {@const busy = !!needs.sending[row.id]}
            <div class="row" class:busy class:asks={!!row.ask} data-kind={row.kind} style:--i={k} tabindex="-1" out:rowOut>
              <span class="tag">{row.tag}</span>
              <div class="main">
                <div class="title">{row.title}</div>
                {#if row.detail}<div class="detail">{row.detail}</div>{/if}
                {#if row.ask && row.ask.options.length}
                  <div class="answers">
                    {#each row.ask.options as o, k (o)}
                      <button class="answer" class:first={k === 0} disabled={busy} onclick={() => pick(row, o)} use:tip={"Send this answer — what you typed below goes with it as a comment"}>{o}</button>
                    {/each}
                  </div>
                {/if}
                {#if row.reply}
                  <div class="reply">
                    <!-- Item 934: its undo history is the reply's (`fieldUndo.ts`), kept while the board is away. -->
                    <textarea
                      rows="1"
                      data-undo-key={`needs:${row.id}`}
                      value={needs.drafts[row.id] ?? ""}
                      placeholder={replyTakesFiles(row) ? `${row.replyHint} — or drop files` : row.replyHint}
                      ondragover={(e) => replyTakesFiles(row) && e.dataTransfer?.types.includes("Files") && e.preventDefault()}
                      ondrop={(e) => takeFiles(row, e.dataTransfer?.files, e)}
                      onpaste={(e) => takeFiles(row, e.clipboardData?.files, e)}
                      aria-label={`${row.replyHint} — ${row.title}`}
                      disabled={busy}
                      oninput={(e) => {
                        grow(e.currentTarget);
                        setDraft(row.id, e.currentTarget.value);
                      }}
                      onkeydown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                          e.preventDefault();
                          void send(row, e.currentTarget.value);
                        }
                      }}
                    ></textarea>
                    <button class="ns-btn small" disabled={busy || !(needs.drafts[row.id] ?? "").trim()} onclick={() => void send(row, needs.drafts[row.id] ?? "")}
                      >{busy ? "Sending…" : "Send"}</button
                    >
                  </div>
                  {@const chips = replyTakesFiles(row) ? readDraft(needsReplyFilesKey(row.id)).attachments : []}
                  {#if chips.length > 0}
                    <div class="reply-files" aria-label="files on this reply">
                      {#each chips as f (f.id)}
                        <span class="reply-file" class:pending={f.pending}
                          >{f.name}{#if f.pending}<span class="rf-dim">(converting)</span>{/if}<button
                            type="button"
                            class="rf-x"
                            aria-label="remove {f.name}"
                            onclick={() => removeAttachment(needsReplyFilesKey(row.id), f.id)}>×</button
                          ></span
                        >
                      {/each}
                    </div>
                  {/if}
                {/if}
              </div>
              <span class="where" use:tip={row.where}>{row.where}</span>
              <span class="when">{when(row.at)}</span>
              {#if row.chat}
                <button class="ns-btn ghost small open" onclick={() => void open(row)}>Open</button>
              {:else if row.kind === "proposal"}
                <button class="ns-btn ghost small open" use:tip={"Review the diff\nApply or reject it there"} onclick={() => void reviewProposalRow(row)}>Review</button>
              {:else}
                <span></span>
              {/if}
            </div>
          {/each}
        {/if}
      </section>
    {/each}
    {#if hasHome}
      <!-- Item 763 (H2): Home's feed since he last marked it seen. -->
      {@const folded = needs.folds["done-since"] === "1"}
      <section class="group" data-state="done-since">
        <div class="group-row">
          <button class="group-head" aria-expanded={!folded} onclick={() => setFold("done-since", !folded)}>
            <span class="chev" class:folded aria-hidden="true">▾</span>
            <span class="group-name">Done since you looked</span>
            <span class="count">{done.length}</span>
          </button>
          {#if done.length > 0}
            <button class="ns-btn ghost small seen" disabled={home.marking} onclick={() => void markHomeSeen()} use:tip={`${done.length} rows · clears this list\nNothing else changes`}
              >{home.marking ? "Marking…" : "Mark all seen"}</button
            >
          {/if}
        </div>
        {#if !folded}
          {#if done.length === 0}
            <div class="empty">{home.seenAt ? `Nothing new since you last looked (${clock(home.seenAt)}, ${relativeTimeLong(home.seenAt)}).` : "Nothing in Home's feed yet."}</div>
          {/if}
          {#each done as row, k (`${row.at}|${row.kind}|${row.chat ?? ""}|${k}`)}
            {@const where = feedProject(row).name}
            <div class="row" data-kind={row.kind} style:--i={k}>
              <span class="tag">{feedTag(row.kind)}</span>
              <div class="main">
                <div class="title">{row.label ?? row.line}</div>
                {#if row.label && row.line}<div class="detail">{row.line}</div>{/if}
              </div>
              <span class="where" use:tip={where}>{where}</span>
              <span class="when">{when(Date.parse(row.at))}</span>
              {#if row.chat}
                <button class="ns-btn ghost small open" onclick={() => void openFeed(row)}>Open</button>
              {:else}
                <span></span>
              {/if}
            </div>
          {/each}
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .group-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .group-row .group-head {
    flex: 1;
    min-width: 0;
  }
  .seen {
    flex: none;
  }
  .modal {
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 12px;
    width: min(54rem, calc(100vw - 4rem));
    max-height: calc(100vh - 3rem);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .pane-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex: none;
    padding: 20px 24px 12px;
  }
  .pane-title {
    margin: 0;
    font-family: var(--serif);
    font-size: 26px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .slug {
    font-size: 13px;
    color: var(--ink2);
  }
  .spacer {
    flex: 1;
  }
  .problem {
    padding: 0 24px 8px;
    font-size: 12.5px;
    color: var(--dim);
  }
  .list {
    overflow-y: auto;
    padding: 0 16px 18px;
  }
  .group + .group {
    margin-top: 10px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 8px 6px;
    border: 0;
    background: none;
    color: var(--ink2);
    font-family: var(--mono);
    font-size: 11.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    text-align: left;
  }
  .group[data-state="waiting"] .group-head {
    color: var(--accent-ink);
  }
  .chev {
    display: inline-block;
    transition: transform 0.12s;
  }
  .chev.folded {
    transform: rotate(-90deg);
  }
  .count {
    font-variant-numeric: tabular-nums;
    color: var(--dim);
  }
  .empty {
    padding: 4px 8px 8px 28px;
    font-size: 13px;
    color: var(--dim);
  }
  .row:focus {
    outline: none;
  }
  .row {
    display: grid;
    grid-template-columns: 7.5rem minmax(0, 1fr) 8rem 4.5rem 3.5rem;
    gap: 12px;
    align-items: start;
    padding: 9px 8px;
    border-top: 1px solid var(--line2);
  }
  .row.busy {
    opacity: 0.6;
  }
  .tag {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
    padding-top: 2px;
    overflow-wrap: anywhere;
  }
  .group[data-state="waiting"] .tag {
    color: var(--accent-ink);
  }
  .row[data-kind="failed"] .tag {
    color: var(--err, var(--accent-ink));
  }
  .main {
    min-width: 0;
  }
  .title {
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .detail {
    margin-top: 2px;
    font-size: 13px;
    color: var(--ink2);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .answers {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .answer {
    font: inherit;
    font-size: 13px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--line2);
    background: none;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }
  .answer.first {
    border-color: var(--accent-ink);
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .answer:hover:not(:disabled) {
    border-color: var(--accent-ink);
  }
  .reply {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    margin-top: 8px;
  }
  .reply textarea {
    flex: 1;
    min-width: 0;
    resize: none;
    font: inherit;
    font-size: 13px;
    line-height: 1.4;
    padding: 5px 9px;
    border-radius: 8px;
    border: 1px solid var(--line2);
    background: var(--paper);
    color: inherit;
    max-height: 9rem;
  }
  .reply textarea:focus {
    outline: none;
    border-color: var(--accent-ink);
  }
  /* Item 983: files on a reply, as small chips under its box (975's question-card chips). */
  .reply-files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .reply-file {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    padding: 2px 4px 2px 8px;
    border: 1px solid var(--line2, var(--line));
    border-radius: 6px;
    max-width: 22rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reply-file.pending,
  .rf-dim {
    color: var(--dim);
  }
  .rf-x {
    border: none;
    background: none;
    color: var(--dim);
    cursor: pointer;
    padding: 0 4px;
    font: inherit;
  }
  .rf-x:hover {
    color: var(--ink);
  }
  .where,
  .when {
    font-size: 12px;
    color: var(--dim);
    padding-top: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    text-align: right;
  }
  @media (max-width: 640px) {
    .modal {
      width: calc(100vw - 1rem);
    }
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .tag {
      grid-column: 1 / -1;
    }
    .where,
    .when {
      display: none;
    }
  }

  /* Wave K, Lock-on (his pick, blocker 2031; his words on the first look: "i like needs you functionally, tho
     same on making it more within theme"): in Jarvis the view arrives like the card — brackets, scanline,
     its title decoding — wears the lit edge, brackets its group heads, marks what waits on him with an
     amber edge, and scans its rows in. Classic keeps the rules above. */
  :global(:where(:root:not([data-layout="classic"]))) .modal {
    border-color: color-mix(in srgb, var(--accent) 30%, var(--line2));
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.5),
      var(--glow-main, 0 0 0 transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .pane-title {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  :global(:where(:root:not([data-layout="classic"]))) .group-head {
    letter-spacing: 0.16em;
  }
  :global(:where(:root:not([data-layout="classic"]))) .group-name::before {
    content: "[ ";
    color: var(--bracket, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .count::after {
    content: " ]";
    color: var(--bracket, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .group[data-state="waiting"] .row {
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .row.asks {
    box-shadow: inset 2px 0 0 var(--accent);
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%);
  }
  :global(:where(:root:not([data-layout="classic"]))) .row:hover {
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 6%, transparent), transparent 60%);
  }
  :global(:where(:root:not([data-layout="classic"]))) .answer:hover:not(:disabled) {
    box-shadow: var(--glow-accent, none);
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(:where(:root:not([data-layout="classic"]))) .row {
      animation: ny-row 0.5s cubic-bezier(0.3, 0.6, 0.3, 1) both;
      animation-delay: calc(300ms + var(--i, 0) * 60ms);
    }
  }
  @keyframes ny-row {
    0% {
      clip-path: inset(0 0 100% 0);
    }
    100% {
      clip-path: inset(0 0 0 0);
    }
  }
</style>
