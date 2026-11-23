// Item 856 (2026-11-19): the behaviour of AssistantMessage, once. `AssistantMessage.svelte` (Jarvis) and
// `AssistantMessageClassic.svelte` mount this and keep only their markup and CSS; `logic.test.ts` beside it fails when
// one look binds to something the other does not. Moved verbatim from AssistantMessage.svelte's script.
// Every Copy button goes through the in-app clipboard ring (backlog 173).
import { copyText } from "../clipRing.svelte";
import { type Segment, addToast, app, openContent, startContentDrag, type SubagentRow } from "../state.svelte";
import { gapLead, gapPhase, liveFor } from "../liveContext";
import { shortTokens } from "../contextDial";
import { liveContextOf, stepMarksOf } from "../liveContext.svelte";
import { type ApprovalRequest, type Usage } from "../types";
import { type RunBlocks } from "../codeCopy";
import { type NextChat } from "../handoffButton";
import { runBlock, type RunFrom } from "../shellRun.svelte";
import { flipOverride, resolveOpen, segmentIds, transcript, type BlockKind, type Override } from "../transcriptPrefs.svelte";
import { groupSegments, modelOmitsThinking, resolveFolded, waitingLabel } from "../activity";
import { type IconName } from "../icons";
import { fmtTokens, sizeTitle, type TurnSize } from "../tokens";
import { artifactLinks, displayPath, noteForPath, pathCandidates, type ArtifactLink } from "../cards";
import * as api from "../api";
import { agentCallContent, isAgentCall } from "../subagentRows";
import { type TabContent } from "../tabs";
import { textId } from "../listen";
import { COPIED_MS } from "../copyIcon";
import { hitsOfCalls } from "../memoryHits";
import { isDragMove, sentFilesOfCalls, type SentFile } from "../sentFiles";
import { memoryEditOf, type MemoryEdit } from "../memoryEdits";
import { type ReplyUsageView } from "../replyUsage";
import { isStandIn } from "../replyFooter";
import { waitingOn } from "../stillRunning";
// The streaming motion (backlog 342, his pick of 338: "Loom + fade-in").
import { Births } from "../replyMotion";
// The thinking block's arrival (backlog 389): a live thinking row's first
// appearance is thrown in along the send flight's path, not spawned.
import { FRESH_MS, type ArrivalParams } from "../thinkingArrival";
import { type RampParams } from "../stepRamp";
// Item 564 (Filament IV stage 5): the turn trace's clock and the stream speed.
import { untrack } from "svelte";
// Item 589: the running step's motion, a variant per kind of step.
import { type StepMotion } from "../stepMotion.svelte";
import { SpeedMeter, barOf, fmtSecs, sparkPoints, stepKeys, traceBook, type TraceRecord } from "../turnTiming";
// Item 495 part 2: the folds kept past a chat switch.
import { decodeOverride, encodeOverride, foldKey, keptGet, keptSet, type FoldScope } from "../keptFolds.svelte";
import "../replyMediaMac";

export type AssistantMessageLogicProps = {
    segs: Segment[];
    footer?: Footer | null;
    streaming?: boolean;
    /** When the live turn was sent (ms since epoch), for the `working · 41 s`
     *  row (backlog 096); absent, the count starts when this mounts. */
    since?: number | null;
    /** The model answering a live turn (item 525), for the header while no
     *  footer says; null draws the header without one. */
    model?: string | null;
    /** Item 903: the model picked for a live turn; when the CLI runs
     *  another, the header says so ("Opus 5.5 — not Fable 5.2 as picked"). */
    picked?: string | null;
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
  };

