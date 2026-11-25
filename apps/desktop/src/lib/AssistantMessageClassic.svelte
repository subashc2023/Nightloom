<script lang="ts">
  import { tip } from "./tip";
  // Every Copy button goes through the in-app clipboard ring (backlog 173).
  import { copyText } from "./clipRing.svelte";
  // Item 626: while streaming, the unfinished tail renders as it will once finished (streamingTail); item 830: by blocks.
  import { renderReply } from "./markdown";
  import MathText from "./MathText.svelte";
  import { askSettled } from "./askSettled";
  import { renderStreamingParts } from "./streamBlocks";
  // Item 820: pictures and video the reply names, drawn under its text.
  import ReplyMedia from "./ReplyMedia.svelte";
  import { replyMediaInline, stripMedia } from "./replyMediaInline";
  // Item 770: a page a reply wrote, drawn where its block stands.
  import { replyPages } from "./replyPages";
  import { liveHtml } from "./liveHtml";
  import { codeCopy } from "./codeCopy";
  import { handoffGo } from "./handoffButton";
  import { openAgentTab } from "./terminal.svelte";
  import { isShellCall } from "./agentCommands";
  import CouncilBlocks from "./CouncilBlocks.svelte";
  // Item 721 (his yes, ~1:45 AM 2026-11-16): the running command's passing
  // text, headed by its first line, in Classic too — ~~Classic left
  // unchanged (blocker 1931's default)~~, the item names Classic.
  import BashPassing from "./BashPassing.svelte";
  import { passingEnded } from "./bashOutput.svelte";
  import { parseCouncilRecord, parseCouncilSeat } from "./council";
  import { wordDiff } from "./textdiff";
  import { exactTime, relativeTimeLong } from "./time";
  import { compactJson } from "./toolinput";
  import { toolInputSummary, toolResultSummary, toolSummary, transcript } from "./transcriptPrefs.svelte";
  import { HIDDEN_THINKING_TITLE, activitySummary, shortToolName, thinkingHidden } from "./activity";
  import { fmtShare, fmtTokens, shareOf, sizeTitle } from "./tokens";
  // Item 856: the running clock and a helper's context, as words.
  import { HELPER_WINDOW } from "./stepMotion.svelte";
  import type { Segment } from "./state.svelte";
  import { fmtSecs } from "./turnTiming";
  import { displayPath, extOf, fmtSize } from "./cards";
  import { app, openContent } from "./state.svelte";
  import { agentRowLine, isAgentCall } from "./subagentRows";
  // Item 718: a helper row says whether it is a new helper or a continued one.
  import { helperMark } from "./helperMark";
  import ApprovalPrompt from "./ApprovalPrompt.svelte";
  import AskAnswered from "./AskAnswered.svelte";
  import Icon from "./Icon.svelte";
  import CopyButton from "./CopyButton.svelte";
  import ListenButton from "./ListenButton.svelte";
  import { here as listenHere } from "./listenHere";
  import { REMOVED_TEXT_PLACEHOLDER, REMOVED_TOOL_PLACEHOLDER } from "./edit";
  import { removeTip } from "./removeAsk";
  import MemoryHits from "./MemoryHits.svelte";
  import { sentExt } from "./sentFiles";
  import { memoryRefs, openMemoryEdit } from "./memoryOpen";
  import { footerStopNote, hasUsage, isSignedOut } from "./replyFooter";
  import EditDiffView from "./EditDiffView.svelte";
  import { editDiffOf } from "./editDiff";
  import ToolImagesView from "./ToolImagesView.svelte";
  import { namesImage } from "./toolImages.svelte";
  import SignedOutNotice from "./SignedOutNotice.svelte";
  import StillRunningLine from "./StillRunningLine.svelte";
  import { errorWeight, retriedAfter, softLine } from "./errorWeight";
  import MidTurnBubble from "./MidTurnBubble.svelte";
  import RetryLine from "./RetryLine.svelte";
  // The streaming motion (backlog 342, his pick of 338: "Loom + fade-in").
  import { needleIn, needleOut, replyMotion } from "./replyMotion";
  // The thinking block's arrival (backlog 389): a live thinking row's first
  // appearance is thrown in along the send flight's path, not spawned.
  import { thinkingArrival } from "./thinkingArrival";
  // Item 495 part 2: the folds kept past a chat switch.
  import { keptOpen } from "./keptFolds.svelte";
  import { assistantMessageLogic, type AssistantMessageLogicProps } from "./assistantMessage/logic.svelte";

  // Item 856: the behaviour lives once, in `assistantMessage/logic.svelte.ts`; this file is the look.
  const props: AssistantMessageLogicProps = $props();
  const T = assistantMessageLogic(() => props);
