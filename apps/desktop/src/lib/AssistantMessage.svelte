<script lang="ts">
  import { tip } from "./tip";
  // Every Copy button goes through the in-app clipboard ring (backlog 173).
  import { copyText } from "./clipRing.svelte";
  import type { Segment } from "./state.svelte";
  import type { ApprovalRequest, Usage } from "./types";
  // Item 626: while streaming, the unfinished tail renders as it will once finished (streamingTail).
  import { renderReply, streamingTail } from "./markdown";
  import { liveHtml } from "./liveHtml";
  import { codeCopy, type RunBlocks } from "./codeCopy";
  import { handoffGo, type NextChat } from "./handoffButton";
  import { runBlock, type RunFrom } from "./shellRun.svelte";
  import { openAgentTab } from "./terminal.svelte";
  import { isShellCall } from "./agentCommands";
  import CouncilBlocks from "./CouncilBlocks.svelte";
  import BashPassing from "./BashPassing.svelte";
  import { passingEnded } from "./bashOutput.svelte";
  import { parseCouncilRecord, parseCouncilSeat } from "./council";
  import { wordDiff } from "./textdiff";
  import { exactTime, relativeTimeLong } from "./time";
  import { compactJson } from "./toolinput";
  import {
    flipOverride,
    resolveOpen,
    segmentIds,
    toolInputSummary,
    toolResultSummary,
    toolSummary,
    transcript,
    type BlockKind,
    type Override,
  } from "./transcriptPrefs.svelte";
  import {
    HIDDEN_THINKING_TITLE,
    activitySummary,
    groupSegments,
    modelOmitsThinking,
    resolveFolded,
    shortToolName,
    thinkingHidden,
    workingLabel,
  } from "./activity";
  import type { IconName } from "./icons";
  import { fmtShare, fmtTokens, shareOf, sizeTitle, type TurnSize } from "./tokens";
  import {
    artifactLinks,
    displayPath,
    extOf,
    fmtSize,
    noteForPath,
    pathCandidates,
    type ArtifactLink,
  } from "./cards";
  import * as api from "./api";
  import {
    addToast,
    app,
    endContentDrag,
    openContent,
    startContentDrag,
    type SubagentRow,
  } from "./state.svelte";
  import { agentCallContent, agentRowLine, isAgentCall } from "./subagentRows";
  import type { TabContent } from "./tabs";
  import ApprovalPrompt from "./ApprovalPrompt.svelte";
  import AskAnswered from "./AskAnswered.svelte";
  import Icon from "./Icon.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { COPIED_MS } from "./copyIcon";
  import { REMOVED_TEXT_PLACEHOLDER, REMOVED_TOOL_PLACEHOLDER } from "./edit";
  import { removeTip } from "./removeAsk";
  import MemoryHits from "./MemoryHits.svelte";
  import { hitsOfCalls } from "./memoryHits";
  import { isDragMove, sentExt, sentFilesOfCalls, type SentFile } from "./sentFiles";
  import { memoryRefs, openMemoryEdit } from "./memoryOpen";
  import { memoryEditOf, type MemoryEdit } from "./memoryEdits";
  import type { ReplyUsageView } from "./replyUsage";
  import { footerStopNote, hasUsage, isSignedOut, isStandIn } from "./replyFooter";
  import EditDiffView from "./EditDiffView.svelte";
  import { editDiffOf } from "./editDiff";
  import ToolImagesView from "./ToolImagesView.svelte";
  import { namesImage } from "./toolImages.svelte";
  import SignedOutNotice from "./SignedOutNotice.svelte";
  import StillRunningLine from "./StillRunningLine.svelte";
  import MidTurnBubble from "./MidTurnBubble.svelte";
  import RetryLine from "./RetryLine.svelte";
  // The streaming motion (backlog 342, his pick of 338: "Loom + fade-in").
  import { Births, needleIn, needleOut, replyMotion } from "./replyMotion";
  // The thinking block's arrival (backlog 389): a live thinking row's first
  // appearance is thrown in along the send flight's path, not spawned.
  import { thinkingArrival, type ArrivalParams } from "./thinkingArrival";
  // Item 564 (Filament IV stage 5): the turn trace's clock and the stream speed.
  import { untrack } from "svelte";
  // Item 589: the running step's motion, a variant per kind of step.
  import { HELPER_WINDOW, stepMotion, toolKind, type StepKind, type StepMotion } from "./stepMotion.svelte";
  import { SpeedMeter, barOf, fmtSecs, sparkPoints, stepKeys, traceBook, type TraceRecord } from "./turnTiming";
  // Item 495 part 2: the folds kept past a chat switch.
  import { decodeOverride, encodeOverride, foldKey, keptGet, keptOpen, keptSet, type FoldScope } from "./keptFolds.svelte";

  interface Footer {
    model: string;
    usage: Usage;
    stop_reason: string | null;
    cost?: number;
    /** When the reply was recorded — its completion (backlog 123). */
    at?: string;
    /** No figure to show (backlog 283: an aside's answer read back from
     *  the store keeps its words, not its tokens): Copy and the time only. */
    bare?: boolean;
  }

  /** The turn's text segments, for Copy — thinking and tool traffic are not
   *  what anyone means by "copy the reply". */
  function textOf(): string {
    return segs
      .filter((s) => s.kind === "text")
      .map((s) => s.text)
      .join("\n\n");
  }
  let copied = $state(false);
  async function copy(): Promise<void> {
    try {
      await copyText(textOf());
      copied = true;
      setTimeout(() => (copied = false), COPIED_MS);
    } catch {
      // The webview refused the clipboard; nothing to show but the button.
    }
  }
  // The footer says what the reply itself is (backlog 090): its output,
  // and what its tool calls brought back when any did. It used to sum
  // `input + output`, which on both engines is the whole prompt plus the
  // reply — the gauge's figure, near enough, and neither the message nor
  // the total. The prompt's size is still in the title.
  function fmtOut(u: Usage, size: TurnSize | null): string {
    const out = `${u.output_tokens.toLocaleString()} out`;
    return size?.results ? `${out} · ${fmtTokens(size.results)} from tools` : out;
  }
  function footerTitle(f: Footer, size: TurnSize | null): string {
    const base = `${f.usage.input_tokens.toLocaleString()} in (the whole prompt, cached or not) / ${f.usage.output_tokens.toLocaleString()} out${f.stop_reason ? ` · ${f.stop_reason}` : ""}`;
    return size ? `${sizeTitle(size, "assistant", limit)}. ${base}` : base;
  }
  function fmtCost(c: number | undefined): string {
    if (c == null) return "";
    return c > 0 && c < 0.01 ? ` · $${c.toFixed(4)}` : ` · $${c.toFixed(2)}`;
  }
  /**
   * The footer's figure (the design's board 1, 2026-09-16): what the turn
   * added to the window — the reply and what its tools brought back, the
   * same number the bar beside it is a share of — with the reply's own
   * `N out` in the title. Without a size to show, the output count as
   * before.
   */
  function fmtFigure(u: Usage, size: TurnSize | null): string {
    // With its unit: beside the foot's time (backlog 123) a bare "760"
    // and "18 minutes ago" read as one run of numbers (his report).
    return size ? `${fmtTokens(size.tokens)} tokens` : fmtOut(u, null);
  }

  /**
   * The row's icon by the call's name (board 1): the CLI's tools by name,
   * an MCP tool by its prefix, Nightloom's own engine's snake_case tools by
   * what they do; null for anything else, which keeps the ⚒ glyph.
   */
  function toolIcon(name: string): IconName | null {
    if (name.startsWith("mcp__")) return "mcp";
    const n = name.toLowerCase();
    if (n === "agent" || n === "task") return "agent";
    if (n.startsWith("read") || n === "notebookread" || n === "read_chat") return "read";
    if (n.startsWith("grep") || n.startsWith("glob") || n.includes("search")) return "grep";
    if (n.startsWith("edit") || n.startsWith("write") || n === "multiedit" || n === "notebookedit") return "edit";
    if (n === "bash") return "term";
    if (n.includes("fetch")) return "ext";
    return null;
  }

  /**
   * The thinking row's words, three states (boards 1 and 6, backlog 097):
   * `thought for 6 s` once done with a clock; `thought · summary` when the
   * text is the summary the API engine asked for — a model that omits its
   * thinking returned something, so it is that; `thought` for a recorded
   * block with no clock; `thinking` while it streams.
   */
  function thoughtLabel(seg: { done: boolean; ms?: number }): string {
    if (!seg.done) return "thinking";
    if (summarised) return "thought · summary";
    if (seg.ms == null) return "thought";
    const sec = Math.max(1, Math.round(seg.ms / 1000));
    return sec < 60 ? `thought for ${sec} s` : `thought for ${Math.floor(sec / 60)} min ${sec % 60} s`;
  }
  /** A thinking row's size column (item 564): how long it took — the
   *  window's own clock, else the stream's `ms` — or `…` while it runs. */
  function thinkSize(i: number, seg: Segment): string {
    const ms = stepMs(i) ?? (seg.kind === "thinking" ? (seg.ms ?? null) : null);
    if (seg.kind === "thinking" && !seg.done) return ms !== null ? fmtSecs(ms) : "…";
    return ms !== null ? fmtSecs(ms) : "";
  }
  /** The summary's first line, for the row's argument column. */
  function firstLine(text: string): string {
    return text.trim().split(/\n/, 1)[0] ?? "";
  }

  let {
    segs,
    footer = null,
    streaming = false,
    since = null,
    model = null,
    size = null,
    limit = null,
    approvals = [],
    onremove = null,
    onrestore = null,
    controlsTitle = "",
    originals = null,
    diff = false,
    clock = Date.now(),
    headed = true,
    onedit = null,
    onremoveturn = null,
    planUsage = null,
    onretry = null,
    cliSession = null,
    folds = null,
    runFrom = null,
    nextChat = null,
    motion = null,
  }: {
    segs: Segment[];
    footer?: Footer | null;
    streaming?: boolean;
    /** When the live turn was sent (ms since epoch), for the `working · 41 s`
     *  row (backlog 096); absent, the count starts when this mounts. */
    since?: number | null;
    /** The model answering a live turn (item 525), for the header while no
     *  footer says; null draws the header without one. */
    model?: string | null;
    /** What this reply added to the context (backlog 090), null when the
     *  log cannot say; `limit` is the model's window for the share. */
    size?: TurnSize | null;
    limit?: number | null;
    /** Calls in these segments still waiting on the user's decision. */
    approvals?: ApprovalRequest[];
    /** Remove one block of a recorded reply — a tool call with its
     *  result, from the hover on the call (nightshift backlog 066). Given
     *  only when the reply can be edited: recorded, live, not removed, no
     *  turn running. */
    onremove?: ((block: number) => void) | null;
    /** Restore a removed block from its placeholder. Same terms. */
    onrestore?: ((block: number) => void) | null;
    /** What hovering the controls says on this engine. */
    controlsTitle?: string;
    /** Per segment, a text block's words before its edit (nightshift
     *  backlog 105) — `null` where the block was not edited, `""` for one
     *  the edit appended; absent on a reply never edited. */
    originals?: (string | null)[] | null;
    /** Draw each edited block as a diff over its current text rather than
     *  as the rendered text: the transcript's `edited` mark toggles it. */
    diff?: boolean;
    /** The transcript's clock (ms since epoch), ticking while the chat is
     *  open, so the footer's `37 minutes ago` keeps up (backlog 123). */
    clock?: number;
    /** Draw the model header. False for a reply that continues the one
     *  before it (nightshift backlog 121): same model, nothing between —
     *  one header for the run, the blocks back to back. */
    headed?: boolean;
    /** Edit this reply in place, from the pencil in the footer row (the
     *  transcript's `beginEdit`); null when the reply cannot be edited. */
    onedit?: (() => void) | null;
    /** This reply's share of the plan's five-hour window and week (item
     *  323), on the turn's last reply; null when no readings say. */
    planUsage?: ReplyUsageView | null;
    /** Remove this whole reply from the context, from the footer row;
     *  null when the turn cannot be acted on. */
    onremoveturn?: (() => void) | null;
    /** Run this reply's prompt again in a fork from it (item 333), on a
     *  turn's last reply; null where Retry is not offered. */
    onretry?: (() => void) | null;
    /** The chat's Claude Code session id, where a tool result's images are
     *  read from (backlog 434); null draws none. */
    cliSession?: string | null;
    /** Where this reply's folds are kept (item 495 part 2): its chat and
     *  turn, so a thinking block, tool call, block, subagent group or diff
     *  he opened or closed is drawn so again after a chat switch. Null:
     *  this component's own, as before (gone with the message). */
    folds?: FoldScope | null;
    /** The chat, and the aside, this reply was drawn in (item 503): a shell
     *  block's Run and a shell call's way to Agent commands go by it. Null: a
     *  surface with no terminal to send to. */
    runFrom?: RunFrom | null;
    /** Item 506: this is the chat's latest reply and it holds a next-chat
     *  prompt; only the main transcript passes it. */
    nextChat?: NextChat | null;
    /** Item 610: the running step's motion for this reply's trace; null
     *  follows the setting (Settings → Animations). Settings' previews pass
     *  one each. */
    motion?: StepMotion | null;
  } = $props();

  function runBlocks(text: string): RunBlocks | null {
    // `runFrom` is read at the click: this element may be drawing another chat by then.
    return runFrom ? { text, streaming, onRun: (command) => runFrom && void runBlock(command, runFrom) } : null;
  }

  // Per-block clicks, keyed by the block's stable id (`segmentIds`) rather
  // than its index, and consulted before the streaming rule and the two
  // transcript-wide toggles (`resolveOpen`, nightshift backlog 052): a click
  // on a block always wins over its default. The map is this component's,
  // so it lives as long as the message on screen does. An activity block's
  // fold line (backlog 096) keeps its click here too, under `block:<id>`.
  // ~~The map is this component's, so it lives as long as the message on
  // screen does~~ — since item 495 part 2 (2026-11-02) a reply with `folds`
  // reads and writes them in `keptFolds` (session only), so a chat switch,
  // or the live reply giving way to the recorded one, keeps every click;
  // `local` is the map for a reply with nowhere to keep them.
  let local = $state<Record<string, Override>>({});
  const ids = $derived(segmentIds(segs));
  // The reply as the transcript draws it: runs of thinking and tool calls
  // as one activity block each, everything else on its own (backlog 096).
  const groups = $derived(groupSegments(segs, ids));
  const overrides = $derived.by<Record<string, Override>>(() => {
    const scope = folds;
    if (!scope) return local;
    const out: Record<string, Override> = {};
    const keys = [...ids.filter(Boolean), ...groups.flatMap((g) => (g.kind === "activity" ? [g.key] : []))];
    for (const id of keys) {
      const o = decodeOverride(keptGet(foldKey(scope, id), ""));
      if (o) out[id] = o;
    }
    return out;
  });
  function setOverride(id: string, o: Override): void {
    if (folds) keptSet(foldKey(folds, id), encodeOverride(o), "");
    else local[id] = o;
  }
  /** A native fold's kept key (a subagent group, a removed block), or null. */
  function detailsKey(id: string): string | null {
    return folds ? foldKey(folds, id) : null;
  }
  // Nightloom's own stand-in for a turn with no reply (backlog 407): drawn
  // as its notice under a "Nightloom" header, never as the model's prose.
  const standIn = $derived(
    segs.length === 1 && segs[0].kind === "text" && isStandIn([segs[0].text], footer?.stop_reason),
  );

  function kindOf(seg: Segment): BlockKind {
    return seg.kind === "thinking" ? "thinking" : "tool";
  }
  function doneOf(seg: Segment): boolean {
    if (seg.kind === "thinking") return seg.done;
    if (seg.kind === "tool") return seg.call.result !== null;
    return true;
  }
  function isOpen(i: number, seg: Segment): boolean {
    return resolveOpen(kindOf(seg), ids[i], streaming, doneOf(seg), overrides, transcript);
  }
  function toggle(i: number, seg: Segment): void {
    setOverride(ids[i], flipOverride(
      kindOf(seg),
      ids[i],
      streaming,
      doneOf(seg),
      overrides,
      transcript,
    ));
  }
  function isFolded(key: string): boolean {
    return resolveFolded(key, streaming, overrides, transcript);
  }
  function toggleFold(key: string): void {
    setOverride(key, { open: isFolded(key), rev: transcript.rev.tool });
  }

  // Toggled on pointerdown, not click. While a reply streams the transcript
  // stays pinned to its foot and every delta pushes the pill up the page,
  // so between the press and the release the pointer is over something
  // else and no `click` reaches the button — which is what "clicking a
  // thinking tag mid-reply does nothing" looks like (backlog 052). The
  // press is a single instant and cannot be split. `click` is kept for the
  // keyboard, where `detail` is 0; a pointer's click has already been
  // handled at its press.
  function press(e: PointerEvent, i: number, seg: Segment): void {
    if (e.button !== 0) return;
    toggle(i, seg);
  }
  function keyClick(e: MouseEvent, i: number, seg: Segment): void {
    if (e.detail === 0) toggle(i, seg);
  }
  // The Agent call's row as a drag source (nightshift backlog 160): the
  // transcript on screen is the open chat's, so its id names the tab.
  function agentTabOf(call: { id: string; name: string; input: unknown }) {
    if (!isAgentCall(call.name) || !app.activeSessionId) return null;
    return agentCallContent(app.activeSessionId, call);
  }
  function rowOf(id: string): SubagentRow | null {
    return app.subagents.find((r) => r.tool_use_id === id) ?? null;
  }
  /** Item 616: a helper's context so far (its latest round's request and
   *  response, the CLI's `total_tokens`), or null when it is not a helper
   *  or nothing has been reported yet — then its bar stays today's. */
  function helperContext(call: { id: string; name: string }): number | null {
    if (!isAgentCall(call.name)) return null;
    const r = rowOf(call.id);
    return r && r.tokens > 0 ? r.tokens : null;
  }
  /** The press already flipped the row (the toggle is on pointerdown, for
   *  the streaming reason above); a press that turns into a drag was not a
   *  click, so the flip is undone as the drag starts. */
  function dragAgent(e: DragEvent, i: number, seg: Segment, content: TabContent): void {
    toggle(i, seg);
    startContentDrag(e, content);
  }

  function pressFold(e: PointerEvent, key: string): void {
    if (e.button !== 0) return;
    toggleFold(key);
  }
  function keyFold(e: MouseEvent, key: string): void {
    if (e.detail === 0) toggleFold(key);
  }

  // The moon stays for the whole live turn (backlog 096): the waiting row
  // of backlog 049 covers send-to-first-token, and from the first token on
  // this message's last row is the moon with `working · 41 s`, counted
  // from when the turn was sent. Inside the last activity block when the
  // reply's last segment is in one, else a row of its own under the text.
  // Gone the moment `streaming` drops.
  let now = $state(Date.now());
  const startedAt = Date.now();
  $effect(() => {
    if (!streaming) return;
    now = Date.now();
    // His ask 2026-11-11: a running step's time counts in tenths ("7.0 s"
    // stood still for a second at a time), so the live clock ticks every 0.1 s.
    const t = setInterval(() => (now = Date.now()), 100);
    return () => clearInterval(t);
  });
  const working = $derived(workingLabel(now - (since ?? startedAt)));

  // ---- The turn trace (item 564, Filament IV stage 5) ----------------------
  // Each step (a thinking block, a call) is a numbered row with a status mark
  // and a bar: where in the turn it started and how long it ran. The times
  // are the window's own (`traceBook`, turnTiming.ts): stamped while the turn
  // streams and kept for the session, so the recorded reply that replaces the
  // live one keeps its bars; a reply read back after a relaunch has none.
  const stepKey = $derived(stepKeys(segs));
  // Each step's number in the reply, 1-based, in the order it happened.
  const stepNo = $derived.by(() => {
    const out: number[] = [];
    let n = 0;
    stepKey.forEach((k, i) => (out[i] = k === null ? 0 : ++n));
    return out;
  });
  let traceRev = $state(0);
  let liveRec: TraceRecord | null = null;
  let firstLook = true;
  // What the effect reads so it runs again on every change that matters: a
  // step's arrival, its end, a delta of words or thinking.
  function shape(): string {
    return segs
      .map((s) =>
        s.kind === "tool"
          ? `t${s.call.result || s.call.denied ? 1 : 0}`
          : s.kind === "thinking"
            ? `k${s.done ? 1 : 0}${s.text.length}`
            : s.kind === "text"
              ? `x${s.text.length}`
              : s.kind[0],
      )
      .join(",");
  }
  $effect(() => {
    if (!streaming) return;
    void shape();
    const at = Date.now();
    liveRec ??= traceBook.find(segs) ?? { t0: since ?? at, t1: null, steps: {}, tps: null };
    // A reply first seen well into its turn (a chat opened mid-turn): steps
    // already done then have no honest start and draw no bar.
    const fresh = firstLook && segs.length > 0 && at - (since ?? at) > 2000;
    firstLook = false;
    traceBook.observe(liveRec, segs, at, fresh);
    // Untracked: the effect must not depend on the counter it bumps.
    untrack(() => traceRev++);
  });
  // The turn ended under this reply: steps still open end with it.
  $effect(() => {
    if (streaming || !liveRec) return;
    traceBook.close(liveRec);
    untrack(() => traceRev++);
  });
  const traceRec = $derived.by<TraceRecord | null>(() => {
    void traceRev;
    if (streaming) return liveRec;
    const r = liveRec ?? traceBook.find(segs);
    return r;
  });
  /** The turn's span so far: to now while live, to its end once done. */
  function traceEnd(r: TraceRecord): number {
    return streaming ? now : (r.t1 ?? r.seen ?? now);
  }
  function barFor(i: number): { left: number; width: number } | null {
    void traceRev;
    const r = traceRec;
    const k = stepKey[i];
    if (!r || !k) return null;
    return barOf(r.steps[k], r.t0, traceEnd(r));
  }
  /** A step's own time, for its title and a thinking row's size column. */
  function stepMs(i: number): number | null {
    void traceRev;
    const r = traceRec;
    const k = stepKey[i];
    const st = r && k ? r.steps[k] : undefined;
    if (!st) return null;
    // A step stamped since the last tick reads from the clock, not below zero.
    return (st.end ?? Math.max(now, Date.now())) - st.start;
  }
  function barTitle(i: number): string {
    const r = traceRec;
    const k = stepKey[i];
    const st = r && k ? r.steps[k] : undefined;
    if (!r || !st) return "";
    const ran = fmtSecs((st.end ?? now) - st.start);
    return `Started ${fmtSecs(st.start - r.t0)} into the turn; ${st.end === null ? "running for" : "took"} ${ran}`;
  }
  /** Any step in this block has a time: else its bar column is left out. */
  function timed(rows: readonly { i: number }[]): boolean {
    void traceRev;
    const r = traceRec;
    return !!r && rows.some(({ i }) => !!stepKey[i] && !!r.steps[stepKey[i]!]);
  }
  /** The trace's foot: how many steps, how long the turn has run. */
  function traceFoot(rows: readonly { i: number }[]): { steps: string; elapsed: string | null } {
    const n = rows.length;
    const r = traceRec;
    return {
      steps: `${n} step${n === 1 ? "" : "s"}`,
      elapsed: r ? fmtSecs(traceEnd(r) - r.t0) : null,
    };
  }

  // ---- Stream speed (item 564): "~38 tok/s" in the header while live -------
  // Estimated from the characters streamed (turnTiming.ts says why), sampled
  // once a second; the sparkline is the last 24 seconds.
  const meter = new SpeedMeter();
  let speed = $state<number | null>(null);
  let spark = $state("");
  function streamedChars(): number {
    let n = 0;
    for (const s of segs) if (s.kind === "text" || s.kind === "thinking") n += s.text.length;
    return n;
  }
  $effect(() => {
    if (!streaming) return;
    // Untracked: a delta must not restart the once-a-second clock.
    untrack(() => meter.sample(streamedChars()));
    const t = setInterval(() => {
      meter.sample(streamedChars());
      speed = meter.rate();
      spark = sparkPoints(meter.samples, 64, 14);
      if (liveRec && speed !== null) liveRec.tps = speed;
    }, 1000);
    return () => clearInterval(t);
  });
  const SPEED_TITLE =
    "Stream speed, estimated: the characters the reply has streamed, at about four to a token, over the seconds it was streaming. Thinking the model keeps to itself is not counted.";
  // The header (item 525, Filament IV): who is answering, and while the turn
  // is live "Replying m:ss" in the signal colour. A Claude model reads
  // "Claude" and its family and version ("Opus 5.5"); any other model reads
  // as its own id.
  const who = $derived.by(() => {
    if (standIn) return { name: "Nightloom", model: "" };
    const m = footer?.model ?? model ?? "";
    const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
    if (x) return { name: "Claude", model: `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` };
    return m.startsWith("claude") || !m ? { name: "Claude", model: m.replace(/^claude-?/, "") } : { name: m, model: "" };
  });
  const replyClock = $derived.by(() => {
    const t = Math.max(0, Math.floor((now - (since ?? startedAt)) / 1000));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  });
  // Rows born live (first seen after this message's first render, mid-turn)
  // get the needle and the weft (backlog 342); a reply drawn again keeps its
  // finished rows still.
  const births = new Births();
  $effect(() => {
    births.settled = true;
  });
  const summarised = $derived(!!footer && modelOmitsThinking(footer.model));
  // The block the moon rides is the last one, whether or not text follows
  // it (board 1 draws the moon as the block's last row with the reply's
  // words under it); with no block yet it sits under the text alone.
  const lastGroup = $derived([...groups].reverse().find((g) => g.kind === "activity"));
  const moonInBlock = $derived(streaming && !!lastGroup);
  // A block whose first row is a live thinking is that thinking's arrival
  // (backlog 389): the whole block — its box, fold line and row — comes in.
  function blockArrival(rows: readonly { seg: Segment }[]): ArrivalParams {
    const s = rows[0]?.seg;
    return s?.kind === "thinking" ? { at: s.at, live: streaming && !s.done } : { live: false };
  }
  const moonAlone = $derived(streaming && segs.length > 0 && !moonInBlock);

  // The cards under the reply (backlog 078): an artifact the model published
  // and a file it wrote, read out of the reply's text once it has stopped
  // streaming — a path half-typed mid-stream is not a file yet. The links
  // are a pure function of the text; the files are whatever the backend
  // finds on disk among the candidates, so a path the model made up stays
  // text. Run once per finished reply: a recorded reply's text never changes.
  interface FileCard {
    path: string;
    label: string;
    size: number;
  }
  const roots = $derived(
    [app.connection?.workspace, app.project?.root].filter((r): r is string => !!r),
  );
  const replyText = $derived(textOf());
  // `memory_where` hits (backlog 296): every place the turn's calls found,
  // drawn under the reply as links with Strike, and the reply's own
  // `path:line` references linked to them. Once the reply has stopped.
  const memGroups = $derived(
    streaming ? [] : hitsOfCalls(segs.flatMap((s) => (s.kind === "tool" ? [s.call] : []))),
  );
  const memHits = $derived(memGroups.flatMap((g) => g.hits));
  // Files the reply sent (backlog 343): every `send_file` result in the
  // turn, as a chip under the reply — from the recorded results, so a
  // reload draws them again; live too, as soon as a call answers.
  const sent = $derived(sentFilesOfCalls(segs.flatMap((s) => (s.kind === "tool" ? [s.call] : []))));
  async function openSent(f: SentFile): Promise<void> {
    try {
      await api.openFile(f.path);
    } catch (e) {
      addToast(`Could not open: ${String(e)}`);
    }
  }
  async function saveSent(f: SentFile): Promise<void> {
    try {
      const to = await api.saveSentFile(f.path);
      if (to) addToast(`Saved ${f.name}`);
    } catch (e) {
      addToast(`Could not save: ${String(e)}`);
    }
  }
  // The drag out: the page sees the press and the move, the backend starts
  // a native file drag (the webview cannot hand AppKit a file itself).
  let pressed: { x: number; y: number; f: SentFile } | null = null;
  function sentDown(e: PointerEvent, f: SentFile): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    pressed = { x: e.clientX, y: e.clientY, f };
  }
  function sentMove(e: PointerEvent): void {
    if (!pressed || (e.buttons & 1) === 0) {
      pressed = null;
      return;
    }
    if (!isDragMove(pressed, { x: e.clientX, y: e.clientY })) return;
    const f = pressed.f;
    pressed = null;
    void api.dragSentFile(f.path).catch((err) => addToast(`Could not drag the file: ${String(err)}`));
  }
  // Memory edits (backlog 305), per activity block: the API engine's
  // relative paths resolve against the chat's workspace.
  function memEditsOf(rows: { seg: Segment }[]): MemoryEdit[] {
    const ws = app.connection?.workspace ?? app.project?.root ?? null;
    const out: MemoryEdit[] = [];
    for (const { seg } of rows) {
      if (seg.kind !== "tool") continue;
      const ed = memoryEditOf(seg.call, ws);
      if (ed) out.push(ed);
    }
    return out;
  }
  const links = $derived<ArtifactLink[]>(streaming ? [] : artifactLinks(replyText));
  let files = $state<FileCard[]>([]);
  let checked = "";
  $effect(() => {
    if (streaming) return;
    const text = replyText;
    const bases = roots;
    const key = `${bases.join("\0")}\0${text}`;
    if (key === checked) return;
    checked = key;
    const candidates = pathCandidates(text, bases);
    if (candidates.length === 0) {
      files = [];
      return;
    }
    let stale = false;
    void api
      .namedFiles(candidates.map((c) => c.path))
      .then((found) => {
        if (stale) return;
        // A memory file the hits below already link is not a second card.
        const mem = new Set(memHits.map((h) => h.path));
        files = found.flatMap((f) =>
          f && !mem.has(f.path) ? [{ path: f.path, label: displayPath(f.path, bases), size: f.size }] : [],
        );
      })
      .catch(() => {
        // The backend could not look; nothing to draw, nothing to say.
        if (!stale) files = [];
      });
    return () => {
      stale = true;
    };
  });
  async function openLink(url: string): Promise<void> {
    try {
      await api.openUrl(url);
    } catch (e) {
      addToast(`Could not open the link: ${String(e)}`);
    }
  }
  /**
   * The card's Open (nightshift backlog 161): the file as a tab inside
   * Nightloom — a note under the notes folder or the vault in the note view
   * itself, anything else read-only in a file tab. The backend reads it
   * first: a refusal (outside the chat's folders and not written by its
   * tools) is a toast in its words and no tab; a kind the tab cannot draw
   * goes to its own application, as Open always did. ⌘-click (Ctrl-click
   * elsewhere) keeps the system's opener — blocker 205's refusals still
   * apply there.
   */
  async function openFile(path: string, e?: MouseEvent): Promise<void> {
    if (e && (e.metaKey || e.ctrlKey)) {
      await openWithApp(path);
      return;
    }
    const note = noteForPath(path, { project: app.project?.notes_dir, knowledge: app.knowledge?.dir });
    if (note) {
      await openContent({ kind: "note", ...note });
      return;
    }
    const chat = app.activeSessionId;
    try {
      const f = await api.readFileTab(path, chat);
      if (f.kind === "other") {
        await openWithApp(path);
        return;
      }
      await openContent(chat ? { kind: "file", path, session: chat } : { kind: "file", path });
    } catch (err) {
      addToast(String(err));
    }
  }
  async function openWithApp(path: string): Promise<void> {
    try {
      await api.openFile(path);
    } catch (e) {
      addToast(`Could not open: ${String(e)}`);
    }
  }
  async function revealFile(path: string): Promise<void> {
    try {
      await api.revealFile(path);
    } catch (e) {
      addToast(`Could not reveal: ${String(e)}`);
    }
  }