export interface Footer {
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

// The cards under the reply (backlog 078): an artifact the model published
// and a file it wrote, read out of the reply's text once it has stopped
// streaming — a path half-typed mid-stream is not a file yet. The links
// are a pure function of the text; the files are whatever the backend
// finds on disk among the candidates, so a path the model made up stays
// text. Run once per finished reply: a recorded reply's text never changes.
export interface FileCard {
  path: string;
  label: string;
  size: number;
}

export function assistantMessageLogic(props: () => AssistantMessageLogicProps) {
  const segs = $derived(props().segs);
  const footer = $derived(props().footer ?? null);
  const streaming = $derived(props().streaming ?? false);
  const since = $derived(props().since ?? null);
  const model = $derived(props().model ?? null);
  const size = $derived(props().size ?? null);
  const limit = $derived(props().limit ?? null);
  const approvals = $derived(props().approvals ?? []);
  const onremove = $derived(props().onremove ?? null);
  const onrestore = $derived(props().onrestore ?? null);
  const controlsTitle = $derived(props().controlsTitle ?? "");
  const originals = $derived(props().originals ?? null);
  const diff = $derived(props().diff ?? false);
  const clock = $derived(props().clock ?? Date.now());
  const headed = $derived(props().headed ?? true);
  const onedit = $derived(props().onedit ?? null);
  const onremoveturn = $derived(props().onremoveturn ?? null);
  const planUsage = $derived(props().planUsage ?? null);
  const onretry = $derived(props().onretry ?? null);
  const cliSession = $derived(props().cliSession ?? null);
  const folds = $derived(props().folds ?? null);
  const runFrom = $derived(props().runFrom ?? null);
  const nextChat = $derived(props().nextChat ?? null);
  const motion = $derived(props().motion ?? null);
  /** The turn's text segments, for Copy — thinking and tool traffic are not
   *  what anyone means by "copy the reply". */
  function textOf(): string {
    return segs
      .filter((s) => s.kind === "text")
      .map((s) => s.text)
      .join("\n\n");
  }
  /** Item 801: where Listen keeps this reply's place — its words' own id,
   *  so the same reply keeps its place in the chat and in an aside. */
  const listenId = $derived(textId(textOf()));
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
  /** Item 700: whether a soft error's box is open (folded by default),
   *  read by its own key — `overrides` holds the rows' and blocks' only. */
  function softOpen(key: string): boolean {
    const o = folds ? decodeOverride(keptGet(foldKey(folds, key), "")) : local[key];
    return o?.open === true;
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
  // Item 700: the main reply has ended and the turn waits only on its
  // background agents — the line says so (`waiting on 2 agents · 2 min 58 s`)
  // and a light runs round the trace block's edge until the turn moves.
  const waitAgents = $derived(streaming ? waitingOn(segs, app.subagents) : null);
  // Item 829: the gap between steps says what the model is doing — reading
  // the chat before its first word, or writing a call the trace shows only
  // once it is whole (`gapPhase`).
  const phase = $derived.by(() => {
    if (!streaming) return null;
    const sent = since ?? startedAt;
    return gapPhase(liveFor(liveContextOf(app.activeSessionId), sent), { sentAt: sent, ...stepMarksOf(app.activeSessionId) });
  });
  const working = $derived(waitingLabel(waitAgents, now - (since ?? startedAt), gapLead(phase, shortTokens)));

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
    const w = whoOf(m);
    // Item 903: a live turn on another model than picked says so at once.
    const p = props().picked;
    if (!footer && p && m && w.model && sameModelId(p, m) === false) {
      const pw = whoOf(p);
      return { ...w, model: `${w.model} — not ${pw.model || p} as picked` };
    }
    return w;
  });
  function whoOf(m: string): { name: string; model: string } {
    const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
    if (x) return { name: "Claude", model: `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` };
    return m.startsWith("claude") || !m ? { name: "Claude", model: m.replace(/^claude-?/, "") } : { name: m, model: "" };
  }
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
  // Item 667: a running step's motion eases in over its first 5 s
  // (stepRamp.ts). Fresh = it began in view: a thinking block by its own
  // clock (as its arrival, 389); a call born mid-turn under this reply, or
  // in the first moments of a turn just sent. A step already under way when
  // the chat opened runs at today's pace from the start.
  function rampThink(i: number, at: number | undefined, live: boolean): RampParams {
    const fresh = at !== undefined ? Date.now() - at < FRESH_MS : Date.now() - (since ?? startedAt) < 2000;
    return { key: at !== undefined ? `think:${at}` : `think:${since ?? startedAt}:${ids[i]}`, fresh, live };
  }
  function rampTool(id: string, born: boolean, live: boolean): RampParams {
    return { key: `tool:${id}`, fresh: born || Date.now() - (since ?? startedAt) < 2000, live };
  }
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