</script>

<!-- Item 700: a soft error's box folds to one amber line; a click opens it whole. -->
{#snippet softBox(id: string, content: string, retried: boolean)}
  {@const key = `soft:${id}`}
  {@const boxOpen = T.softOpen(key)}
  <button class="tool-result soft soft-line" class:open={boxOpen} aria-expanded={boxOpen}
    use:tip={boxOpen ? "Fold the notice to one line" : "Show the notice whole"}
    onpointerdown={(e) => {
      // Item 920: on the press, as the rows (backlog 052) — while a reply
      // streams the box moves under the pointer and a click never lands.
      if (e.button === 0) T.setOverride(key, { open: !boxOpen, rev: transcript.rev.tool });
    }}
    onclick={(e) => {
      if (e.detail === 0) T.setOverride(key, { open: !boxOpen, rev: transcript.rev.tool });
    }}
    >{#if boxOpen}<span class="soft-full">{content}</span>{:else}<span class="soft-sum">{softLine(content, retried)}</span>{/if}</button>
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
  <details class="sub" use:keptOpen={{ key: T.detailsKey(`tool:${parent}:sub`) }}>
    <summary class="sub-line">
      <span class="ico">▸</span>
      <span class="name">subagent</span>
      <span class="arg">
        <!-- Keyed on the counts so a change flashes accent under a live row (backlog 342). -->
        {#key `${calls}:${words}`}<span class="rm-count">{#if names}{names}{calls > 4 ? ", …" : ""}{" · "}{/if}{#if calls}{calls} call{calls === 1 ? "" : "s"}{/if}{#if calls && words}{" · "}{/if}{#if words}{words} words{T.streaming ? " so far" : ""}{/if}</span>{/key}
      </span>
    </summary>
    <div class="sub-body">
      {#each children as c, k (k)}
        {#if c.kind === "tool"}
          {@const icon = T.toolIcon(c.call.name)}
          {@const childDiff = editDiffOf(c.call.name, c.call.input)}
          {@const childShell = isShellCall(c.call.name)}
          {@const childRun = childShell && T.streaming && !c.call.result && !c.call.denied}
          {@const childRem = childShell && !childRun && passingEnded(c.call.id)}
          <div class="arow static" class:error={!c.call.denied && errorWeight(c.call.result) === "hard"}
            class:soft={!c.call.denied && errorWeight(c.call.result) === "soft"} class:sub-pass={childRun || childRem}>
            {#if childRun || childRem}<BashPassing id={c.call.id} ended={childRem} input={c.call.input} />{/if}
            <span class="ico">{#if icon}<Icon name={icon} size={13} />{:else}⚒{/if}</span>
            <span class="name" use:tip={c.call.name}>{shortToolName(c.call.name)}</span>
            <span class="arg">{toolInputSummary(c.call.input)}</span>
            <span class="size">{toolResultSummary(c.call, T.streaming)}</span>
          </div>
          {#if childDiff}
            <!-- A subagent's edit as a diff too (backlog 433). -->
            <EditDiffView diff={childDiff} denied={!!c.call.denied} keep={T.detailsKey(`tool:${c.call.id}:diff`)} />
          {/if}
          {#if !c.call.denied && namesImage(c.call.result?.content)}
            <!-- A subagent's screenshot too (item 476): read from its own
                 file under the session's subagents/ folder. -->
            <ToolImagesView session={T.cliSession} id={c.call.id} name={shortToolName(c.call.name)} />
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


<div class="assistant" use:replyMotion={T.streaming}>
  <!-- Item 856: Classic draws Jarvis's header facts (item 525, 564) as plain
       words — who is answering, and while live "Replying m:ss · ~38 tok/s";
       the sparkline is Jarvis's alone. -->
  {#if T.headed && (T.footer || T.streaming)}
    <span class="ns-k" use:tip={T.footer && !T.standIn ? T.footer.model : undefined}
      >{T.who.name}{#if T.who.model}{" "}{T.who.model}{/if}{#if T.streaming}{" "}· Replying {T.replyClock}{#if T.speed !== null}{" "}<span
            use:tip={T.SPEED_TITLE}>· ~{Math.round(T.speed)} tok/s</span
          >{/if}{/if}</span
    >
  {/if}
  {#each T.groups as g (g.kind === "activity" ? g.key : `one:${g.i}`)}
    {#if g.kind === "activity"}
      {@const folded = T.isFolded(g.key)}
      {@const last = T.moonInBlock && g === T.lastGroup}
      <!-- Item 856: the trace foot's facts (item 564) in Classic's fold line —
           how long the turn ran, and its stream speed once done. -->
      {@const foot = T.traceFoot(g.rows)}
      <!-- One block for the run: a left rule, accent while the turn is
           live; a summary line that folds and unfolds the rows; the rows
           on one grid — icon · name · argument · size (backlog 096). -->
      <div class="activity" class:live={T.streaming} use:thinkingArrival={T.blockArrival(g.rows)}>
        <button
          class="fold"
          aria-expanded={!folded}
          use:tip={folded ? "Show the calls" : "Fold to one line"}
          onpointerdown={(e) => T.pressFold(e, g.key)}
          onclick={(e) => T.keyFold(e, g.key)}
        >
          <span class="caret">{folded ? "▸" : "▾"}</span>
          <span class="fold-text"
            >{activitySummary(g.rows, T.streaming)}{#if foot.elapsed}{" "}· {foot.elapsed}{/if}{#if !T.streaming && T.traceRec?.tps}{" "}· ~{Math.round(
                T.traceRec.tps,
              )} tok/s{/if}</span
          >
        </button>
        {#if !folded}
          {#each g.rows as { seg, i } (T.ids[i] || i)}
            {#if seg.kind === "thinking"}
              {#if thinkingHidden(seg)}
                <!-- The model thought and returned nothing of it (backlog
                     097): a fact in the dim style, no pointer, nothing to
                     open — a button here did nothing, which is what he
                     saw. -->
                <div class="arow static thinking hidden wide" use:tip={HIDDEN_THINKING_TITLE}>
                  <span class="ico"><Icon name="think" size={13} /></span>
                  <span class="name">thought · hidden by the model</span>
                  <span class="size">{T.thinkSize(i, seg)}</span>
                </div>
              {:else if !seg.done && seg.text.trim() === ""}
                <!-- Begun, nothing arrived yet: under way, not yet a button.
                     A thinking later in a block arrives on its own row (389). -->
                <div
                  class="arow static thinking wide"
                  use:thinkingArrival={{ at: seg.at, live: T.streaming && g.rows[0].i !== i }}
                >
                  <span class="ico"><Icon name="think" size={13} /></span>
                  <span class="name">thinking</span>
                  <span class="size">{T.thinkSize(i, seg)}</span>
                </div>
              {:else}
                {@const summary = T.summarised && seg.done}
                {@const bornT = T.births.of(T.ids[i] || `think:${i}`, T.streaming, seg.done)}
                <!-- The needle (backlog 342): a live block's margin thread is
                     accent with a glowing needle at its newest line; on done
                     the thread retracts and the icon turns once. -->
                <div class="row-wrap" class:rm-live={T.streaming && !seg.done} class:rm-thought={bornT && seg.done}
                  use:thinkingArrival={{ at: seg.at, live: T.streaming && !seg.done && g.rows[0].i !== i }}>
                  <button
                    class="arow thinking"
                    class:wide={!summary}
                    aria-expanded={T.isOpen(i, seg)}
                    use:tip={T.isOpen(i, seg) ? "Hide the thinking" : "Show the thinking"}
                    onpointerdown={(e) => T.press(e, i, seg)}
                    onclick={(e) => T.keyClick(e, i, seg)}
                  >
                    <span class="ico"><Icon name="think" size={13} /></span>
                    <span class="name">{T.thoughtLabel(seg)}</span>
                    {#if summary}<span class="arg summary"><MathText text={T.firstLine(seg.text)} /></span>{/if}
                    <!-- Item 856: the step's time (item 564's size column) before its fold mark. -->
                    <span class="size">{T.thinkSize(i, seg)}{#if seg.done}{" "}{T.isOpen(i, seg) ? "▾" : "▸"}{/if}</span>
                  </button>
                  {#if T.isOpen(i, seg)}
                    <div
                      class="thinking-text"
                      in:needleIn|global={{ on: T.births.settled }}
                      out:needleOut={{ on: T.births.settled }}
                    ><MathText text={seg.text} /></div>
                  {/if}
                </div>
              {/if}
            {:else if seg.kind === "redacted"}
              <div class="arow static thinking wide">
                <span class="ico"><Icon name="think" size={13} /></span>
                <span class="name">redacted thinking</span>
                <span class="size">{T.thinkSize(i, seg)}</span>
              </div>
            {:else if seg.kind === "tool"}
              {@const open = T.isOpen(i, seg)}
              <!-- Item 700: soft (amber) for a "not run, redo it" notice, hard (red) for a real failure. -->
              {@const weight = seg.call.denied ? null : errorWeight(seg.call.result)}
              {@const soft = weight === "soft"}
              {@const bad = weight === "hard" || !!seg.call.denied}
              {@const icon = T.toolIcon(seg.call.name)}
              {@const agentTab = T.agentTabOf(seg.call)}
              {@const agentRow = agentTab ? T.rowOf(seg.call.id) : null}
              {@const running = T.streaming && !seg.call.result && !seg.call.denied}
              {@const bornW = T.births.of(T.ids[i] || `tool:${i}`, T.streaming, !running)}
              {@const editDiff = editDiffOf(seg.call.name, seg.call.input)}
              {@const hm = helperMark(seg.call, app.subagents, app.activeSessionId, T.streaming)}
              {@const shell = isShellCall(seg.call.name)}
              {@const remnant = !running && shell && passingEnded(seg.call.id)}
              <!-- Item 856: a running helper's context (item 616's bar) as words. -->
              {@const ctx = running ? T.helperContext(seg.call) : null}
              <div class="row-wrap tool" class:rm-born={bornW} class:rm-finished={bornW && !running} class:bash-pass={(running && (shell || isAgentCall(seg.call.name))) || remnant}>
                <!-- Item 721: the command's real output passing behind the row,
                     headed by its first line; its remnant a moment after. -->
                {#if running && shell}<BashPassing id={seg.call.id} input={seg.call.input} />{/if}
                {#if remnant}<BashPassing id={seg.call.id} ended input={seg.call.input} />{/if}
                <!-- Item 761: a spawn the hook holds for a sibling's first reply says so. -->
                {#if running && isAgentCall(seg.call.name)}<BashPassing id={seg.call.id} />{/if}
                <!-- An Agent call's row is a drag source (backlog 160): its
                     subagent's transcript as a tab, dropped on a strip or a
                     pane's half — live while it runs (guess pass 2026-09-25,
                     question 19). -->
                <button
                  class="arow"
                  class:error={bad}
                  class:soft
                  class:agent-drag={!!agentTab}
                  aria-expanded={open}
                  use:tip={agentTab
                    ? `${open ? "Collapse to one line" : "Expand this call"} — drag onto a tab strip to open the agent's transcript as a tab`
                    : open
                      ? "Collapse to one line"
                      : "Expand this call"}
                  draggable={agentTab ? "true" : undefined}
                  ondragstart={agentTab ? (e) => T.dragAgent(e, i, seg, agentTab) : undefined}
                  ondragend={agentTab ? (e) => T.dragAgentEnd(e) : undefined}
                  onpointerdown={(e) => T.press(e, i, seg)}
                  onclick={(e) => T.keyClick(e, i, seg)}
                >
                  <span class="ico">{#if icon}<Icon name={icon} size={13} />{:else}⚒{/if}</span>
                  <span class="name" use:tip={seg.call.name}>{shortToolName(seg.call.name)}</span>
                  <span class="arg"
                    >{#if hm}<span class="hm" class:cont={hm.kind === "continued"} use:tip={hm.title} data-testid="helper-mark" data-kind={hm.kind}
                        >{#if hm.kind === "continued"}<span class="hm-g" aria-hidden="true">↻</span>{/if}{hm.label}</span
                      >{/if}{toolInputSummary(seg.call.input)}</span
                  >
                  <span class="size" use:tip={agentRow ? `${seg.call.name} call · ${toolResultSummary(seg.call, T.streaming)}` : undefined}
                    >{agentRow ? agentRowLine(agentRow) : running && T.stepMs(i) !== null ? `running ${fmtSecs(T.stepMs(i)!)}` : toolResultSummary(seg.call, T.streaming)}{#if ctx !== null}{" "}<span
                        class="ctx-lbl">· context {fmtTokens(ctx)} / {fmtTokens(HELPER_WINDOW)} · {Math.round((ctx / HELPER_WINDOW) * 100)}%</span
                      >{/if}</span
                  >
                </button>
                {#if bornW && T.streaming}
                  <!-- The weft (backlog 342): an accent thread draws across the
                       row as it appears, a bright shuttle runs along it while
                       the call runs, and on finish it fills and fades. -->
                  <span class="rm-weft" class:rm-done={!running} aria-hidden="true"></span>
                {/if}
                <!-- A file edit as a diff (backlog 433), drawn whether the row is
                     open or not: the change is what the row is about. -->
                {#if editDiff}
                  <EditDiffView diff={editDiff} denied={!!seg.call.denied} keep={T.detailsKey(`tool:${seg.call.id}:diff`)} />
                {/if}
                <!-- What a screenshot showed the model (backlog 434). -->
                {#if !seg.call.denied && namesImage(seg.call.result?.content)}
                  <ToolImagesView session={T.cliSession} id={seg.call.id} name={shortToolName(seg.call.name)} />
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
                  {:else if soft}
                    {@render softBox(seg.call.id, seg.call.result!.content, retriedAfter(T.segs, i))}
                  {:else if seg.call.result}
                    <pre
                      class="tool-result"
                      class:error={bad}>{seg.call.result.content}</pre>
                  {/if}
                {/if}
                <!-- Outside the collapse: a call parked at the gate needs its prompt
                     on screen whatever the toggle says, or the turn waits on a
                     decision nobody can see. -->
                {#each T.approvals.filter((a) => a.id === seg.call.id) as req (req.id)}
                  <ApprovalPrompt {req} />
                {/each}
                <!-- 354: what he answered, under the question once it is no longer waiting. -->
                {#if seg.call.name === "AskUserQuestion" && !T.approvals.some((a) => a.id === seg.call.id)}
                  <AskAnswered call={seg.call} ended={!T.streaming} />
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
                {#if (T.onremove && seg.block != null) || agentTab || (isShellCall(seg.call.name) && T.runFrom?.chat)}
                  <span
                    class="block-tools"
                    class:two={(!!agentTab || isShellCall(seg.call.name)) && !!T.onremove && seg.block != null}
                    use:tip={T.onremove && seg.block != null ? T.controlsTitle : ""}
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
                    {#if isShellCall(seg.call.name) && T.runFrom?.chat}
                      <!-- Item 503: this chat's commands as a view-only terminal. -->
                      <button
                        class="tool-btn"
                        use:tip={"Show this chat's commands in the terminal"}
                        aria-label="Show this chat's commands in the terminal"
                        onclick={() => T.runFrom?.chat && openAgentTab(T.runFrom.chat)}
                      >
                        <Icon name="term" size={12} />
                      </button>
                    {/if}
                    {#if T.onremove && seg.block != null}
                      <button
                        class="tool-btn"
                        use:tip={"Remove this tool call and its result from the context. Both stay in the log; Restore is on the placeholder."}
                        aria-label="Remove this tool call and its result from the context"
                        onclick={() => T.onremove?.(seg.block!)}
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
              {#each T.approvals.filter((a) => a.id === seg.call.id) as req (req.id)}
                <ApprovalPrompt {req} />
              {/each}
              {#if seg.call.name === "AskUserQuestion" && !T.approvals.some((a) => a.id === seg.call.id)}
                <AskAnswered call={seg.call} ended={!T.streaming} />
              {/if}
            {/if}
          {/each}
        {/if}
        {#if last}
          <div class="working" role="status" aria-label={T.working}>
            <span class="roll" aria-hidden="true"><Icon name="moon" size={20} /></span>
            <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="working-text">{T.working}</span>
          </div>
        {/if}
      </div>
      <!-- What the block changed in memory (backlog 305): one line per
           memory note, AGENTS.md or thread file an edit in it wrote, outside
           the fold so a folded block still says so; it opens the note at
           the change. Read from the calls, so a reload draws it again. -->
      {#each T.memEditsOf(g.rows) as ed, k (k)}
        <button
          class="mem-edit"
          use:tip={`${ed.path} — open at the change`}
          onclick={() => void openMemoryEdit(ed)}
        >
          <Icon name="note" size={12} />
          <span>{ed.verb} <span class="mem-edit-name">{ed.label}</span></span>
        </button>
      {/each}
    {:else if g.seg.kind === "text" && T.standIn && isSignedOut(T.footer?.stop_reason)}
      <!-- Signed out (backlog 409): says so, with Sign in. -->
      <SignedOutNotice reason={T.footer?.stop_reason} />
    {:else if g.seg.kind === "text" && T.standIn}
      <div class="notice nl-own">{g.seg.text}</div>
    {:else if g.seg.kind === "text"}
      {@const councilSeat = parseCouncilSeat(g.seg.text)}
      {@const councilRecord = councilSeat ? null : parseCouncilRecord(g.seg.text)}
      {#if councilSeat || councilRecord}
        <!-- The council's blocks (nightshift backlog 149): a seat's answer
             folded under its map line, the record as the sources table. -->
        <CouncilBlocks seat={councilSeat} record={councilRecord} keep={T.detailsKey(`council:${g.i}`)} />
      {:else if T.diff && T.originals?.[g.i] != null}
        {@const before = T.originals[g.i]!}
        <!-- The edit as a diff over the markdown source (backlog 105): the
             source is what he edited, and a mark inside rendered HTML would
             have to cross links and code spans. The transcript's face. -->
        <div class="markdown textdiff">
          {#each wordDiff(before, g.seg.text) as op, k (k)}{#if op.kind === "del"}<del>{op.text}</del>{:else if op.kind === "add"}<ins>{op.text}</ins>{:else}{op.text}{/if}{/each}
        </div>
      {:else}
        <!-- Item 452: patched in place (liveHtml), not replaced whole per
             streamed delta, so a selection in its written part survives. -->
        <div class="markdown" use:replyPages={{ copy: (t) => void copyText(t) }} use:replyMediaInline={{ chat: app.activeSessionId, roots: T.roots, label: (c) => displayPath(c.path, T.roots), onopen: (p, e) => void T.openFile(p, e) }} use:askSettled use:liveHtml={T.streaming ? renderStreamingParts(g.seg.text) : renderReply(g.seg.text)} use:memoryRefs={{ hits: T.memHits, text: g.seg.text }} use:codeCopy={T.runBlocks(g.seg.text)} use:handoffGo={T.nextChat}></div>
        {#if !T.streaming}
          <!-- Item 820: a picture or a video this text names, right under it. -->
          <ReplyMedia items={stripMedia(g.seg.text, T.roots)} chat={app.activeSessionId} label={(c) => displayPath(c.path, T.roots)} onopen={(p, e) => void T.openFile(p, e)} />
        {/if}
      {/if}
    {:else if g.seg.kind === "removed_tool" || g.seg.kind === "removed_text"}
      {@const seg = g.seg}
      <!-- A removed block's placeholder, greyed, the original a click
           away, Restore beside it (backlog 066). -->
      <div class="removed-block">
        <details class="removed-original" use:keptOpen={{ key: T.detailsKey(`removed:${seg.block}`) }}>
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
              <pre class="tool-result" class:error={errorWeight(seg.call.result) === "hard"} class:soft={errorWeight(seg.call.result) === "soft"}>{seg.call.result.content}</pre>
            {/if}
          {:else}
            <div class="removed-body"><MathText text={seg.text} /></div>
          {/if}
        </details>
        {#if T.onrestore}
          <button
            class="tool-btn"
            use:tip={"Restore to the context"}
            aria-label="Restore to the context"
            onclick={() => T.onrestore?.(seg.block)}
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
  {#if T.moonAlone}
    <div class="working" role="status" aria-label={T.working}>
      <span class="roll" aria-hidden="true"><Icon name="moon" size={28} /></span>
      <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="working-text">{T.working}</span>
    </div>
  {/if}
  {#if T.sent.length > 0}
    <!-- Files the reply sent (backlog 343): the attachment chip — badge,
         name, caption, size, Open, Save, Reveal; dragged, the file itself
         goes where it is dropped. -->
    <div class="cards sent-files">
      {#each T.sent as f (f.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="card file sent"
          draggable="false"
          use:tip={"Drag out to drop the file anywhere"}
          onpointerdown={(e) => T.sentDown(e, f)}
          onpointermove={T.sentMove}
          onpointerup={() => (T.pressed = null)}
        >
          <span class="card-ext">{sentExt(f.name)}</span>
          <span class="card-text">
            <span class="card-title">{f.name}</span>
            {#if f.caption}<span class="card-sub">{f.caption}</span>{/if}
          </span>
          <span class="card-size">{fmtSize(f.size)}</span>
          <button class="ns-btn ghost small" use:tip={"Open with its application"} onclick={() => void T.openSent(f)}>Open</button>
          <button class="ns-btn ghost small" use:tip={"Save a copy where you choose"} onclick={() => void T.saveSent(f)}>Save</button>
          <button class="ns-btn ghost small" use:tip={"Show in the Finder"} onclick={() => void T.revealFile(f.path)}>Reveal</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if !T.streaming && (T.links.length > 0 || T.files.length > 0)}
    <!-- Under the reply text, not inline in it (backlog 078): an artifact
         result as a link card, a file the reply names as the attachment
         card — extension badge, path, size, Open, Reveal. -->
    <div class="cards">
      {#each T.links as l (l.url)}
        <div class="card link" use:tip={l.url}>
          <span class="card-ico"><Icon name="link" size={14} /></span>
          <span class="card-text">
            <span class="card-title">{l.title}</span>
            <span class="card-sub">{l.url.replace(/^https?:\/\//, "")}</span>
          </span>
          <button class="ns-btn ghost small" use:tip={"Open in the browser"} onclick={() => void T.openLink(l.url)}>Open <Icon name="ext" size={11} /></button>
        </div>
      {/each}
      {#each T.files as f (f.path)}
        <div class="card file" use:tip={f.path}>
          <span class="card-ext">{extOf(f.path)}</span>
          <span class="card-text">
            <span class="card-title mono">{f.label}</span>
          </span>
          <span class="card-size">{fmtSize(f.size)}</span>
          <button class="ns-btn ghost small" use:tip={"Open as a tab here — ⌘-click opens it with its application"} onclick={(e) => void T.openFile(f.path, e)}>Open</button>
          <button class="ns-btn ghost small" use:tip={"Show in the file manager"} onclick={() => void T.revealFile(f.path)}>Reveal</button>
        </div>
      {/each}
    </div>
  {/if}
  {#if T.memGroups.length > 0}
    <MemoryHits groups={T.memGroups} />
  {/if}
  {#if T.footer && !T.streaming}
    {@const share = T.size ? shareOf(T.size.tokens, T.limit) : null}
    <div class="footer">
      <CopyButton copied={T.copied} label="Copy this reply" onclick={() => void T.copy()} />
      <!-- Item 801: this reply read aloud, or its Brief. -->
      <ListenButton kind="reply" id={T.listenId} text={T.textOf} source={listenHere} />
      {#if T.onretry}
        <!-- Retry (item 333): the prompt again, in a fork from it; this
             reply stays where it is, a version (‹ ›) away. -->
        <!-- Item 439: called Redo, with Claude's circular arrow, as the
             same action is in the icon row under his last message. -->
        <button
          class="ns-btn ghost small redo"
          use:tip={"Redo: Claude answers your message again, without retyping it. This reply stays — ‹ › under your message flips between the two."}
          aria-label="Redo this reply"
          onclick={() => T.onretry?.()}
        >
          <Icon name="refresh" size={12} /> Redo
        </button>
      {/if}
      {#if !T.footer.bare && (T.size || hasUsage(T.footer.usage))}
        <!-- No figure without usage (backlog 332): a reply cut off before
             its result has none, and "0 out" under its words was wrong. -->
        <span class="meta" use:tip={T.footerTitle(T.footer, T.size)}>{T.fmtFigure(T.footer.usage, T.size)}{T.fmtCost(T.footer.cost)}</span>
      {/if}
      {#if T.planUsage}
        <!-- The turn's share of the plan (item 323): the five-hour window
             and the week, measured or ≈ estimated; hover says how. -->
        <span class="meta plan" use:tip={T.planUsage.title}>{T.planUsage.text}</span>
      {/if}
      {#if footerStopNote(T.footer.stop_reason, T.standIn)}
        <!-- Why the reply stopped (backlog 202): the API error the CLI
             ended it with, as the log recorded it — or that its stream
             ended before the reply did (backlog 332). -->
        <span class="meta stopped">{footerStopNote(T.footer.stop_reason, T.standIn)}</span>
      {/if}
      {#if fmtShare(share)}
        <!-- The reply's share of the window (backlog 090), the gauge's bar
             scaled to it, once the reply is worth a bar. -->
        <span class="meta share" use:tip={T.size ? sizeTitle(T.size, "assistant", T.limit) : ""}>
          <span class="share-bar" aria-hidden="true"><span class="share-fill" style:width="{(share ?? 0) * 100}%"></span></span>
          {fmtShare(share)}
        </span>
      {/if}
      {#if T.footer.at}
        <!-- When the reply landed (backlog 123): in words, the exact
             moment on hover, as Claude Code's footer does. -->
        <span class="meta when" use:tip={exactTime(T.footer.at)}>{relativeTimeLong(T.footer.at, T.clock)}</span>
      {/if}
      {#if T.onedit || T.onremoveturn}
        <!-- The turn's own controls on the same row (backlog 121): they
             were a row of their own under the footer, three rows per
             message in a run of one-call replies. Hidden until the reply
             is hovered, as the transcript's tool rows are. -->
        <span class="footer-tools" use:tip={T.controlsTitle}>
          {#if T.onedit}
            <button
              class="tool-btn"
              use:tip={"Edit this reply in place; the original stays in the log"}
              aria-label="Edit this reply"
              onclick={() => T.onedit?.()}
            >
              <Icon name="pencil" size={14} />
            </button>
          {/if}
          {#if T.onremoveturn}
            <!-- A delete look, apart from Edit's pencil (item 356); the
                 transcript asks before it removes. -->
            <button
              class="tool-btn danger"
              use:tip={removeTip("reply")}
              aria-label="Remove this reply from the chat history"
              onclick={() => T.onremoveturn?.()}
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
    max-width: 640px;
    /* The streaming shuttle (backlog 342) is placed against the reply. */
    position: relative;
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
    line-height: 1.55;
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
    border: 1px solid var(--line);
    border-left: 2px solid var(--line2);
    border-radius: 8px;
    background: color-mix(in srgb, var(--sheet) 60%, transparent);
    min-width: 0;
    /* Not `overflow: hidden`: the call's hover Remove (backlog 066) sits
       past the right edge. */
  }
  .activity.live {
    border-left-color: var(--accent);
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
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  }
  /* The subagent row under an Agent call (backlog 075): the disclosure's
     summary drawn like a row, indented one column in on the paper, its
     body one rule in. */
  .sub {
    margin: 0;
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
    background: color-mix(in srgb, var(--paper) 50%, transparent);
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
    color: var(--ink2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* A thinking row: the name italic and dim, the spark in the accent. A
     hidden one (backlog 097) is dimmer still and no pointer. */
  .arow.thinking .name {
    font-style: italic;
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
  /* Item 718: new vs continued helper, in Classic's quiet chrome: a small
     outlined tag, the accent for a new helper, dim and dashed with a turn
     glyph for one continued. */
  .hm {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-right: 6px;
    padding: 0 5px;
    height: 15px;
    vertical-align: 1px;
    font: 500 9.5px/1 var(--sans);
    color: var(--accent, var(--text));
    border: 1px solid color-mix(in srgb, var(--accent, var(--text)) 45%, transparent);
    border-radius: 7px;
  }
  .hm.cont {
    color: var(--dim);
    border-style: dashed;
    border-color: color-mix(in srgb, var(--dim) 60%, transparent);
  }
  .hm-g {
    font-size: 10px;
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
  .arow.soft .arg,
  .arow.soft .size,
  .arow.soft .ico {
    color: var(--partial);
  }
  .row-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    position: relative;
    min-width: 0;
  }
  /* Item 721: the passing text sits behind the row's text, inside the row
     (BashPassing is z-index -1), as Jarvis's 649 rows. */
  .row-wrap.bash-pass,
  .arow.sub-pass {
    position: relative;
    isolation: isolate;
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
     timings from harness/stream338-motion.css). Text: replyMotion.ts wraps the
     words still arriving in .rm-w and moves .rm-shuttle. Thinking: the needle.
     Tool rows: the weft. Under reduced motion nothing moves and nothing loops. */
  .row-wrap.rm-live > .thinking-text,
  .thinking-text:global(.rm-retract) {
    background-image: linear-gradient(var(--accent), var(--accent));
  }
  .row-wrap.rm-live > .thinking-text::after {
    content: "";
    position: absolute;
    left: -2px;
    bottom: 0.3em;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-ink, var(--accent));
    box-shadow: 0 0 8px var(--accent);
  }
  .rm-weft {
    position: absolute;
    left: 12px;
    right: 12px;
    top: 27px;
    height: 1.5px;
    transform-origin: left center;
    pointer-events: none;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    overflow: hidden;
  }
  .rm-weft::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 28%;
    border-radius: 2px;
    background: linear-gradient(90deg, transparent, var(--accent-ink, var(--accent)), transparent);
  }
  .rm-weft.rm-done {
    background: var(--accent);
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
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 10%, transparent), var(--accent-ink, var(--accent)));
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 70%, transparent);
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
  /* Item 592 (856 gives Classic Jarvis's rule): where the transcript's
     gutter is too narrow for them (`narrow-gutter`, measured by the shared
     transcript logic) they come inside the row's top right corner. */
  :global(.transcript.narrow-gutter) .block-tools,
  :global(.transcript.narrow-gutter) .block-tools.two {
    right: 6px;
    top: 6px;
  }
  /* Item 856: a running helper's context, after its line, dimmer. */
  .ctx-lbl {
    opacity: 0.75;
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
    border-radius: 6px;
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
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
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
  /* Item 700: the soft weight — amber, folded to one line by default. */
  .tool-result.soft {
    color: var(--partial);
    background: var(--partial-soft);
    border-color: color-mix(in srgb, var(--partial) 60%, transparent);
  }
  .soft-line {
    display: block;
    width: auto;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    text-align: left;
    font: inherit;
    font-family: var(--mono);
    font-size: 0.75rem;
    cursor: pointer;
  }
  .soft-line:not(.open) {
    padding-top: 0.25rem;
    padding-bottom: 0.25rem;
  }
  /* One line, cut with an ellipsis, and no width of its own: `width: 0`
     with `min-width: 100%` keeps the line from widening the trace. */
  .soft-sum {
    display: block;
    width: 0;
    min-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    border-radius: 8px;
    background: var(--sheet);
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