</script>

<!-- Item 564: a trace row's number and status mark (done ✓, running ■,
     error ✕, denied ⊘), as in the mockup: no tool icon, the name says it. -->
{#snippet stepHead(i: number, st: "done" | "running" | "error" | "denied", kind: StepKind | null = null)}
  <span class="no" aria-hidden="true">{String(stepNo[i]).padStart(2, "0")}</span>
  <!-- Item 616: a running step's mark under Combo and Reticle is a small
       live instrument per kind (.st-ico); Sweep keeps the ■ (.st-sq). -->
  <span class="st st-{st}" aria-label={st}>{#if st === "done"}✓{:else if st === "running"}<span class="st-sq">■</span>{#if kind}<span class="st-ico k-{kind}" aria-hidden="true">{@render markIcon(kind)}</span>{/if}{:else if st === "error"}✕{:else}⊘{/if}</span>
{/snippet}
<!-- Item 616: Reticle's instruments (616-demo/combo.html, card A): two
     counter-turning rings round a beating core (thinking), a page with a
     scan line (a file), a prompt with a blinking cursor (a command), a radar
     sweep with blips (the web), a hub with three satellites (a helper), one
     turning ring (the rest). -->
{#snippet markIcon(kind: StepKind)}
  {#if kind === "think"}
    <svg viewBox="0 0 18 18"><circle class="ring r1" cx="9" cy="9" r="7.5" /><circle class="ring r2" cx="9" cy="9" r="4.6" /><circle class="core" cx="9" cy="9" r="2" /></svg>
  {:else if kind === "file"}
    <svg viewBox="0 0 18 18"><path class="ring" d="M4 2 H11 L14 5 V16 H4 Z" /><line class="scanl" x1="5.5" x2="12.5" y1="9" y2="9" /></svg>
  {:else if kind === "shell"}
    <svg viewBox="0 0 18 18"><path class="ring" d="M2.5 4.5 L7 9 L2.5 13.5" /><rect class="cursor" x="9" y="11.5" width="6.5" height="2.5" /></svg>
  {:else if kind === "web"}
    <span class="radar"></span><span class="blip b1"></span><span class="blip b2"></span>
  {:else if kind === "agent"}
    <span class="hub"></span><span class="orbit o1"><b></b></span><span class="orbit o2"><b></b></span><span class="orbit o3"><b></b></span>
  {:else}
    <svg viewBox="0 0 18 18"><circle class="ring r1" cx="9" cy="9" r="7" /><circle class="core" cx="9" cy="9" r="2" /></svg>
  {/if}
{/snippet}
<!-- Item 564: the step's bar — its place in the turn — on a hairline track. -->
{#snippet stepBar(i: number, st: "done" | "running" | "error", ctx: number | null = null)}
  {@const b = barFor(i)}
  <span class="tbar" class:has-ctx={ctx !== null} use:tip={barTitle(i)}>
    {#if b}<i class="tbar-{st}" style:left="{b.left * 100}%" style:width="{b.width * 100}%"></i>{/if}
    {#if ctx !== null}
      <!-- Item 616 (Combo): a running helper's bar is its context out of
           300k — the subagent's latest round, request and response, as the
           CLI reports it (SubagentRow.tokens). Drawn by scale, not width. -->
      <i class="tbar-ctx" style:transform="scaleX({Math.min(1, ctx / HELPER_WINDOW)})"></i>
      <span class="ctx-lbl">context {fmtTokens(ctx)} / {fmtTokens(HELPER_WINDOW)} · {Math.round((ctx / HELPER_WINDOW) * 100)}%</span>
    {/if}
  </span>
{/snippet}

<!-- Item 589: a running step's live parts — faint threads behind the row
     (drawn only under the Weave choice) and the thread under it, whose light
     runs a little differently per kind. The shell's thread is today's weft
     (its ::after shuttle), so it carries no children. -->
{#snippet stepLive(kind: StepKind, threads: boolean)}
  <!-- Item 616: Combo's and Reticle's parts, drawn only under their choice —
       the faint tint, the [ ] brackets, the light round the edge (Combo),
       the data bus with its packets (Reticle). -->
  <span class="mo-bg k-{kind}" aria-hidden="true"></span>
  <span class="mo-tex k-{kind}" aria-hidden="true"></span>
  <span class="mo-brk" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
  <svg class="mo-edge" aria-hidden="true"><rect class="e-tail" width="100%" height="100%" rx="6" pathLength="100" /><rect class="e-head" width="100%" height="100%" rx="6" pathLength="100" /></svg>
  <span class="mo-bus k-{kind}" aria-hidden="true"><i></i><i></i><i></i></span>
  {#if threads}
    <span class="rm-weft mo-weft k-{kind}" aria-hidden="true">{#if kind !== "shell"}<i></i><i></i><i></i>{/if}</span>
  {/if}
{/snippet}

{#snippet subagent(children: Segment[], parent: string)}
  {@const calls = children.filter((c) => c.kind === "tool").length}
  {@const names = children
    .filter((c) => c.kind === "tool")
    .map((c) => (c.kind === "tool" ? shortToolName(c.call.name) : ""))
    .slice(0, 4)
    .join(", ")}
  {@const words = children
    .filter((c) => c.kind === "text")
    .reduce((n, c) => n + (c.kind === "text" ? c.text.split(/\s+/).filter(Boolean).length : 0), 0)}
  <!-- Kept by the spawning call's id (item 495 part 2). -->
  <details class="sub" use:keptOpen={{ key: detailsKey(`tool:${parent}:sub`) }}>
    <summary class="sub-line">
      <span class="ico">▸</span>
      <span class="name">subagent</span>
      <span class="arg">
        <!-- Keyed on the counts so a change flashes accent under a live row (backlog 342). -->
        {#key `${calls}:${words}`}<span class="rm-count">{#if names}{names}{calls > 4 ? ", …" : ""}{" · "}{/if}{#if calls}{calls} call{calls === 1 ? "" : "s"}{/if}{#if calls && words}{" · "}{/if}{#if words}{words} words{streaming ? " so far" : ""}{/if}</span>{/key}
      </span>
    </summary>
    <div class="sub-body">
      {#each children as c, k (k)}
        {#if c.kind === "tool"}
          {@const icon = toolIcon(c.call.name)}
          {@const childDiff = editDiffOf(c.call.name, c.call.input)}
          {@const childShell = toolKind(c.call.name) === "shell"}
          {@const childRun = childShell && streaming && !c.call.result && !c.call.denied}
          {@const childRem = childShell && !childRun && passingEnded(c.call.id)}
          <div class="arow static" class:error={!!c.call.result?.is_error} class:sub-pass={childRun || childRem}>
            <!-- Item 649: a subagent's command passes its output too. -->
            {#if childRun || childRem}<BashPassing id={c.call.id} ended={childRem} />{/if}
            <span class="ico">{#if icon}<Icon name={icon} size={13} />{:else}⚒{/if}</span>
            <span class="name" use:tip={c.call.name}>{shortToolName(c.call.name)}</span>
            <span class="arg">{toolInputSummary(c.call.input)}</span>
            <span class="size">{toolResultSummary(c.call, streaming)}</span>
          </div>
          {#if childDiff}
            <!-- A subagent's edit as a diff too (backlog 433). -->
            <EditDiffView diff={childDiff} denied={!!c.call.denied} keep={detailsKey(`tool:${c.call.id}:diff`)} />
          {/if}
          {#if !c.call.denied && namesImage(c.call.result?.content)}
            <!-- A subagent's screenshot too (item 476): read from its own
                 file under the session's subagents/ folder. -->
            <ToolImagesView session={cliSession} id={c.call.id} name={shortToolName(c.call.name)} />
          {/if}
          {#if c.call.children?.length}
            {@render subagent(c.call.children, c.call.id)}
          {/if}
        {:else if c.kind === "thinking"}
          <div class="arow static thinking">
            <span class="ico"><Icon name="think" size={13} /></span>
            <span class="name">thought</span>
            <span class="arg">{c.text}</span>
            <span class="size"></span>
          </div>
        {:else if c.kind === "redacted"}
          <div class="arow static thinking">
            <span class="ico"><Icon name="think" size={13} /></span>
            <span class="name">redacted thinking</span>
            <span class="arg"></span>
            <span class="size"></span>
          </div>
        {:else if c.kind === "text"}
          <pre class="sub-text">{c.text}</pre>
        {/if}
      {/each}
    </div>
  </details>
{/snippet}


<div class="assistant" use:replyMotion={streaming}>
  {#if headed && (footer || streaming)}
    <div class="who" class:live={streaming} use:tip={footer && !standIn ? footer.model : undefined}>
      <span class="who-ring" aria-hidden="true"></span>
      <b>{who.name}</b>
      {#if who.model}<span class="who-model">{who.model}</span>{/if}
      {#if streaming}<span aria-hidden="true">·</span><span class="who-live">Replying <span class="who-clock">{replyClock}</span></span>{/if}
      {#if streaming && speed !== null}
        <!-- Item 564: the stream speed, redrawn once a second. -->
        <span class="who-speed" use:tip={SPEED_TITLE}>
          {#if spark}<svg class="who-spark" width="64" height="14" viewBox="0 0 64 14" aria-hidden="true"><polyline points={spark} /></svg>{/if}
          <span class="who-tps">~{Math.round(speed)} tok/s</span>
        </span>
      {/if}
    </div>
  {/if}
  {#each groups as g (g.kind === "activity" ? g.key : `one:${g.i}`)}
    {#if g.kind === "activity"}
      {@const folded = isFolded(g.key)}
      {@const last = moonInBlock && g === lastGroup}
      <!-- One block for the run: a left rule, accent while the turn is
           live; a summary line that folds and unfolds the rows; the rows
           on one grid — icon · name · argument · size (backlog 096). -->
      {@const isTimed = timed(g.rows)}
      {@const foot = traceFoot(g.rows)}
      <!-- Item 564 (Filament IV stage 5): the block is the turn's trace —
           numbered steps, a status mark, a bar for each step's place in the
           turn, and a foot that says how many steps and how long, with the
           fold. Bars only where the window timed the steps (this session). -->
      <div class="activity trace" class:live={streaming} class:timed={isTimed} data-motion={motion ?? stepMotion.value} use:thinkingArrival={blockArrival(g.rows)}>
        {#if !folded}
          {#each g.rows as { seg, i } (ids[i] || i)}
            {#if seg.kind === "thinking"}
              {#if thinkingHidden(seg)}
                <!-- The model thought and returned nothing of it (backlog
                     097): a fact in the dim style, no pointer, nothing to
                     open — a button here did nothing, which is what he
                     saw. -->
                <div class="arow static thinking hidden" use:tip={HIDDEN_THINKING_TITLE}>
                  {@render stepHead(i, "done")}
                  <span class="name">Thought</span>
                  <span class="arg">hidden by the model</span>
                  {@render stepBar(i, "done")}
                  <span class="size">{thinkSize(i, seg)}</span>
                </div>
              {:else if !seg.done && seg.text.trim() === ""}
                <!-- Begun, nothing arrived yet: under way, not yet a button.
                     A thinking later in a block arrives on its own row (389). -->
                <div
                  class="arow static thinking"
                  class:mo-run={streaming}
                  data-kind="think"
                  use:thinkingArrival={{ at: seg.at, live: streaming && g.rows[0].i !== i }}
                >
                  {#if streaming}{@render stepLive("think", true)}{/if}
                  {@render stepHead(i, "running", "think")}
                  <span class="name">Thinking</span>
                  <span class="arg"></span>
                  {@render stepBar(i, "running")}
                  <span class="size">{thinkSize(i, seg)}</span>
                </div>
              {:else}
                {@const summary = summarised && seg.done}
                {@const bornT = births.of(ids[i] || `think:${i}`, streaming, seg.done)}
                <!-- The needle (backlog 342): a live block's margin thread is
                     accent with a glowing needle at its newest line; on done
                     the thread retracts and the icon turns once. -->
                <div class="row-wrap" class:rm-live={streaming && !seg.done} class:rm-thought={bornT && seg.done}
                  class:mo-run={streaming && !seg.done} data-kind="think"
                  use:thinkingArrival={{ at: seg.at, live: streaming && !seg.done && g.rows[0].i !== i }}>
                  {#if streaming && !seg.done}{@render stepLive("think", true)}{/if}
                  <button
                    class="arow thinking"
                    aria-expanded={isOpen(i, seg)}
                    use:tip={isOpen(i, seg) ? "Hide the thinking" : "Show the thinking"}
                    onpointerdown={(e) => press(e, i, seg)}
                    onclick={(e) => keyClick(e, i, seg)}
                  >
                    {@render stepHead(i, seg.done ? "done" : "running", "think")}
                    <span class="name" use:tip={thoughtLabel(seg)}>{seg.done ? "Thought" : "Thinking"}</span>
                    <span class="arg" class:summary>{firstLine(seg.text)}</span>
                    {@render stepBar(i, seg.done ? "done" : "running")}
                    <span class="size">{thinkSize(i, seg)} <span class="open-mark">{isOpen(i, seg) ? "▾" : "▸"}</span></span>
                  </button>
                  {#if isOpen(i, seg)}
                    <div
                      class="thinking-text"
                      in:needleIn|global={{ on: births.settled }}
                      out:needleOut={{ on: births.settled }}
                    >{seg.text}</div>
                  {/if}
                </div>
              {/if}
            {:else if seg.kind === "redacted"}
              <div class="arow static thinking">
                {@render stepHead(i, "done")}
                <span class="name">Thought</span>
                <span class="arg">redacted</span>
                {@render stepBar(i, "done")}
                <span class="size">{thinkSize(i, seg)}</span>
              </div>
            {:else if seg.kind === "tool"}
              {@const open = isOpen(i, seg)}
              {@const bad = !!seg.call.result?.is_error || !!seg.call.denied}
              {@const agentTab = agentTabOf(seg.call)}
              {@const agentRow = agentTab ? rowOf(seg.call.id) : null}
              {@const running = streaming && !seg.call.result && !seg.call.denied}
              {@const bornW = births.of(ids[i] || `tool:${i}`, streaming, !running)}
              {@const editDiff = editDiffOf(seg.call.name, seg.call.input)}
              {@const kind = toolKind(seg.call.name)}
              {@const remnant = !running && kind === "shell" && passingEnded(seg.call.id)}
              <div class="row-wrap tool" class:running class:rm-born={bornW} class:rm-finished={bornW && !running}
                class:mo-run={running} class:bash-rem={remnant} data-kind={kind}>
                {#if running}{@render stepLive(kind, false)}{/if}
                <!-- Item 633: the command's real output passing behind the row. -->
                {#if running && kind === "shell"}<BashPassing id={seg.call.id} />{/if}
                <!-- Item 649: and its last lines a moment after it ends, fading. -->
                {#if remnant}<BashPassing id={seg.call.id} ended />{/if}
                <!-- An Agent call's row is a drag source (backlog 160): its
                     subagent's transcript as a tab, dropped on a strip or a
                     pane's half — live while it runs (guess pass 2026-09-25,
                     question 19). -->
                <button
                  class="arow"
                  class:error={bad}
                  class:agent-drag={!!agentTab}
                  aria-expanded={open}
                  use:tip={agentTab
                    ? `${open ? "Collapse to one line" : "Expand this call"} — drag onto a tab strip to open the agent's transcript as a tab`
                    : open
                      ? "Collapse to one line"
                      : "Expand this call"}
                  draggable={agentTab ? "true" : undefined}
                  ondragstart={agentTab ? (e) => dragAgent(e, i, seg, agentTab) : undefined}
                  ondragend={agentTab ? () => endContentDrag() : undefined}
                  onpointerdown={(e) => press(e, i, seg)}
                  onclick={(e) => keyClick(e, i, seg)}
                >
                  {@render stepHead(i, running ? "running" : seg.call.denied ? "denied" : bad ? "error" : "done", kind)}
                  <span class="name" use:tip={seg.call.name}>{shortToolName(seg.call.name)}</span>
                  <span class="arg">{toolInputSummary(seg.call.input)}</span>
                  {@render stepBar(i, running ? "running" : bad ? "error" : "done", running ? helperContext(seg.call) : null)}
                  <span class="size" use:tip={agentRow ? `${seg.call.name} call · ${toolResultSummary(seg.call, streaming)}` : undefined}
                    >{agentRow ? agentRowLine(agentRow) : running && stepMs(i) !== null ? `running ${fmtSecs(stepMs(i)!)}` : toolResultSummary(seg.call, streaming)}</span
                  >
                </button>
                {#if bornW && streaming}
                  <!-- The weft (backlog 342): an accent thread draws across the
                       row as it appears, a bright shuttle runs along it while
                       the call runs, and on finish it fills and fades. -->
                  <!-- Item 589: the thread's light runs per kind (a command keeps
                       this shuttle; see stepMotion.svelte.ts). -->
                  <span class="rm-weft k-{kind}" class:mo-weft={running} class:rm-done={!running} aria-hidden="true"
                    >{#if running && kind !== "shell"}<i></i><i></i><i></i>{/if}</span>
                {/if}
                <!-- A file edit as a diff (backlog 433), drawn whether the row is
                     open or not: the change is what the row is about. -->
                {#if editDiff}
                  <EditDiffView diff={editDiff} denied={!!seg.call.denied} keep={detailsKey(`tool:${seg.call.id}:diff`)} />
                {/if}
                <!-- What a screenshot showed the model (backlog 434). -->
                {#if !seg.call.denied && namesImage(seg.call.result?.content)}
                  <ToolImagesView session={cliSession} id={seg.call.id} name={shortToolName(seg.call.name)} />
                {/if}
                {#if open}
                  <!-- The full call: its whole input (an edit's is the diff
                       above), then what came back. -->
                  {#if !editDiff}
                    <div class="tool-full">{compactJson(seg.call.input)}</div>
                  {/if}
                  {#if seg.call.denied}
                    <!-- The reason can come from the gate itself (a cancelled turn
                         refuses what it left parked), so it stands in for "you said no"
                         rather than being appended to it. -->
                    <div class="denied-note">
                      Not run — permission denied{seg.call.result?.content
                        ? `: ${seg.call.result.content}`
                        : "."}
                    </div>
                  {:else if seg.call.result}
                    <pre
                      class="tool-result"
                      class:error={seg.call.result.is_error}>{seg.call.result.content}</pre>
                  {/if}
                {/if}
                <!-- Outside the collapse: a call parked at the gate needs its prompt
                     on screen whatever the toggle says, or the turn waits on a
                     decision nobody can see. -->
                {#each approvals.filter((a) => a.id === seg.call.id) as req (req.id)}
                  <ApprovalPrompt {req} />
                {/each}
                <!-- 354: what he answered, under the question once it is no longer waiting. -->
                {#if seg.call.name === "AskUserQuestion" && !approvals.some((a) => a.id === seg.call.id)}
                  <AskAnswered call={seg.call} />
                {/if}
                <!-- The subagent this call spawned (backlog 075): one indented
                     row that opens to the child's turn — its calls, thinking and
                     words, nested subagents included. Live the children are
                     segments of their own; from the log they are the recorder's
                     narrative, one text segment. Outside the collapse, like the
                     prompt: a subagent at work is what the row is about. -->
                {#if seg.call.children?.length}
                  {@render subagent(seg.call.children, seg.call.id)}
                {/if}
                <!-- The hover on the call itself (backlog 066): the call and its
                     result leave the context together, the log keeps both. -->
                {#if (onremove && seg.block != null) || agentTab || (isShellCall(seg.call.name) && runFrom?.chat)}
                  <span
                    class="block-tools"
                    class:two={(!!agentTab || isShellCall(seg.call.name)) && !!onremove && seg.block != null}
                    use:tip={onremove && seg.block != null ? controlsTitle : ""}
                  >
                    {#if agentTab}
                      <!-- *Open as tab* (backlog 160): the drag's click. -->
                      <button
                        class="tool-btn"
                        use:tip={"Open this agent's transcript as a tab"}
                        aria-label="Open this agent's transcript as a tab"
                        onclick={() => void openContent(agentTab)}
                      >
                        <Icon name="ext" size={12} />
                      </button>
                    {/if}
                    {#if isShellCall(seg.call.name) && runFrom?.chat}
                      <!-- Item 503: this chat's commands as a view-only terminal. -->
                      <button
                        class="tool-btn"
                        use:tip={"Show this chat's commands in the terminal"}
                        aria-label="Show this chat's commands in the terminal"
                        onclick={() => runFrom?.chat && openAgentTab(runFrom.chat)}
                      >
                        <Icon name="term" size={12} />
                      </button>
                    {/if}
                    {#if onremove && seg.block != null}
                      <button
                        class="tool-btn"
                        use:tip={"Remove this tool call and its result from the context. Both stay in the log; Restore is on the placeholder."}
                        aria-label="Remove this tool call and its result from the context"
                        onclick={() => onremove?.(seg.block!)}
                      >
                        <Icon name="minus" size={12} />
                      </button>
                    {/if}
                  </span>
                {/if}
              </div>
            {/if}
          {/each}
        {:else}
          <!-- A parked prompt still shows through a folded block. -->
          {#each g.rows as { seg, i } (i)}
            {#if seg.kind === "tool"}
              {#each approvals.filter((a) => a.id === seg.call.id) as req (req.id)}
                <ApprovalPrompt {req} />
              {/each}
              {#if seg.call.name === "AskUserQuestion" && !approvals.some((a) => a.id === seg.call.id)}
                <AskAnswered call={seg.call} />
              {/if}
            {/if}
          {/each}
        {/if}
        {#if last}
          <div class="working" role="status" aria-label={working}>
            <span class="roll" aria-hidden="true"><Icon name="moon" size={20} /></span>
            <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="working-text">{working}</span>
            <!-- Item 589: three points scanning after the clock, the trace's
                 running light carried down to the working line. -->
            <span class="scan" aria-hidden="true"><i></i><i></i><i></i></span>
          </div>
        {/if}
        <button
          class="fold trace-foot"
          aria-expanded={!folded}
          use:tip={folded ? "Show the steps" : "Fold to one line"}
          onpointerdown={(e) => pressFold(e, g.key)}
          onclick={(e) => keyFold(e, g.key)}
        >
          <span class="fold-text">
            <span class="foot-k">Trace</span> {foot.steps}{#if foot.elapsed}<span class="foot-gap"></span><span class="foot-k">elapsed</span> {foot.elapsed}{/if}{#if folded}<span class="foot-gap"></span>{activitySummary(g.rows, streaming)}{:else if isTimed}<span class="foot-gap"></span><span class="foot-note">the bar is each step's place in the turn</span>{/if}{#if !streaming && traceRec?.tps}<span class="foot-gap"></span><span use:tip={SPEED_TITLE}>~{Math.round(traceRec.tps)} tok/s</span>{/if}
          </span>
          <span class="foot-fold">{folded ? "Expand" : "Collapse"} <span class="caret">{folded ? "▾" : "▴"}</span></span>
        </button>
      </div>
      <!-- What the block changed in memory (backlog 305): one line per
           memory note, AGENTS.md or thread file an edit in it wrote, outside
           the fold so a folded block still says so; it opens the note at
           the change. Read from the calls, so a reload draws it again. -->
      {#each memEditsOf(g.rows) as ed, k (k)}
        <button
          class="mem-edit"
          use:tip={`${ed.path} — open at the change`}
          onclick={() => void openMemoryEdit(ed)}
        >
          <Icon name="note" size={12} />
          <span>{ed.verb} <span class="mem-edit-name">{ed.label}</span></span>
        </button>
      {/each}
    {:else if g.seg.kind === "text" && standIn && isSignedOut(footer?.stop_reason)}
      <!-- Signed out (backlog 409): says so, with Sign in. -->
      <SignedOutNotice reason={footer?.stop_reason} />
    {:else if g.seg.kind === "text" && standIn}
      <div class="notice nl-own">{g.seg.text}</div>
    {:else if g.seg.kind === "text"}
      {@const councilSeat = parseCouncilSeat(g.seg.text)}
      {@const councilRecord = councilSeat ? null : parseCouncilRecord(g.seg.text)}
      {#if councilSeat || councilRecord}
        <!-- The council's blocks (nightshift backlog 149): a seat's answer
             folded under its map line, the record as the sources table. -->
        <CouncilBlocks seat={councilSeat} record={councilRecord} keep={detailsKey(`council:${g.i}`)} />
      {:else if diff && originals?.[g.i] != null}
        {@const before = originals[g.i]!}
        <!-- The edit as a diff over the markdown source (backlog 105): the
             source is what he edited, and a mark inside rendered HTML would
             have to cross links and code spans. The transcript's face. -->
        <div class="markdown textdiff">
          {#each wordDiff(before, g.seg.text) as op, k (k)}{#if op.kind === "del"}<del>{op.text}</del>{:else if op.kind === "add"}<ins>{op.text}</ins>{:else}{op.text}{/if}{/each}
        </div>
      {:else}
        <!-- Item 452: patched in place (liveHtml), not replaced whole per
             streamed delta, so a selection in its written part survives. -->
        <div class="markdown" use:liveHtml={renderReply(streaming ? streamingTail(g.seg.text) : g.seg.text)} use:memoryRefs={{ hits: memHits, text: g.seg.text }} use:codeCopy={runBlocks(g.seg.text)} use:handoffGo={nextChat}></div>
      {/if}
    {:else if g.seg.kind === "removed_tool" || g.seg.kind === "removed_text"}
      {@const seg = g.seg}
      <!-- A removed block's placeholder, greyed, the original a click
           away, Restore beside it (backlog 066). -->
      <div class="removed-block">
        <details class="removed-original" use:keptOpen={{ key: detailsKey(`removed:${seg.block}`) }}>
          <summary>
            <span class="removed-label">
              {seg.kind === "removed_tool" ? REMOVED_TOOL_PLACEHOLDER : REMOVED_TEXT_PLACEHOLDER}
            </span>
          </summary>
          {#if seg.kind === "removed_tool"}
            <div class="removed-body tool-chip line">
              <span class="tool-line">{toolSummary(seg.call, false)}</span>
            </div>
            {#if seg.call.result}
              <pre class="tool-result" class:error={seg.call.result.is_error}>{seg.call.result.content}</pre>
            {/if}
          {:else}
            <div class="removed-body">{seg.text}</div>
          {/if}
        </details>
        {#if onrestore}
          <button
            class="tool-btn"
            use:tip={"Restore to the context"}
            aria-label="Restore to the context"
            onclick={() => onrestore?.(seg.block)}
          >
            <Icon name="refresh" size={12} />
          </button>
        {/if}
      </div>
    {:else if g.seg.kind === "notice" && g.seg.delivered}
      <!-- Item 465: his mid-turn message, taken by the turn, as his bubble in place. -->
      <MidTurnBubble delivered={g.seg.delivered} />
    {:else if g.seg.kind === "notice"}
      <div class="notice">{g.seg.text}</div>
    {:else if g.seg.kind === "still_running"}
      <!-- Backlog 357: the still-running line, Stop and the names on it. -->
      <StillRunningLine seg={g.seg} />
    {:else if g.seg.kind === "retry"}
      <!-- Items 440 + 441: the CLI retrying, one line updated in place. -->
      <RetryLine seg={g.seg} />
    {/if}
  {/each}
  {#if moonAlone}
    <div class="working" role="status" aria-label={working}>
      <span class="roll" aria-hidden="true"><Icon name="moon" size={28} /></span>
      <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="working-text">{working}</span>
    </div>
  {/if}
  {#if sent.length > 0}
    <!-- Files the reply sent (backlog 343): the attachment chip — badge,
         name, caption, size, Open, Save, Reveal; dragged, the file itself
         goes where it is dropped. -->
    <div class="cards sent-files">
      {#each sent as f (f.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="card file sent"
          draggable="false"
          use:tip={"Drag out to drop the file anywhere"}
          onpointerdown={(e) => sentDown(e, f)}
          onpointermove={sentMove}
          onpointerup={() => (pressed = null)}
        >
          <span class="card-ext">{sentExt(f.name)}</span>
          <span class="card-text">
            <span class="card-title">{f.name}</span>
            {#if f.caption}<span class="card-sub">{f.caption}</span>{/if}
          </span>
          <span class="card-size">{fmtSize(f.size)}</span>
          <button class="ns-btn ghost small" use:tip={"Open with its application"} onclick={() => void openSent(f)}>Open</button>
          <button class="ns-btn ghost small" use:tip={"Save a copy where you choose"} onclick={() => void saveSent(f)}>Save</button>
          <button class="ns-btn ghost small" use:tip={"Show in the Finder"} onclick={() => void revealFile(f.path)}>Reveal</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if !streaming && (links.length > 0 || files.length > 0)}
    <!-- Under the reply text, not inline in it (backlog 078): an artifact
         result as a link card, a file the reply names as the attachment
         card — extension badge, path, size, Open, Reveal. -->
    <div class="cards">
      {#each links as l (l.url)}
        <div class="card link" use:tip={l.url}>
          <span class="card-ico"><Icon name="link" size={14} /></span>
          <span class="card-text">
            <span class="card-title">{l.title}</span>
            <span class="card-sub">{l.url.replace(/^https?:\/\//, "")}</span>
          </span>
          <button class="ns-btn ghost small" use:tip={"Open in the browser"} onclick={() => void openLink(l.url)}>Open <Icon name="ext" size={11} /></button>
        </div>
      {/each}
      {#each files as f (f.path)}
        <div class="card file" use:tip={f.path}>
          <span class="card-ext">{extOf(f.path)}</span>
          <span class="card-text">
            <span class="card-title mono">{f.label}</span>
          </span>
          <span class="card-size">{fmtSize(f.size)}</span>
          <button class="ns-btn ghost small" use:tip={"Open as a tab here — ⌘-click opens it with its application"} onclick={(e) => void openFile(f.path, e)}>Open</button>
          <button class="ns-btn ghost small" use:tip={"Show in the file manager"} onclick={() => void revealFile(f.path)}>Reveal</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if memGroups.length > 0}
    <MemoryHits groups={memGroups} />
  {/if}
  {#if footer && !streaming}
    {@const share = size ? shareOf(size.tokens, limit) : null}
    <div class="footer">
      <CopyButton {copied} label="Copy this reply" onclick={() => void copy()} />
      {#if onretry}
        <!-- Retry (item 333): the prompt again, in a fork from it; this
             reply stays where it is, a version (‹ ›) away. -->
        <!-- Item 439: called Redo, with Claude's circular arrow, as the
             same action is in the icon row under his last message. -->
        <button
          class="ns-btn ghost small redo"
          use:tip={"Redo: Claude answers your message again, without retyping it. This reply stays — ‹ › under your message flips between the two."}
          aria-label="Redo this reply"
          onclick={() => onretry?.()}
        >
          <Icon name="refresh" size={12} /> Redo
        </button>
      {/if}
      {#if !footer.bare && (size || hasUsage(footer.usage))}
        <!-- No figure without usage (backlog 332): a reply cut off before
             its result has none, and "0 out" under its words was wrong. -->
        <span class="meta" use:tip={footerTitle(footer, size)}>{fmtFigure(footer.usage, size)}{fmtCost(footer.cost)}</span>
      {/if}
      {#if planUsage}
        <!-- The turn's share of the plan (item 323): the five-hour window
             and the week, measured or ≈ estimated; hover says how. -->
        <span class="meta plan" use:tip={planUsage.title}>{planUsage.text}</span>
      {/if}
      {#if footerStopNote(footer.stop_reason, standIn)}
        <!-- Why the reply stopped (backlog 202): the API error the CLI
             ended it with, as the log recorded it — or that its stream
             ended before the reply did (backlog 332). -->
        <span class="meta stopped">{footerStopNote(footer.stop_reason, standIn)}</span>
      {/if}
      {#if fmtShare(share)}
        <!-- The reply's share of the window (backlog 090), the gauge's bar
             scaled to it, once the reply is worth a bar. -->
        <span class="meta share" use:tip={size ? sizeTitle(size, "assistant", limit) : ""}>
          <span class="share-bar" aria-hidden="true"><span class="share-fill" style:width="{(share ?? 0) * 100}%"></span></span>
          {fmtShare(share)}
        </span>
      {/if}
      {#if footer.at}
        <!-- When the reply landed (backlog 123): in words, the exact
             moment on hover, as Claude Code's footer does. -->
        <span class="meta when" use:tip={exactTime(footer.at)}>{relativeTimeLong(footer.at, clock)}</span>
      {/if}
      {#if onedit || onremoveturn}
        <!-- The turn's own controls on the same row (backlog 121): they
             were a row of their own under the footer, three rows per
             message in a run of one-call replies. Hidden until the reply
             is hovered, as the transcript's tool rows are. -->
        <span class="footer-tools" use:tip={controlsTitle}>
          {#if onedit}
            <button
              class="tool-btn"
              use:tip={"Edit this reply in place; the original stays in the log"}
              aria-label="Edit this reply"
              onclick={() => onedit?.()}
            >
              <Icon name="pencil" size={14} />
            </button>
          {/if}
          {#if onremoveturn}
            <!-- A delete look, apart from Edit's pencil (item 356); the
                 transcript asks before it removes. -->
            <button
              class="tool-btn danger"
              use:tip={removeTip("reply")}
              aria-label="Remove this reply from the chat history"
              onclick={() => onremoveturn?.()}
            >
              <Icon name="trash" size={14} />
            </button>
          {/if}
        </span>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Sources inline (backlog 213, `cite.ts`): a citation marker as a small
     chip beside its sentence, and the foot list folded. */
  .markdown :global(a.cite-chip) {
    display: inline-block;
    max-width: 14em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: 0.1em;
    margin: 0 0.1em 0 0.2em;
    padding: 0 0.45em;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: 0.72em;
    line-height: 1.6;
    text-decoration: none;
  }
  .markdown :global(a.cite-chip:hover) {
    background: var(--line2);
  }
  .markdown :global(details.all-sources) {
    margin-top: 0.6em;
    font-size: 0.9em;
    color: var(--dim);
  }
  .markdown :global(details.all-sources > summary) {
    cursor: pointer;
  }
  .assistant {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    /* ~~640px~~ The column's 760 (Filament IV, item 525): the reply, its
       trace and the composer share one measure. */
    max-width: 760px;
    /* The streaming shuttle (backlog 342) is placed against the reply. */
    position: relative;
  }
  /* The reply header (item 525): a ring, who answers, the model; while the
     turn is live the ring and "Replying m:ss" are the signal colour. Still:
     the motion that says "live" is the reply's own (the weft, the shuttle). */
  .who {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 2px;
    font-size: 12.5px;
    color: var(--dim);
    align-self: flex-start;
  }
  .who b {
    color: var(--ink);
    font-weight: 600;
  }
  .who-ring {
    flex: none;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1.5px solid var(--line2);
  }
  .who.live .who-ring {
    border-color: var(--signal);
    border-right-color: transparent;
  }
  .who-live {
    color: var(--signal);
  }
  .who-clock {
    font-family: var(--mono);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  /* The stream speed (item 564): at the header's right end while live, a
     blue sparkline of the last 24 seconds and the figure in mono. */
  .who:has(.who-speed) {
    align-self: stretch;
  }
  .who-speed {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    color: var(--ink2, var(--text));
  }
  .who-spark polyline {
    fill: none;
    stroke: var(--signal);
    stroke-width: 1.2;
    stroke-linejoin: round;
  }
  .assistant :global(.markdown) {
    /* Plex Sans, the interface face, since 2026-09-14: the editorial serif
       read as academic to him ("looks like Times New Roman almost"), and of
       the seven faces compared side by side he chose the one the chrome
       already uses. The per-user choice (nightshift backlog 051) arrives as
       two root properties set by `transcriptPrefs`; the fallbacks are his
       defaults. */
    font-family: var(--transcript-font, var(--sans));
    font-size: var(--transcript-size, 16px);
    line-height: 1.62;
    color: var(--ink);
  }
  /* The edit as a diff (backlog 105): the source pre-wrapped in the same
     face, the code diff view's colours, removed spans struck through. */
  .textdiff {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .textdiff del {
    background: var(--del-bg);
    color: var(--del-fg);
    text-decoration: line-through;
    text-decoration-color: var(--del-fg);
    border-radius: 3px;
  }
  .textdiff ins {
    background: var(--add-bg);
    color: var(--add-fg);
    text-decoration: none;
    border-radius: 3px;
  }
  /* The activity block (backlog 096): one bordered group with a left rule
     — accent while the turn is live, the panel line once done — and its
     rows on a shared grid so the names, arguments and sizes line up. */
  .activity {
    display: flex;
    flex-direction: column;
    /* A card in front (Filament IV, item 525): the raised fill, the control
       edge all round. ~~A left rule, accent while live~~: live is the
       signal colour on the edge, and on the running row. */
    /* ~~The raised fill and the control edge~~ (item 594, his words
       2026-11-10: the same shade as the message box "almost makes me think
       that the thinking section is like a textbox"): an instrument panel a
       step darker than the composer, between it and the ground, with a
       faint cool tint and a quieter edge. A mix, not `--sheet`, so it stays
       apart where a palette's raised fill is the sheet (B–D). */
    border: 1px solid color-mix(in srgb, var(--line2) 70%, var(--paper, var(--bg)));
    border-radius: var(--r2);
    background: color-mix(in srgb, color-mix(in srgb, var(--raised) 55%, var(--paper, var(--bg))) 96%, var(--signal));
    min-width: 0;
    /* Not `overflow: hidden`: the call's hover Remove (backlog 066) sits
       past the right edge. */
  }
  .activity.live {
    border-color: color-mix(in srgb, var(--signal) 40%, var(--line2));
  }
  /* The running call (blue is Claude working): its result column in the
     signal colour and, in the lit level, a soft wash across the row. */
  .row-wrap.tool.running {
    background: var(--wash-live, none);
  }
  .row-wrap.tool.running > .arow .size {
    color: var(--signal);
    opacity: 1;
  }
  .row-wrap.tool.running > .arow .ico {
    color: var(--signal);
  }
  /* "Updated course-progress.md" (backlog 305): a compact link under the
     block whose edit wrote a memory note, AGENTS.md or a thread file. */
  .mem-edit {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 2px 8px 2px 6px;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    color: var(--dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    min-width: 0;
  }
  .mem-edit > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mem-edit-name {
    font-family: var(--mono);
    color: var(--accent);
  }
  .mem-edit:hover .mem-edit-name {
    color: var(--accent-ink);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  /* The board's measures (claude-code-ui-design-2026-09-16, board 1): rows
     28px tall on one grid — icon 18 · name 118 · argument · size — a
     hairline between neighbours, 12px in from either edge. */
  .activity > * + * {
    border-top: 1px solid var(--line);
  }
  /* The subagent row under an Agent call (backlog 075): the disclosure's
     summary drawn like a row, indented one column in on the paper, its
     body one rule in. */
  .sub {
    margin: 0;
    border-top: 1px solid var(--line);
    background: var(--sheet);
  }
  .sub-line {
    display: grid;
    grid-template-columns: 18px minmax(0, auto) minmax(0, 1fr);
    column-gap: 10px;
    align-items: center;
    min-height: 28px;
    cursor: pointer;
    list-style: none;
    color: var(--dim);
    font-size: 0.78rem;
    padding: 5px 12px 5px 40px;
  }
  .sub-line .arg {
    color: var(--ink2);
  }
  .sub-line::-webkit-details-marker {
    display: none;
  }
  .sub[open] > .sub-line .ico {
    transform: rotate(90deg);
    display: inline-block;
  }
  .sub-body {
    border-left: 2px solid var(--line);
    padding-left: 0.6rem;
    margin: 0 12px 6px 40px;
  }
  .sub-body .arow {
    padding-left: 0;
    padding-right: 0;
  }
  .sub-text {
    margin: 2px 0;
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
    font-family: inherit;
  }
  .fold,
  .arow {
    display: grid;
    grid-template-columns: 18px 118px minmax(0, 1fr) auto;
    column-gap: 10px;
    align-items: center;
    width: 100%;
    min-width: 0;
    min-height: 28px;
    background: none;
    border: none;
    padding: 5px 12px;
    text-align: left;
    color: var(--dim);
    font-size: 0.78rem;
    cursor: pointer;
    user-select: none;
  }
  /* The one-line summary that folds the block: the board's mono, dim. */
  .fold {
    grid-template-columns: 18px minmax(0, 1fr);
  }
  /* ---- The trace (item 564, Filament IV stage 5; mockup f4-chat.png) ----
     A step row: number · status · name · argument · bar · size. The bar
     column is there only when the window timed the block's steps. The
     subagent's rows inside keep their own grid (below). */
  .trace > .row-wrap > .arow,
  .trace > .arow {
    grid-template-columns: 22px 14px 96px minmax(0, 1fr) auto;
    column-gap: 10px;
    min-height: 34px;
    padding: 6px 16px 6px 14px;
  }
  .trace.timed > .row-wrap > .arow,
  .trace.timed > .arow {
    grid-template-columns: 22px 14px 96px minmax(0, 1fr) 120px auto;
  }
  .trace:not(.timed) .tbar {
    display: none;
  }
  .no {
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--dim);
  }
  .st {
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1;
    text-align: center;
  }
  .st-done {
    color: var(--done);
  }
  .st-running {
    color: var(--signal);
    font-size: 10px;
  }
  .st-error,
  .st-denied {
    color: var(--failed);
  }
  .trace .name {
    font-size: 13px;
  }
  /* The thinking row reads as a step like the rest (the mockup's "Thought"),
     its first line dim in the argument column. */
  .trace > .row-wrap > .arow.thinking .name,
  .trace > .arow.thinking .name {
    font-style: normal;
    font-weight: 600;
    color: var(--ink);
  }
  .trace > .row-wrap > .arow.thinking .arg,
  .trace > .arow.thinking .arg {
    color: var(--dim);
  }
  .trace > .arow.thinking.hidden .arg {
    font-style: italic;
  }
  .open-mark {
    color: var(--dim);
    margin-left: 4px;
  }
  /* The bar: a hairline track, the step's span on it — green once done,
     blue while running, red on an error. */
  .tbar {
    position: relative;
    height: 3px;
    border-radius: 2px;
    background: var(--line2);
    align-self: center;
  }
  .tbar > i {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 2px;
    background: var(--done);
  }
  .tbar > i.tbar-running {
    background: var(--signal);
    box-shadow: var(--glow-signal, none);
  }
  .tbar > i.tbar-error {
    background: var(--failed);
  }
  .trace .size {
    font-size: 11.5px;
    min-width: 72px;
  }
  /* The foot: Trace · steps · elapsed · the legend, and the fold at its
     right end. Mono, dim; the labels dimmer. */
  .trace-foot {
    grid-template-columns: minmax(0, 1fr) auto;
    min-height: 30px;
    padding: 5px 16px 5px 14px;
    background: color-mix(in srgb, var(--ground, var(--bg)) 35%, transparent);
  }
  .trace-foot .fold-text {
    color: var(--ink2, var(--text));
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .foot-k,
  .foot-note {
    color: var(--dim);
  }
  .foot-gap {
    display: inline-block;
    width: 14px;
  }
  .foot-fold {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--dim);
  }
  .trace-foot:hover .foot-fold {
    color: var(--text);
  }
  /* A row with nothing in the argument column lets its name run across. */
  .arow.wide {
    grid-template-columns: 18px minmax(0, 1fr) auto;
  }
  .fold-text {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .fold:hover .fold-text,
  .fold:hover .caret,
  .arow:hover .name,
  .arow:hover .ico {
    color: var(--text);
  }
  .arow.static {
    cursor: default;
  }
  .caret,
  .ico {
    color: var(--dim);
    font-family: var(--mono);
    display: inline-flex;
    align-items: center;
  }
  .name {
    font-family: var(--sans);
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A thinking row: the name italic and dim, the spark in the accent. A
     hidden one (backlog 097) is dimmer still and no pointer. */
  .arow.thinking .name {
    font-style: italic;
    font-weight: 400;
    color: var(--dim);
  }
  .arow.thinking .ico {
    color: var(--accent);
    opacity: 0.7;
  }
  .arow.thinking.hidden {
    opacity: 0.7;
  }
  .arow.thinking.hidden .ico {
    color: var(--dim);
  }
  .arg {
    font-family: var(--mono);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The summary's first line (board 6, `thought · summary`): prose, not
     an argument, so the interface face in italic. */
  .arg.summary {
    font-family: var(--sans);
    font-style: italic;
    font-size: 0.78rem;
  }
  .size {
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    min-width: 64px;
    text-align: right;
    white-space: nowrap;
    opacity: 0.8;
  }
  .arow.error .arg,
  .arow.error .size {
    color: var(--failed);
  }
  .row-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    position: relative;
    min-width: 0;
  }
  .tool-full {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--dim);
    white-space: pre-wrap;
    word-break: break-word;
    padding: 0 12px 6px 40px;
  }
  .thinking-text {
    color: var(--dim);
    font-style: italic;
    font-size: 0.85rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0 12px 8px 40px;
    padding-left: 0.75rem;
    /* The margin rule is a background thread, not a border (backlog 342), so
       the needle can draw it: the same 2 px in the border colour at rest. */
    border-left: 2px solid transparent;
    background: linear-gradient(var(--border), var(--border)) left top / 2px 100% no-repeat;
    background-origin: border-box;
    position: relative;
  }

  /* ---- The streaming motion (backlog 342, his pick of 338: "Loom + fade-in";
     timings from harness/stream338-motion.css). Text: replyMotion.ts reveals each
     block's lines left to right behind one mask (item 617, Line reveal) or, with
     Reply text set to Word rise, wraps the words still arriving in .rm-w; either
     way it moves .rm-shuttle, in the theme's --motion-ink (item 627). Thinking: the needle.
     Tool rows: the weft. Under reduced motion nothing moves and nothing loops. */
  .row-wrap.rm-live > .thinking-text,
  .thinking-text:global(.rm-retract) {
    background-image: linear-gradient(var(--motion-ink, var(--accent)), var(--motion-ink, var(--accent)));
  }
  .row-wrap.rm-live > .thinking-text::after {
    content: "";
    position: absolute;
    left: -2px;
    bottom: 0.3em;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--motion-ink-hi, var(--accent-ink, var(--accent)));
    box-shadow: 0 0 8px var(--motion-ink, var(--accent));
  }
  .rm-weft {
    position: absolute;
    left: 12px;
    right: 12px;
    top: 27px;
    height: 1.5px;
    transform-origin: left center;
    pointer-events: none;
    background: color-mix(in srgb, var(--signal) 22%, transparent);
    overflow: hidden;
  }
  .rm-weft::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 28%;
    border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--signal-ink, var(--signal)), transparent);
    box-shadow: var(--glow-signal, none);
  }
  /* Done is green (Filament IV: "green is finished"), then gone. */
  .rm-weft.rm-done {
    background: var(--done);
    opacity: 0;
  }
  .rm-weft.rm-done::after {
    display: none;
  }
  .assistant :global(.rm-shuttle) {
    position: absolute;
    left: 0;
    top: 0;
    width: 18px;
    height: 5px;
    margin: -2.5px 0 0 0;
    border-radius: 50% / 100%;
    background: linear-gradient(90deg, color-mix(in srgb, var(--motion-ink, var(--accent)) 10%, transparent), var(--motion-ink-hi, var(--accent-ink, var(--accent))));
    box-shadow: 0 0 8px color-mix(in srgb, var(--motion-ink, var(--accent)) 70%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 260ms ease-out;
    z-index: 5;
  }
  @media (prefers-reduced-motion: reduce) {
    .rm-weft,
    .assistant :global(.rm-shuttle) {
      display: none;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    /* Each new word fades up from a soft blur a quarter-line below, under an
       accent weft that fades; the delay (negative once begun) is set per word. */
    .assistant :global(.rm-w) {
      /* Item 626: inline, not inline-block — an atomic inline is a line-break opportunity on both sides and trims
         its edge spaces, so a word split across deltas wrapped mid-word and spacing slipped until the spans went.
         The rise is `top` on a relative inline (a transform does not apply to an inline box). */
      display: inline;
      position: relative;
      animation:
        rm-rise 520ms cubic-bezier(0.2, 0.7, 0.2, 1) both,
        rm-weft-under 900ms ease-out both;
    }
    .row-wrap.rm-live > .thinking-text::after {
      animation: rm-needle 1.1s ease-in-out infinite;
    }
    .row-wrap.rm-thought > .arow .name {
      animation: rm-label 280ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .row-wrap.rm-thought > .arow .ico {
      animation: rm-turn 520ms cubic-bezier(0.2, 0.7, 0.2, 1) 200ms;
    }
    .row-wrap.tool.rm-born {
      animation: rm-in 180ms;
    }
    .rm-weft {
      animation: rm-draw 320ms cubic-bezier(0.2, 0.7, 0.2, 1);
    }
    .rm-weft::after {
      animation: rm-shuttle-run 0.9s ease-in-out infinite alternate;
    }
    .rm-weft.rm-done {
      animation: rm-weft-done 650ms ease-out;
    }
    .row-wrap.tool.rm-finished > .arow .size {
      animation: rm-in 220ms;
    }
    .row-wrap.tool.rm-born .sub {
      animation: rm-in 300ms;
    }
    .row-wrap.tool.rm-born .rm-count {
      animation: rm-flash 600ms ease-out;
    }
  }
  @keyframes -global-rm-rise {
    from {
      opacity: 0;
      top: 0.28em;
      filter: blur(3px);
    }
    to {
      opacity: 1;
      top: 0;
      filter: none;
    }
  }
  @keyframes -global-rm-weft-under {
    from {
      box-shadow: inset 0 -1.5px 0 color-mix(in srgb, var(--motion-ink, var(--accent)) 85%, transparent);
    }
    to {
      box-shadow: inset 0 -1.5px 0 transparent;
    }
  }
  @keyframes -global-rm-needle {
    50% {
      box-shadow: 0 0 2px var(--motion-ink, var(--accent));
      opacity: 0.6;
    }
  }
  @keyframes -global-rm-label {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  @keyframes -global-rm-turn {
    from {
      transform: rotate(0);
    }
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes -global-rm-in {
    from {
      opacity: 0;
    }
  }
  @keyframes -global-rm-draw {
    from {
      transform: scaleX(0);
    }
  }
  @keyframes -global-rm-shuttle-run {
    from {
      left: -10%;
    }
    to {
      left: 82%;
    }
  }
  @keyframes -global-rm-weft-done {
    0%,
    40% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes -global-rm-flash {
    from {
      color: var(--motion-ink, var(--accent));
    }
  }
  /* ---- Item 589: the running step comes alive (stepMotion.svelte.ts) ----
     One grammar — the thread under the row, the bar's head, the status mark —
     with a variant per kind (data-kind). The setting (item 616: "combo",
     the default; "sweep", today's; "reticle") is stamped on each trace as data-motion (item 610: the trace's
     own, so Settings' three previews run side by side; the transcript's
     follow the setting) and applies to all of it.
     Transform and opacity only (the word's light is a background position on
     one word); paused while the window is hidden; under reduced motion
     nothing here moves. The step ending removes .mo-run: the finished look
     at once. */
  .trace .arow.mo-run {
    position: relative;
  }
  .row-wrap.mo-run,
  .trace .arow.mo-run {
    isolation: isolate;
  }
  /* Item 649: the remnant and a subagent row's passing text sit behind the
     row's text, inside the row — not behind the trace. */
  .row-wrap.bash-rem,
  .arow.sub-pass {
    position: relative;
    isolation: isolate;
  }
  /* ---- Item 616: Combo and Reticle (616-demo/combo.html) ----
     Their parts sit in the running row's top 34 px (the row itself; an
     open thinking's text below is not framed). None is drawn under Sweep. */
  .mo-bg,
  .mo-tex,
  .mo-brk,
  .mo-edge,
  .mo-bus,
  .st-ico,
  .tbar-ctx,
  .ctx-lbl {
    display: none;
  }
  /* The demo's white-hot point: the theme's signal ink, nearly white. */
  .trace {
    --mo-hot: color-mix(in srgb, var(--signal-ink, var(--signal)) 45%, #fffaf0);
  }
  .mo-bg,
  .mo-brk,
  .mo-edge {
    position: absolute;
    left: 6px;
    right: 6px;
    top: 2px;
    height: 30px;
    pointer-events: none;
    z-index: -1;
  }
  /* Reticle's faint tint (his 1:2x AM ask: Combo takes it too). */
  .mo-bg {
    border-radius: 3px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--signal) 9%, transparent), transparent 60%);
  }
  /* Combo (his later ask: the "slightly angled lines … slowly shifting
     across"): 589's Weave texture, faint skewed threads drifting behind the
     running row, on every kind. Transform only. */
  .mo-tex {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 34px;
    overflow: hidden;
    pointer-events: none;
    z-index: -1;
    -webkit-mask-image: linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent);
    mask-image: linear-gradient(90deg, transparent, #000 25%, #000 75%, transparent);
  }
  .mo-tex::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -32px;
    right: -32px;
    background: repeating-linear-gradient(90deg, transparent 0 15px, color-mix(in srgb, var(--signal) 10%, transparent) 15px 16px);
    transform: skewX(-24deg);
  }
  .trace[data-motion="combo"] .mo-tex {
    display: block;
  }
  .mo-brk i {
    position: absolute;
    width: 9px;
    height: 7px;
    border: 0 solid var(--signal);
    opacity: 0.85;
  }
  .mo-brk i:nth-child(1) {
    left: 0;
    top: 0;
    border-left-width: 1.5px;
    border-top-width: 1.5px;
  }
  .mo-brk i:nth-child(2) {
    right: 0;
    top: 0;
    border-right-width: 1.5px;
    border-top-width: 1.5px;
  }
  .mo-brk i:nth-child(3) {
    left: 0;
    bottom: 0;
    border-left-width: 1.5px;
    border-bottom-width: 1.5px;
  }
  .mo-brk i:nth-child(4) {
    right: 0;
    bottom: 0;
    border-right-width: 1.5px;
    border-bottom-width: 1.5px;
  }
  .trace:is([data-motion="combo"], [data-motion="reticle"]) .mo-bg,
  .trace:is([data-motion="combo"], [data-motion="reticle"]) .mo-brk {
    display: block;
  }
  /* Combo: a faint light running round the row's edge (Live wire's, at
     45 %) — a dash along the outline, moved by its offset. Held still it
     sits at the top right. */
  .trace[data-motion="combo"] .mo-edge {
    display: block;
    overflow: visible;
    width: calc(100% - 12px);
    opacity: 0.45;
  }
  .mo-edge rect {
    fill: none;
    stroke-linecap: round;
    stroke-dashoffset: 30;
  }
  .mo-edge .e-tail {
    stroke: color-mix(in srgb, var(--signal) 70%, transparent);
    stroke-width: 1;
    stroke-dasharray: 22 78;
  }
  /* The head: the tail's leading 4 (a gap of 18 first), so one offset
     moves both. */
  .mo-edge .e-head {
    stroke: var(--mo-hot);
    stroke-width: 1.2;
    stroke-dasharray: 0 18 4 78;
  }
  /* The mark: the instrument in place of the ■. */
  .st-running {
    position: relative;
  }
  .trace:is([data-motion="combo"], [data-motion="reticle"]) .st-sq {
    display: none;
  }
  .trace:is([data-motion="combo"], [data-motion="reticle"]) .st-ico {
    display: block;
    position: absolute;
    left: 50%;
    top: 50%;
    width: 16px;
    height: 16px;
    margin: -8px 0 0 -8px;
  }
  .st-ico svg {
    width: 16px;
    height: 16px;
    overflow: visible;
    display: block;
  }
  .st-ico .ring {
    fill: none;
    stroke: var(--signal);
    stroke-width: 1.2;
    transform-origin: 9px 9px;
    transform-box: view-box;
  }
  .st-ico .core {
    fill: var(--signal-ink, var(--signal));
    transform-origin: 9px 9px;
    transform-box: view-box;
  }
  .st-ico .r1 {
    stroke-dasharray: 6 3.4;
  }
  .st-ico .r2 {
    stroke-dasharray: 2 2.6;
    opacity: 0.7;
  }
  .st-ico .scanl {
    stroke: var(--mo-hot);
    stroke-width: 1.2;
    filter: drop-shadow(0 0 1.5px var(--signal));
  }
  .st-ico .cursor {
    fill: var(--signal-ink, var(--signal));
  }
  .st-ico .radar {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1.2px solid color-mix(in srgb, var(--signal) 70%, transparent);
    background: conic-gradient(from 0deg, transparent 0 270deg, color-mix(in srgb, var(--signal) 60%, transparent) 355deg, var(--mo-hot) 360deg);
    -webkit-mask: radial-gradient(circle, #000 64%, transparent 66%);
    mask: radial-gradient(circle, #000 64%, transparent 66%);
  }
  .st-ico .blip {
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--mo-hot);
    box-shadow: 0 0 4px var(--signal);
    opacity: 0;
  }
  .st-ico .b1 {
    left: 10px;
    top: 3.5px;
  }
  .st-ico .b2 {
    left: 3.5px;
    top: 10px;
  }
  .st-ico .orbit {
    position: absolute;
    inset: 0;
  }
  .st-ico .orbit > b {
    position: absolute;
    left: 50%;
    top: 0;
    width: 3.5px;
    height: 3.5px;
    margin-left: -1.75px;
    border-radius: 50%;
    background: var(--signal-ink, var(--signal));
    box-shadow: 0 0 4px var(--signal);
  }
  .st-ico .o2 {
    inset: 3px;
  }
  .st-ico .o3 {
    inset: -2px;
  }
  .st-ico .o2 > b {
    opacity: 0.8;
  }
  .st-ico .o3 > b {
    opacity: 0.6;
  }
  .st-ico .hub {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 5px;
    height: 5px;
    margin: -2.5px;
    border-radius: 50%;
    background: var(--signal);
    box-shadow: 0 0 6px var(--signal);
  }
  /* Combo: a running helper's bar is its context out of 300k, labelled
     above it; today's span gives way to it. */
  .trace[data-motion="combo"] .tbar.has-ctx > i.tbar-running {
    opacity: 0;
  }
  .trace[data-motion="combo"] .tbar-ctx {
    display: block;
    left: 0;
    right: 0;
    transform-origin: left center;
    background: var(--signal);
    box-shadow: var(--glow-signal, none);
    transition: transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1);
  }
  .trace[data-motion="combo"] .ctx-lbl {
    display: block;
    position: absolute;
    right: 0;
    bottom: 5px;
    font: 9px var(--mono);
    letter-spacing: 0.04em;
    white-space: nowrap;
    color: color-mix(in srgb, var(--signal) 75%, transparent);
    pointer-events: none;
  }
  /* Reticle: no Sweep thread — a data bus with packets runs under the
     row instead; the bar is dashed with a blinking head. */
  .trace[data-motion="reticle"] .mo-weft {
    display: none;
  }
  .trace[data-motion="reticle"] .mo-bus {
    display: block;
    position: absolute;
    left: 46px;
    right: 16px;
    top: 26px;
    height: 3px;
    overflow: hidden;
    pointer-events: none;
  }
  .mo-bus::before {
    content: "";
    position: absolute;
    top: 1px;
    left: -12px;
    right: 0;
    height: 1px;
    background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--signal) 35%, transparent) 0 6px, transparent 6px 12px);
  }
  /* A packet: the bus's whole width, lit at its right end, carried across
     by translate (its own width is the bus's, so -100% → 0 crosses it). */
  .mo-bus > i {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 3px;
    background: linear-gradient(90deg, transparent calc(100% - 16px), var(--signal-ink, var(--signal)) calc(100% - 5px), var(--mo-hot));
    transform: translateX(-100%);
  }
  .mo-bus.k-shell > i {
    background: linear-gradient(90deg, transparent calc(100% - 6px), var(--signal-ink, var(--signal)) calc(100% - 2px), var(--mo-hot));
  }
  .mo-bus.k-agent {
    height: 7px;
    top: 24px;
  }
  .mo-bus.k-agent::before {
    box-shadow:
      0 2px 0 color-mix(in srgb, var(--signal) 25%, transparent),
      0 4px 0 color-mix(in srgb, var(--signal) 18%, transparent);
  }
  .mo-bus.k-agent > i {
    height: 1.5px;
    background: linear-gradient(90deg, transparent calc(100% - 12px), var(--signal-ink, var(--signal)) calc(100% - 4px), var(--mo-hot));
  }
  .mo-bus.k-agent > i:nth-child(1) {
    top: 1px;
  }
  .mo-bus.k-agent > i:nth-child(2) {
    top: 3px;
  }
  .mo-bus.k-agent > i:nth-child(3) {
    top: 5px;
  }
  .trace[data-motion="reticle"] .tbar {
    height: 4px;
    background: repeating-linear-gradient(90deg, var(--line2) 0 3px, transparent 3px 5px);
  }
  .trace[data-motion="reticle"] .mo-run .tbar > i.tbar-running {
    background: repeating-linear-gradient(90deg, var(--signal) 0 3px, transparent 3px 5px);
    box-shadow: none;
  }
  .trace[data-motion="reticle"] .mo-run .tbar > i.tbar-running::after {
    content: "";
    position: absolute;
    right: -2px;
    top: -3px;
    width: 2px;
    height: 10px;
    margin-top: 0;
    border-radius: 0;
    background: var(--mo-hot);
    box-shadow: 0 0 6px var(--signal);
  }
  .mo-weft:not(.k-shell)::after {
    display: none;
  }
  .mo-weft > i {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    width: 30%;
    border-radius: 2px;
    opacity: 0;
    --comet: linear-gradient(90deg, transparent, color-mix(in srgb, var(--signal) 45%, transparent) 70%, var(--signal-ink, var(--signal)));
  }
  /* Thinking's thread is the brightest: 2 px, and its bead may glow past
     the line (clipped only at the ends). */
  .mo-weft.k-think {
    top: 26.5px;
    height: 2px;
    background: color-mix(in srgb, var(--signal) 16%, transparent);
    overflow: visible;
    clip-path: inset(-6px 0 -6px 0);
  }
  .mo-weft.k-agent {
    top: 25px;
    height: 5px;
    background: repeating-linear-gradient(180deg, color-mix(in srgb, var(--signal) 20%, transparent) 0 1px, transparent 1px 2px);
  }
  .scan {
    display: none;
    gap: 4px;
    align-items: center;
  }
  .scan i {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--signal);
    opacity: 0.25;
  }
  @media (prefers-reduced-motion: no-preference) {
    /* The thread: thinking flows one way in two comets; a helper runs three
       threads at their own speeds; a file is written by a stroke and a nib;
       the web scans and rests; anything else, one slow comet. */
    .mo-weft.k-think > i:nth-child(1) {
      opacity: 1;
      width: 38%;
      background: var(--comet);
      box-shadow: var(--glow-signal, none);
      --to: 263%;
      animation: mo-run 1.7s cubic-bezier(0.45, 0.05, 0.4, 1) infinite;
    }
    .mo-weft.k-think > i:nth-child(3) {
      opacity: 1;
      width: 38%;
      top: -2px;
      height: 6px;
      background: radial-gradient(circle at calc(100% - 3px) 50%, var(--signal-ink, var(--signal)) 0 2.5px, color-mix(in srgb, var(--signal) 45%, transparent) 3.5px, transparent 7px);
      --to: 263%;
      animation: mo-run 1.7s cubic-bezier(0.45, 0.05, 0.4, 1) infinite;
    }
    .mo-weft.k-think > i:nth-child(2) {
      opacity: 0.45;
      width: 22%;
      background: var(--comet);
      --to: 455%;
      animation: mo-run 1.7s cubic-bezier(0.45, 0.05, 0.4, 1) -0.85s infinite;
    }
    .mo-weft.k-agent > i {
      opacity: 1;
      height: 1px;
      width: 18%;
      background: var(--comet);
      --to: 556%;
    }
    .mo-weft.k-agent > i:nth-child(1) {
      animation: mo-run 1.25s ease-in-out infinite;
    }
    .mo-weft.k-agent > i:nth-child(2) {
      top: 2px;
      animation: mo-run 1.7s ease-in-out -0.5s infinite;
    }
    .mo-weft.k-agent > i:nth-child(3) {
      top: 4px;
      animation: mo-run 2.15s ease-in-out -1.3s infinite;
    }
    .mo-weft.k-file > i:nth-child(1) {
      width: 100%;
      transform-origin: left center;
      background: color-mix(in srgb, var(--signal) 55%, transparent);
      animation: mo-write 1.6s cubic-bezier(0.3, 0.6, 0.3, 1) infinite;
    }
    .mo-weft.k-file > i:nth-child(2) {
      width: 100%;
      background: linear-gradient(90deg, transparent calc(100% - 8px), var(--signal-ink, var(--signal)));
      animation: mo-nib 1.6s cubic-bezier(0.3, 0.6, 0.3, 1) infinite;
    }
    .mo-weft.k-web > i:nth-child(1),
    .mo-weft.k-web > i:nth-child(2) {
      width: 10%;
      background: linear-gradient(90deg, transparent, var(--signal-ink, var(--signal)), transparent);
      --to: 1000%;
      animation: mo-scan 1.5s cubic-bezier(0.5, 0, 0.5, 1) infinite;
    }
    .mo-weft.k-web > i:nth-child(1) {
      box-shadow: var(--glow-signal, none);
    }
    .mo-weft.k-web > i:nth-child(2) {
      --peak: 0.35;
      animation-delay: 0.12s;
    }
    .mo-weft.k-other > i:nth-child(1) {
      opacity: 0.7;
      background: var(--comet);
      --to: 333%;
      animation: mo-run 2.4s linear infinite;
    }
    /* The bar's head: a lit point at the running bar's end, beating at the
       kind's tempo. */
    .mo-run .tbar > i.tbar-running::after {
      content: "";
      position: absolute;
      right: -3px;
      top: 50%;
      width: 7px;
      height: 7px;
      margin-top: -3.5px;
      border-radius: 50%;
      background: var(--signal-ink, var(--signal));
      box-shadow: 0 0 6px var(--signal);
      animation: mo-head var(--beat, 1.2s) ease-in-out infinite;
    }
    [data-kind="think"] {
      --beat: 1.3s;
    }
    [data-kind="shell"] {
      --beat: 0.9s;
    }
    [data-kind="file"] {
      --beat: 0.8s;
    }
    [data-kind="web"] {
      --beat: 1.5s;
    }
    [data-kind="other"] {
      --beat: 1.8s;
    }
    /* The mark: a heartbeat (thinking), a cursor's blink (a command), a
       quarter turn (a helper), a pen's bob (a file), a ping (the web), a
       breath (the rest). */
    .mo-run .st-running {
      position: relative;
    }
    .trace[data-motion="sweep"] .mo-run[data-kind="think"] .st-running {
      animation: mo-heart 1.3s ease-out infinite;
    }
    .trace[data-motion="sweep"] .mo-run[data-kind="shell"] .st-running {
      animation: mo-blink 1s steps(1) infinite;
    }
    .trace[data-motion="sweep"] .mo-run[data-kind="agent"] .st-running {
      animation: mo-quarter 1.2s cubic-bezier(0.6, 0, 0.3, 1) infinite;
    }
    .trace[data-motion="sweep"] .mo-run[data-kind="file"] .st-running {
      animation: mo-bob 0.8s ease-in-out infinite alternate;
    }
    .trace[data-motion="sweep"] .mo-run[data-kind="web"] .st-running::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 10px;
      height: 10px;
      margin: -5px 0 0 -5px;
      border: 1px solid var(--signal);
      border-radius: 2px;
      animation: mo-ping 1.5s ease-out infinite;
    }
    .trace[data-motion="sweep"] .mo-run[data-kind="other"] .st-running {
      animation: mo-breathe 1.8s ease-in-out infinite alternate;
    }
    /* A light passing through the word "Thinking". */
    :global(:root) .trace .mo-run[data-kind="think"] .name {
      -webkit-text-fill-color: transparent;
      background-image: linear-gradient(100deg, var(--ink) 0 42%, var(--signal-ink, var(--signal)) 50%, var(--ink) 58% 100%);
      background-size: 300% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      animation: mo-shimmer 2.4s linear infinite;
    }
    /* Item 616 — Combo and Reticle. The brackets lock on and settle;
       Combo's edge light runs the outline at the kind's pace; the marks
       turn, beat, scan and blink; Reticle's packets cross the bus. */
    .trace:is([data-motion="combo"], [data-motion="reticle"]) .mo-run .mo-brk {
      animation: mo-lock 2.4s cubic-bezier(0.2, 0.7, 0.2, 1) infinite;
    }
    .mo-edge rect {
      animation: mo-edge var(--edge, 3s) linear infinite;
    }
    .mo-tex::before {
      animation: mo-drift var(--drift, 1.4s) linear infinite;
    }
    .mo-tex.k-think {
      --drift: 1.8s;
    }
    .mo-tex.k-agent {
      --drift: 0.7s;
    }
    .mo-tex.k-other {
      --drift: 2.4s;
    }
    [data-kind="think"] {
      --edge: 3.2s;
    }
    [data-kind="shell"] {
      --edge: 1.4s;
    }
    [data-kind="file"] {
      --edge: 2.4s;
    }
    [data-kind="web"] {
      --edge: 2s;
    }
    [data-kind="agent"] {
      --edge: 2.6s;
    }
    .st-ico .r1 {
      animation: mo-spin 2.4s linear infinite;
    }
    .st-ico .r2 {
      animation: mo-spin 1.6s linear infinite reverse;
    }
    .st-ico.k-think .core {
      animation: mo-core 1.3s ease-out infinite;
    }
    .st-ico .scanl {
      animation: mo-scanl 1.1s ease-in-out infinite alternate;
    }
    .st-ico .cursor {
      animation: mo-blink 0.9s steps(1) infinite;
    }
    .st-ico .radar {
      animation: mo-spin 1.6s linear infinite;
    }
    .st-ico .blip {
      animation: mo-blip 1.6s linear infinite;
    }
    .st-ico .b2 {
      animation-delay: -0.5s;
    }
    .st-ico .orbit {
      animation: mo-spin 1.4s linear infinite;
    }
    .st-ico .o2 {
      animation-duration: 1s;
    }
    .st-ico .o3 {
      animation-duration: 2s;
    }
    .mo-bus::before {
      animation: mo-bus-drift 0.6s linear infinite;
    }
    .mo-bus > i {
      animation: mo-pkt 1.4s cubic-bezier(0.5, 0, 0.5, 1) infinite;
    }
    .mo-bus > i:nth-child(2) {
      animation-delay: -0.7s;
      opacity: 0.6;
    }
    .mo-bus > i:nth-child(3) {
      display: none;
    }
    .mo-bus.k-file > i,
    .mo-bus.k-shell > i {
      display: block;
      opacity: 1;
      animation: mo-pkt 0.9s linear infinite;
    }
    .mo-bus.k-file > i:nth-child(2) {
      animation-delay: -0.3s;
    }
    .mo-bus.k-file > i:nth-child(3) {
      animation-delay: -0.6s;
    }
    .mo-bus.k-shell > i {
      animation-duration: 0.55s;
    }
    .mo-bus.k-shell > i:nth-child(2) {
      animation-delay: -0.18s;
    }
    .mo-bus.k-shell > i:nth-child(3) {
      animation-delay: -0.36s;
    }
    .mo-bus.k-web > i {
      animation: mo-pkt-ping 1.6s cubic-bezier(0.3, 0, 0.3, 1) infinite;
    }
    .mo-bus.k-web > i:nth-child(2) {
      animation-delay: 0.1s;
      opacity: 0.4;
    }
    .mo-bus.k-agent > i {
      display: block;
      opacity: 1;
    }
    .mo-bus.k-agent > i:nth-child(1) {
      animation: mo-pkt 1.1s linear infinite;
    }
    .mo-bus.k-agent > i:nth-child(2) {
      animation: mo-pkt 1.6s linear -0.4s infinite;
    }
    .mo-bus.k-agent > i:nth-child(3) {
      animation: mo-pkt 2.1s linear -1.1s infinite;
    }
    .trace[data-motion="reticle"] .mo-run .tbar > i.tbar-running::after {
      animation: mo-blink 0.9s steps(1) infinite;
    }
    /* Reticle: a highlight band sweeps the search's words. */
    .trace[data-motion="reticle"] .mo-run[data-kind="web"] .arg {
      position: relative;
    }
    .trace[data-motion="reticle"] .mo-run[data-kind="web"] .arg::after {
      content: "";
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 40px;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--signal) 28%, transparent), transparent);
      animation: mo-band 1.6s cubic-bezier(0.3, 0, 0.3, 1) infinite;
    }
    /* The working line's three points scan after its clock. */
    .activity .working .scan {
      display: inline-flex;
    }
    .scan i {
      animation: mo-dot 1.2s ease-in-out infinite;
    }
    .scan i:nth-child(2) {
      animation-delay: 0.15s;
    }
    .scan i:nth-child(3) {
      animation-delay: 0.3s;
    }
    /* A hidden window: everything here holds still. */
    :global(:root[data-hidden]) .trace *,
    :global(:root[data-hidden]) .trace *::before,
    :global(:root[data-hidden]) .trace *::after {
      animation-play-state: paused !important;
    }
  }
  @keyframes -global-mo-run {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(var(--to, 300%));
    }
  }
  @keyframes -global-mo-write {
    0% {
      transform: scaleX(0);
      opacity: 1;
    }
    70% {
      transform: scaleX(1);
      opacity: 1;
    }
    100% {
      transform: scaleX(1);
      opacity: 0;
    }
  }
  @keyframes -global-mo-nib {
    0% {
      transform: translateX(-100%);
      opacity: 1;
    }
    70% {
      transform: translateX(0);
      opacity: 1;
    }
    100% {
      transform: translateX(0);
      opacity: 0;
    }
  }
  @keyframes -global-mo-scan {
    0% {
      transform: translateX(-100%);
      opacity: var(--peak, 1);
    }
    45% {
      transform: translateX(var(--to, 1000%));
      opacity: var(--peak, 1);
    }
    46%,
    100% {
      transform: translateX(var(--to, 1000%));
      opacity: 0;
    }
  }
  @keyframes -global-mo-head {
    0%,
    100% {
      opacity: 0.45;
      transform: scale(0.7);
    }
    50% {
      opacity: 1;
      transform: scale(1.15);
    }
  }
  @keyframes -global-mo-heart {
    0% {
      transform: scale(1);
      opacity: 0.8;
    }
    14% {
      transform: scale(1.7);
      opacity: 1;
    }
    28% {
      transform: scale(1);
      opacity: 0.85;
    }
    42% {
      transform: scale(1.25);
      opacity: 1;
    }
    70%,
    100% {
      transform: scale(1);
      opacity: 0.8;
    }
  }
  @keyframes -global-mo-blink {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0.2;
    }
  }
  @keyframes -global-mo-quarter {
    0% {
      transform: rotate(0);
    }
    60%,
    100% {
      transform: rotate(90deg);
    }
  }
  @keyframes -global-mo-bob {
    from {
      transform: translateY(1px);
    }
    to {
      transform: translateY(-1.5px);
    }
  }
  @keyframes -global-mo-ping {
    from {
      transform: scale(0.6);
      opacity: 0.9;
    }
    to {
      transform: scale(2.2);
      opacity: 0;
    }
  }
  @keyframes -global-mo-breathe {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.4;
    }
  }
  @keyframes -global-mo-shimmer {
    from {
      background-position: 100% 0;
    }
    to {
      background-position: 0 0;
    }
  }
  @keyframes -global-mo-drift {
    from {
      transform: skewX(-24deg) translateX(0);
    }
    to {
      transform: skewX(-24deg) translateX(16px);
    }
  }
  /* Item 616's keyframes (Combo, Reticle). */
  @keyframes -global-mo-lock {
    0% {
      transform: scale(1.025, 1.25);
      opacity: 0;
    }
    14% {
      transform: none;
      opacity: 1;
    }
    80% {
      opacity: 1;
    }
    100% {
      opacity: 0.55;
    }
  }
  @keyframes -global-mo-edge {
    from {
      stroke-dashoffset: 100;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
  @keyframes -global-mo-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes -global-mo-core {
    0% {
      transform: scale(0.6);
      opacity: 0.7;
    }
    15% {
      transform: scale(1.25);
      opacity: 1;
    }
    30% {
      transform: scale(0.8);
    }
    45% {
      transform: scale(1.05);
    }
    100% {
      transform: scale(0.6);
      opacity: 0.7;
    }
  }
  @keyframes -global-mo-scanl {
    from {
      transform: translateY(-4.5px);
    }
    to {
      transform: translateY(4.5px);
    }
  }
  @keyframes -global-mo-blip {
    0%,
    62% {
      opacity: 0;
    }
    66% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  @keyframes -global-mo-bus-drift {
    to {
      transform: translateX(12px);
    }
  }
  @keyframes -global-mo-pkt {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(0);
    }
  }
  @keyframes -global-mo-pkt-ping {
    0% {
      transform: translateX(-100%);
    }
    45% {
      transform: translateX(0);
    }
    46%,
    100% {
      transform: translateX(0);
      opacity: 0;
    }
  }
  @keyframes -global-mo-band {
    0% {
      transform: translateX(-40px);
    }
    45%,
    100% {
      transform: translateX(260px);
    }
  }
  @keyframes -global-mo-dot {
    0%,
    60%,
    100% {
      opacity: 0.25;
      transform: scale(1);
    }
    20% {
      opacity: 1;
      transform: scale(1.35);
    }
  }
  /* The moon, kept for the live turn (backlog 096): the same roll as the
     waiting row in `Transcript.svelte`, the elapsed time beside it; still
     dots under reduced motion. */
  .working {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 28px;
    padding: 4px 12px;
    color: var(--dim);
    font-size: 0.78rem;
  }
  /* Inside the block the moon is a row like the others (board 1): the
     moon in the accent, `working · 41 s` in the mono beside it. Alone
     under the text it keeps its old room. */
  .activity .working .roll {
    color: var(--accent);
  }
  .working-text {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  /* The moon rolls inside a track of its own, so the text after it starts
     past the far end of the roll rather than under it (his 2026-09-16
     screenshot: the moon rolling over "working · 29 s"); it is drawn a
     size up while it rolls. The moon a size up again (backlog 212,
     2026-09-25, "still feels kinda small": 14 → 20 in the block, 20 → 28
     alone), so the track is the 32 px roll plus the larger moon. */
  .roll {
    display: inline-flex;
    flex: none;
    width: 60px;
  }
  .roll :global(svg) {
    animation: roll 1.5s ease-in-out infinite alternate;
  }
  @keyframes roll {
    from {
      transform: translateX(0) rotate(0deg);
    }
    to {
      transform: translateX(32px) rotate(360deg);
    }
  }
  .dots {
    display: none;
    gap: 5px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.55;
  }
  @media (prefers-reduced-motion: reduce) {
    .roll {
      display: none;
    }
    .dots {
      display: inline-flex;
    }
  }
  /* The call's own hover control (backlog 066): past the row's right end,
     shown when the call is hovered or the control focused, like the turn's
     tools under the bubble. */
  .block-tools {
    position: absolute;
    right: -30px;
    top: 0;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .tool:hover .block-tools,
  .block-tools:focus-within {
    opacity: 1;
  }
  /* Open as tab beside Remove (backlog 160): the pair in the same gutter. */
  .block-tools.two {
    right: -52px;
    display: flex;
    gap: 2px;
  }
  /* Item 592: where the transcript's gutter is too narrow for them
     (`narrow-gutter`, measured in Transcript.svelte) — his zoom — they come
     inside the row's top right corner, on their panel fill, instead of
     past the edge. */
  :global(.transcript.narrow-gutter) .block-tools,
  :global(.transcript.narrow-gutter) .block-tools.two {
    right: 6px;
    top: 6px;
  }
  .arow.agent-drag {
    cursor: grab;
  }
  .tool-btn {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    background: var(--panel);
    border: 1px solid transparent;
    border-radius: var(--r1);
    color: var(--dim);
    padding: 0;
    cursor: pointer;
  }
  .tool-btn:hover,
  .tool-btn:focus-visible {
    color: var(--ink);
    border-color: var(--line2);
  }
  /* Remove (item 356): red on hover, so it never reads as Edit. */
  .tool-btn.danger:hover,
  .tool-btn.danger:focus-visible {
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 45%, transparent);
  }
  /* A removed block: the placeholder in the tool line's face, greyed and
     italic like a removed turn, Restore at its side. */
  .removed-block {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
  }
  .removed-original {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--dim);
  }
  .removed-original summary {
    cursor: pointer;
    list-style: none;
    opacity: 0.6;
    font-style: italic;
  }
  .removed-original summary::-webkit-details-marker {
    display: none;
  }
  .removed-body {
    margin-top: 0.3rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.6;
    font-family: var(--transcript-font, var(--sans));
    font-size: calc(var(--transcript-size, 16px) - 2px);
  }
  .removed-body.tool-chip {
    font-family: var(--mono);
    font-size: 0.78rem;
    cursor: default;
  }
  .tool-chip {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--dim);
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    min-width: 0;
  }
  .tool-line {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-result {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--dim);
    background: var(--term);
    border: 1px solid var(--border);
    border-radius: var(--r1);
    padding: 0.5rem 0.65rem;
    max-height: 14rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .denied-note {
    color: var(--dim);
    font-size: 0.78rem;
    word-break: break-word;
    padding: 0 12px 6px 40px;
  }
  .row-wrap > .tool-result {
    margin: 0 12px 8px 40px;
  }
  /* The interruption card (084 pass 2) keeps the block's width, in from
     its edges by the row's own padding. */
  .row-wrap > :global(.approval) {
    margin: 4px 12px 8px;
  }
  .tool-result.error {
    color: var(--failed);
    background: var(--failed-soft);
    border-color: var(--failed);
  }
  /* A notice row (a compaction, a crossing): the board's ruled amber mono
     (Handoff.dc.html) — a rule either side, the words between. */
  .notice {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--partial);
  }
  .notice::before,
  .notice::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  /* The cards under a reply (backlog 078): one row each, the composer's
     attachment chip's shape — badge · name · size · buttons — in the
     existing tokens. */
  .cards {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  /* The board's card (Cards.dc.html): 8 × 12 inside, the sheet, at most
     560 wide; the title 13.5px, a path in the mono at 12.5px. */
  .card {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: min(100%, 560px);
    min-width: 0;
    padding: 8px 12px;
    border: 1px solid var(--line2);
    border-radius: var(--r2);
    background: var(--raised);
    font-size: 13.5px;
    color: var(--ink);
  }
  .card-ico {
    display: inline-flex;
    color: var(--accent);
    flex: none;
  }
  .card-ext {
    flex: none;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--bg);
    background: var(--dim);
    border-radius: 4px;
    padding: 2px 5px;
  }
  .card-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .card-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-title.mono {
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .card-sub,
  .card-size {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-size {
    flex: none;
  }
  .card .ns-btn {
    flex: none;
    gap: 4px;
  }
  /* A sent file is dragged out by its body (backlog 343). */
  .card.sent {
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }
  .meta {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  .meta.stopped {
    font-family: var(--sans);
    color: var(--failed);
  }
  .meta.plan {
    cursor: default;
    white-space: nowrap;
  }
  .meta.share {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  /* The time, after the figures, in the interface face rather than their
     mono: it is a phrase, not a number. */
  .meta.when {
    font-family: var(--sans);
    cursor: default;
  }
  /* The footer's pencil and remove (backlog 121): hidden until the reply
     is hovered or one has the focus, the tool rows' rule. */
  .footer-tools {
    display: inline-flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .assistant:hover .footer-tools,
  .footer-tools:focus-within {
    opacity: 1;
  }
  .share-bar {
    display: inline-block;
    width: 56px;
    height: 4px;
    border-radius: 2px;
    background: var(--line2);
    overflow: hidden;
  }
  .share-fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }
</style>
