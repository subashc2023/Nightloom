<script lang="ts">
  import type { Snippet } from "svelte";
  import { tip } from "./tip";
  import {
    addToast,
    app,
    asideAsking,
    asideWaiting,
    askAside,
    followUpAside,
    restoreAsideTurns,
    rewindAside,
    setAsideUnsent,
    stopAside,
    type Aside,
  } from "./state.svelte";
  import type { Attachment } from "./types";
  import { scheduleAsideSave } from "./asides.svelte";
  import { asideDraftKey } from "./asides";
  import { asideWait, quietLabel } from "./asideWait";
  import { asideEvents, asideLive } from "./asideTranscript";
  import type { TranscriptSource } from "./transcriptSource.svelte";
  import Transcript from "./Transcript.svelte";
  import AsideFoldPanel from "./AsideFoldPanel.svelte";

  /**
   * An aside's thread, drawn by the chat's own transcript (item 674,
   * 2026-11-12; his "why we aren't jus using a common shared code base …
   * for asides and main"). `AsideThread.svelte` drew an aside's exchanges
   * itself, so every feature of the chat's transcript had to be ported;
   * this hands the thread to `Transcript.svelte` as a `TranscriptSource`
   * (`asideTranscript.ts` projects the exchanges into the chat's events)
   * and adds only what is the aside's own:
   *
   * - its actions behind the shared controls — Rewind (the exchanges leave,
   *   the question goes back into the aside's box), Edit → *Ask again* in
   *   place, Redo/Retry on the last answer — each with Undo on its notice;
   * - the notes under an exchange ("stopped here", its error);
   * - the wait's words (one aside at a time, queued behind the chat's
   *   turn) and the stalled notice with Ask again and Stop;
   * - *Fold into thread*'s panel at the column's end, and whatever its
   *   frame puts at the head (`lead`: the quoted passage).
   *
   * `frame` is `full` in a tab (the chat's ground, rail and ⌄) and
   * `compact` in the card and the side panel. The tab, the card and the
   * panel differ in their frames, never in the turns. Classic keeps
   * `AsideThread` (blocker 1989).
   */
  let {
    aside,
    open,
    owner,
    frame,
    scrollKey,
    lead,
  }: {
    aside: Aside;
    /** The thread's chat is the open one: it takes follow-ups. */
    open: boolean;
    /** The chat the thread belongs to, which need not be the open one. */
    owner: string | null;
    frame: "full" | "compact";
    /** Where the reading place is kept (`asideScrollKey` / `asideCardScrollKey`). */
    scrollKey: string;
    lead?: Snippet;
  } = $props();

  const asking = $derived(asideAsking(aside));
  const waiting = $derived(asideWaiting(aside));
  const onClaudeCode = $derived(app.connection?.engine === "claude-code");
  // The asking exchange's events read only its question, so a streamed
  // delta rebuilds the live turn alone, never the thread's items.
  const ev = $derived(asideEvents(aside));
  const live = $derived(asideLive(aside));

  // The clock the queued / stalled words read (item 404), ticking only
  // while an exchange runs.
  let now = $state(Date.now());
  $effect(() => {
    if (!asking) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const wait = $derived(asking ? asideWait(asking, now) : null);
  const waitNote = $derived(
    waiting
      ? "waiting — one aside answers at a time"
      : wait?.kind === "queued"
        ? "waiting for the chat's turn to end — the aside runs after it"
        : null,
  );

  /** Rewind: exchange `i` and the later ones leave; its question goes back
   *  into the aside's box. Undo on the notice. */
  function rewind(index: number): boolean {
    const i = ev.turnOf[index];
    if (i === undefined) return false;
    const before = aside.unsent ?? "";
    const gone = rewindAside(aside, i);
    if (gone.length === 0) return false;
    scheduleAsideSave();
    const after = aside.unsent ?? "";
    const n = gone.length;
    addToast(n === 1 ? "Rewound 1 exchange — the question is back in the box" : `Rewound ${n} exchanges — the question is back in the box`, {
      label: "Undo",
      run: () => {
        if (!restoreAsideTurns(aside, i, gone)) {
          addToast("Not undone — the aside has moved on since");
          return;
        }
        // The box back as it was, if he has not typed since.
        if ((aside.unsent ?? "") === after) setAsideUnsent(aside, before);
        scheduleAsideSave();
      },
    });
    return true;
  }

  /** Exchange `at` and the later ones replaced by `words` with `chips`. */
  async function askInPlace(at: number, words: string, how: string, chips: Attachment[]): Promise<boolean> {
    const t = aside.turns[at];
    if (!t || asideAsking(aside)) return false;
    if (!words && chips.length === 0) return false;
    const gone = rewindAside(aside, at, false);
    if (gone.length === 0) return false;
    const n = gone.length;
    const what = how ? `Asked again ${how}` : "Asked again";
    addToast(n === 1 ? what : `${what} — ${n} exchanges replaced`, {
      label: "Undo",
      run: () => {
        // The new exchange out (stopped if it still runs), the old ones back.
        stopAside(aside);
        aside.turns.splice(at);
        if (!restoreAsideTurns(aside, at, gone)) addToast("Not undone — the aside has moved on since");
        scheduleAsideSave();
      },
    });
    // Not awaited to its end by the caller's editor: the ask is under way.
    void (aside.draft ? askAside(words, aside.quote, aside, { attachments: chips }) : followUpAside(words, aside, { attachments: chips })).then(
      () => scheduleAsideSave(),
    );
    return true;
  }
  const chipsOfTurn = (at: number): Attachment[] =>
    (aside.turns[at]?.attachments ?? []).filter((c) => c.data).map((c) => ({ ...c }));

  /** The edit box's *Ask again*: the edited words and chips in place. */
  async function askEdited(index: number, text: string, chips: Attachment[]): Promise<boolean> {
    const i = ev.turnOf[index];
    if (i === undefined || !open || !onClaudeCode || asking) return false;
    return askInPlace(i, text, "with your edit", chips.filter((c) => c.data).map((c) => ({ ...c })));
  }
  /** The same question asked again (the chat's Redo / Retry; a stalled
   *  exchange's Ask again, item 404, stops it first). */
  async function askAgain(i: number): Promise<void> {
    const t = aside.turns[i];
    if (!t || !open || !onClaudeCode) return;
    stopAside(aside);
    await askInPlace(i, t.question, "", chipsOfTurn(i));
  }

  const source = $derived<TranscriptSource>({
    kind: "aside",
    frame,
    chat: null,
    events: ev.events,
    live,
    // Every arrival stamps `heardAt` (item 404); the text for a turn with
    // no segments.
    liveVersion: () => [asking?.heardAt, asking?.partial.length, asking?.segments?.length],
    approvals: [],
    locked: asking !== null,
    busy: asking !== null,
    scrollKey,
    // The names `AsideThread` kept folds under (item 495), so they hold.
    foldChat: `aside:${aside.uid ?? aside.id}`,
    foldTurn: (turn) => {
      const seq = turn === "live" ? asking?.seq : ev.seqOf[turn];
      return seq === undefined ? null : String(seq);
    },
    runFrom: { chat: owner, aside: aside.id },
    channel: "aside",
    draftKey: asideDraftKey(aside),
    reply: open && !aside.draft,
    cliSession: null,
    liveModel: null,
    chatActions: false,
    actions: {
      rewind,
      askEdited,
      ...(open && onClaudeCode ? { retry: (index: number) => askAgain(ev.turnOf[index] ?? -1) } : {}),
    },
    words: {
      rewindTip:
        "Rewind to here: this exchange and the later ones leave the aside, and the question goes back into its box (Undo on the notice)",
      editTip: "Edit this question and ask it again in place of this exchange and the later ones",
      sendLabel: "Ask again",
      sendTip: "Ask this instead: this exchange and the later ones are replaced (Undo on the notice puts them back)",
      sendBlocked: !open
        ? "Open the chat to ask — an aside answers from its context"
        : !onClaudeCode
          ? "An aside is answered by Claude Code — connect it to ask"
          : null,
      editLine: "Ask again replaces this exchange and the later ones — Undo on the notice puts them back.",
      retryTip: "Ask this question again in place of this answer (Undo on the notice puts it back)",
    },
    notes: ev.notes,
    bare: ev.bare,
    sizes: ev.sizes,
    waitNote,
  });
</script>

<Transcript {source} {lead}>
  {#snippet afterLive()}
    {#if asking && wait?.kind === "stalled" && !waiting}
      <!-- Item 404: silence past ASIDE_STALL_MS is said, with a way on. -->
      <div class="aside-stalled" role="status">
        <span>Nothing has come back for {quietLabel(wait.quietMs)} — Claude Code may be stuck.</span>
        <span class="aside-stalled-row">
          <button
            class="ns-btn small"
            disabled={!open || !onClaudeCode}
            use:tip={"Stop this exchange and ask the same question again (Undo on the notice puts this one back)"}
            onclick={() => void askAgain(aside.turns.length - 1)}>Ask again</button
          >
          <button class="ns-btn ghost small" onclick={() => stopAside(aside)}>Stop</button>
        </span>
      </div>
    {/if}
  {/snippet}
  {#snippet foot()}
    {#if !aside.draft}<AsideFoldPanel {aside} part="panel" {open} />{/if}
  {/snippet}
</Transcript>

<style>
  .aside-stalled {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--dim);
    font-size: 12.5px;
  }
  .aside-stalled-row {
    display: flex;
    gap: 6px;
  }
</style>