  return {
    get SPEED_TITLE() {
      return SPEED_TITLE;
    },
    agentTabOf,
    get approvals() {
      return approvals;
    },
    barFor,
    barTitle,
    get births() {
      return births;
    },
    blockArrival,
    get cliSession() {
      return cliSession;
    },
    get clock() {
      return clock;
    },
    get controlsTitle() {
      return controlsTitle;
    },
    get copied() {
      return copied;
    },
    set copied(v) {
      copied = v;
    },
    copy,
    detailsKey,
    get diff() {
      return diff;
    },
    dragAgent,
    get files() {
      return files;
    },
    set files(v) {
      files = v;
    },
    firstLine,
    fmtCost,
    fmtFigure,
    get footer() {
      return footer;
    },
    footerTitle,
    get groups() {
      return groups;
    },
    get headed() {
      return headed;
    },
    helperContext,
    get ids() {
      return ids;
    },
    isFolded,
    isOpen,
    keyClick,
    keyFold,
    get lastGroup() {
      return lastGroup;
    },
    get limit() {
      return limit;
    },
    get links() {
      return links;
    },
    get listenId() {
      return listenId;
    },
    memEditsOf,
    get memGroups() {
      return memGroups;
    },
    get memHits() {
      return memHits;
    },
    get moonAlone() {
      return moonAlone;
    },
    get moonInBlock() {
      return moonInBlock;
    },
    get motion() {
      return motion;
    },
    get nextChat() {
      return nextChat;
    },
    get onedit() {
      return onedit;
    },
    get onremove() {
      return onremove;
    },
    get onremoveturn() {
      return onremoveturn;
    },
    get onrestore() {
      return onrestore;
    },
    get onretry() {
      return onretry;
    },
    openFile,
    openLink,
    openSent,
    get originals() {
      return originals;
    },
    get planUsage() {
      return planUsage;
    },
    press,
    pressFold,
    get pressed() {
      return pressed;
    },
    set pressed(v) {
      pressed = v;
    },
    rampThink,
    rampTool,
    get replyClock() {
      return replyClock;
    },
    revealFile,
    get roots() {
      return roots;
    },
    rowOf,
    runBlocks,
    get runFrom() {
      return runFrom;
    },
    saveSent,
    get segs() {
      return segs;
    },
    get sent() {
      return sent;
    },
    sentDown,
    sentMove,
    setOverride,
    get size() {
      return size;
    },
    softOpen,
    get spark() {
      return spark;
    },
    set spark(v) {
      spark = v;
    },
    get speed() {
      return speed;
    },
    set speed(v) {
      speed = v;
    },
    get standIn() {
      return standIn;
    },
    stepMs,
    get stepNo() {
      return stepNo;
    },
    get streaming() {
      return streaming;
    },
    get summarised() {
      return summarised;
    },
    textOf,
    thinkSize,
    thoughtLabel,
    timed,
    toolIcon,
    traceFoot,
    get traceRec() {
      return traceRec;
    },
    get waitAgents() {
      return waitAgents;
    },
    get who() {
      return who;
    },
    get working() {
      return working;
    },
  };
}

/** Item 903: two model ids name the same model (case and a `[1m]` tag
 *  aside). */
export function sameModelId(a: string, b: string): boolean {
  const id = (m: string) => m.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  return id(a) === id(b);
}
