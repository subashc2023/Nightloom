<script lang="ts">
  import { HOW_RESTORE } from "./rewindRestore";
  // Item 703: where a turn's end cut running agents.
  import SessionCutNotice from "./SessionCutNotice.svelte";
  import ChatDividers from "./ChatDividers.svelte";
  import ChapterRule from "./ChapterRule.svelte";
  import ChapterContents from "./ChapterContents.svelte";
  import ScanCard from "./ScanCard.svelte";
  import { isScanMessage } from "./home";
  import { tip } from "./tip";
  import { exactTime, relativeTimeLong } from "./time";
  import { tick } from "svelte";
  import { app, removeBlock, restoreBlock, restoreTurn, setCheckpoint, openSession, retryConnect, runningChatName, setAsideRewound, keepRewound, restoreRewound, keepRewindFiles, undoRestore } from "./state.svelte";
  import { checkpointLine, checkpointOwner } from "./checkpoint";
  import { editButtons, editReduce } from "./edit";
  import { splitAdopted } from "./subagentAsk";
  import { councilOfTurn, rosterLabel } from "./council";
  import { wordDiff } from "./textdiff";
  import { pillParts } from "./replyQuote.svelte";
  import { isMac } from "./platform";
  import { fmtShare, shareOf, userFigure } from "./tokens";
  import { replyUsageView } from "./replyUsage";
  import { placeOf, trackPlace } from "./boxPlace";
  // Item 399: the edit box draws and pastes as the composer does.
  import BoxLayer, { layerShown } from "./BoxLayer.svelte";
  import LiveBox from "./LiveBox.svelte";
  import { composerFormat } from "./composerFormat.svelte";
  import { editKind } from "./boxHistory";
  import PasteOfferRow from "./PasteOfferRow.svelte";
  import EditAttachments from "./EditAttachments.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { removeAsk, removeTip } from "./removeAsk";
  import { shownText, splitAttachNote } from "./keep";
  import { cancelScroll } from "./navigator";
  import AssistantMessage from "./AssistantMessageClassic.svelte";
  // Item 495 part 2: the chat view's folds kept past a chat switch.
  import { keptOpen } from "./keptFolds.svelte";
  import WaitingMoon from "./WaitingMoon.svelte";
  import UserBubble from "./UserBubbleClassic.svelte";
  import MathText from "./MathText.svelte";
  import PendingBubbles from "./PendingBubbles.svelte";
  import KeepWarmNotice from "./KeepWarmNotice.svelte";
  import AsideLayer from "./AsideLayer.svelte";
  import { openAttachment } from "./attachments.svelte";
  import ApprovalPrompt from "./ApprovalPrompt.svelte";
  import TurnAskHost from "./TurnAskHost.svelte";
  import AskHandBack from "./AskHandBack.svelte";
  import BudgetStopCard from "./BudgetStopCard.svelte";
  import Icon from "./Icon.svelte";
  import Navigator from "./Navigator.svelte";
  // Edits as versions (item 299): ‹ n/N › under an edited message.
  import { openVersion, versionsOf } from "./versions.svelte";
  import { retryReply } from "./retry.svelte";
  import { versionPlace } from "./versions";
  import { handoffIsPlain } from "./handoffBubble";
  import { arrive } from "./sendMotion";
  import { transcriptLogic, type TranscriptLogicProps } from "./transcript/logic.svelte";

  // Item 856: the behaviour lives once, in `transcript/logic.svelte.ts`; this file is the look.
  const props: TranscriptLogicProps = $props();
  const T = transcriptLogic(() => props);
</script>

{#snippet notes(index: number)}
  <!-- Item 674: what an aside says under an exchange — where a stopped
       answer ends, an error in the chat's own error look. -->
  {#each T.src.notes?.get(index) ?? [] as n (n.kind)}
    {#if n.kind === "error"}<div class="error-banner turn-note">{n.text}</div>{:else}<div class="turn-mark">{n.text}</div>{/if}
  {/each}
{/snippet}
<svelte:document onselectionchange={T.placePill} />
<svelte:window onkeydown={T.asideChord} />
{#if T.removing}
  <!-- Item 356: Remove asks first, and the undo toast still follows it. -->
  {@const ask = removeAsk(T.removing.kind, T.removing.text, T.onClaudeCode)}
  <ConfirmDialog
    title={ask.title}
    lead={ask.lead}
    facts={ask.facts}
    confirmLabel={ask.confirmLabel}
    onconfirm={() => {
      const asked = T.removing;
      T.removing = null;
      if (asked && asked.key === T.sessionKey) void T.removeHere(asked.index);
    }}
    onclose={() => (T.removing = null)}
  />
{/if}
{#if T.dropAsk}
  <!-- Practices §7 (item 336): a changed edit — words or chips — is not
       dropped on one key or one click elsewhere; Keep editing is the default. -->
  <ConfirmDialog
    title="Discard this edit?"
    lead={T.dropAsk.what === "open"
      ? "Another message's editor is open with changes; opening this one drops them."
      : "The changed text and attachments in the edit box are dropped; the message stays as it was."}
    confirmLabel="Discard edit"
    onconfirm={() => {
      const run = T.dropAsk?.run;
      T.dropAsk = null;
      run?.();
    }}
    onclose={() => {
      T.dropAsk = null;
      void tick().then(() => (T.editorLive ? T.editorLive.focus() : T.editorEl?.focus({ preventScroll: true })));
    }}
  />
{/if}

<!-- The viewport takes ⌥↑ / ⌥↓ (backlog 065); it is a scroll region, not
     a control, and the lint has no role for that. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="transcript"
  class:narrow-gutter={T.narrowGutter}
  class:compact={T.compact}
  class:of-aside={T.inAside}
  bind:this={T.viewport}
  data-drop-chat={T.src.dropKey}
  onscroll={T.onscroll}
  use:T.scrollIntent
  tabindex="-1"
  onkeydown={T.viewportKeys}
>
  <div class="inner" bind:this={T.inner}>
    {@render T.lead?.()}
    {#if T.continuedFrom && T.drawFrom === 0}
      <div class="continued">
        <span class="continued-ic"><Icon name="branch" size={14} /></span>
        <span>Continued from <span class="continued-t">“{T.continuedFrom.name}”</span> · <span class="mono">HANDOFF.md</span></span>
        <span class="spacer"></span>
        <button class="continued-open" onclick={() => void openSession(T.continuedFrom!.id)}>open the earlier chat</button>
      </div>
    {/if}
    <!-- Item 882: only the drawn window is walked (keyed by the item's index in the chat), as in Transcript.svelte. -->
    {#each T.items.slice(T.drawFrom) as item, k (k + T.drawFrom)}
      {@const i = k + T.drawFrom}
      {#if i >= T.drawFrom && T.dividerPlaces.before.has(i)}<ChatDividers dividers={T.dividerPlaces.before.get(i) ?? []} foldKey={(ix) => T.turnFold(ix, "hand_off")} classic />{/if}
      {#if i >= T.drawFrom && T.chapterPlaces.before.has(i)}<ChapterRule chapters={T.chapterPlaces.before.get(i) ?? []} chat={T.chapterScope} classic />{/if}
      {#if i >= T.drawFrom && T.cutPlaces.before.has(i)}<SessionCutNotice cuts={T.cutPlaces.before.get(i) ?? []} resumed />{/if}
      <!-- Item 482: only the render window is drawn. -->
      {#if i < T.drawFrom}{:else if item.superseded}
        {#if T.rewound[i] !== null}
          <div
            class="rewound"
            use:tip={"Rewound — not part of the conversation any more. Undo (or ⌘Z) brings it back while nothing newer is on the stack."}
          >
            {T.rewound[i] === 1 ? "1 message rewound" : `${T.rewound[i]} messages rewound`}
          </div>
        {/if}
      {:else if item.kind === "user" && !item.removed && T.editing?.index !== item.index && isScanMessage(item.text)}
        <!-- Item 763 (H3): the morning scan as a card, its facts folded. -->
        <div class="scan-turn" data-turn={item.index}>
          <ScanCard text={item.text} at={item.at} foldKey={T.turnFold(item.index, "scan")} classic />
          {@render notes(item.index)}
        </div>
        {#if item.index === T.warmNoticeIndex && T.chatId}<KeepWarmNotice chat={T.chatId} />{/if}
      {:else if item.kind === "user"}
        <div
          class="user-turn"
          class:superseded={item.superseded}
          class:removed={item.removed}
          use:arrive={{ channel: T.src.channel, active: item.index >= T.enterFrom, bubble: ".user-bubble", riseWithout: true }}
          data-turn={item.index}
        >
          <div class="user-key">
            <!-- The tools sit under the bubble (his 2026-09-15 evening
                 review: "these buttons should be below, and should be
                 icons"); see `.turn-tools` below. -->
            {#if item.original !== null && !item.removed}
              <button
                class="edited-mark"
                class:on={T.isDiffOpen(item.index)}
                type="button"
                aria-pressed={T.isDiffOpen(item.index)}
                use:tip={T.isDiffOpen(item.index) ? "Edited — show the current text" : "Edited — show the edit as a diff"}
                onclick={(e) => T.toggleDiff(item.index, e.currentTarget)}>edited</button
              >
            {/if}
            <!-- The time moved to the foot (backlog 123): one place is
                 enough, and his ask was the foot. Classic keeps `You` at the
                 head (Jarvis moved it to the foot, item 525). -->
            <span class="ns-k">You</span>
            <!-- The turn's own size (backlog 090) moved to the foot on
                 2026-09-27 (backlog 245): under his message, as a reply's
                 figure is under the reply. -->
          </div>
          {#if T.editing?.index === item.index}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="editor" data-drop-box="edit" ondragover={T.editorDragOver} ondrop={T.editorDrop}>
              <!-- Item 399: the composer's box, drawn as the composer draws
                   it — with the format toggle on, its formatted box; off,
                   the textarea with quote and code lines drawn in a layer
                   behind it (BoxLayer). -->
              {#if composerFormat.on || T.editGrid}
                <div class="edit-live">
                  <LiveBox
                    bind:handle={T.editorLive}
                    drawing={composerFormat.on ? "all" : "plain"}
                    value={T.editing.draft}
                    historyKey={T.editHistoryKey}
                    label="Edit this message"
                    onchange={(v) => {
                      if (T.editing && !T.editing.parts) T.editing = editReduce(T.editing, { type: "draft", text: v });
                    }}
                    oninput={() => (T.editPlaces[0] = placeOf(T.editorLive))}
                    onkeydown={(e) => T.editorKeys(e, item)}
                    onpaste={T.editorPaste}
                  />
                </div>
              {:else}
                <div class="edit-wrap">
                  {#if layerShown(T.editing.draft)}
                    <BoxLayer text={T.editing.draft} box={T.editorEl} onrelabel={T.editRelabel} />
                  {/if}
                  <!-- data-own-undo: its history is editHist's (item 421, fieldUndo.ts). -->
                  <textarea
                    bind:this={T.editorEl}
                    data-own-undo
                    class:layered={layerShown(T.editing.draft)}
                    use:T.grow
                    use:trackPlace={(pl) => (T.editPlaces[0] = pl)}
                    value={T.editing.draft}
                    oninput={(e) => {
                      const el = e.target as HTMLTextAreaElement;
                      T.editHist.input(editKind((e as unknown as InputEvent).inputType ?? ""), T.editSnap(el));
                      T.editing = editReduce(T.editing, { type: "draft", text: el.value });
                      T.autogrow();
                    }}
                    onbeforeinput={T.editBeforeInput}
                    oncompositionstart={() => (T.editComposing = true)}
                    oncompositionend={() => {
                      T.editComposing = false;
                      T.editHist.close();
                    }}
                    onkeydown={(e) => T.editorKeys(e, item)}
                    onpaste={T.editorPaste}
                    aria-label="Edit this message"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                  ></textarea>
                </div>
              {/if}
              <!-- Item 399b: the composer's long-paste offer. -->
              <PasteOfferRow
                offer={T.editOffer}
                undoable={T.editUndoable()}
                onconvert={() => void T.editConvert()}
                ondismiss={() => (T.editOffer = null)}
                onundo={() => T.editUndoConvert()}
              />
              <!-- Item 336: the turn's attachments as chips, × to remove,
                   Attach (and paste, drop) to add. -->
              <EditAttachments key={T.editKey} />
              <div class="editor-line">{T.editCacheLine}</div>
              <div class="editor-row">
                <button
                  class="ns-btn small"
                  disabled={!editButtons(T.editing, T.editChips).send || !!T.src.words?.sendBlocked}
                  use:tip={T.src.words
                    ? (T.src.words.sendBlocked ?? T.src.words.sendTip)
                    : "Start a fork from here with this text as its next message; this chat stays as it is"}
                  onclick={() => void T.commitSend(item)}
                >
                  {T.src.words?.sendLabel ?? "Send"}
                </button>
                {#if T.src.chatActions}
                <button
                  class="ns-btn ghost small"
                  disabled={!editButtons(T.editing, T.editChips).save}
                  use:tip={"Keep this chat, with this message reworded from here on"}
                  onclick={() => void T.commitSave()}
                >
                  Save
                </button>
                {/if}
                <button
                  class="ns-btn ghost small"
                  onclick={T.cancelEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          {:else}
            <!-- The bubble is `UserBubble` since backlog 283 — an aside's
                 questions are drawn by the same piece. The address of an
                 attachment is the event's index and its own; the bytes
                 stay in the log. -->
            {@const adoptedMsg = splitAdopted(item.text)}
            {@const diffShown = T.isDiffOpen(item.index) && item.original !== null && !item.removed}
            <UserBubble
              images={item.images}
              documents={item.documents}
              text={item.text}
              sending={item.sending ?? []}
              keep={T.turnFold(item.index, "bubble")}
              custom={diffShown || !!adoptedMsg.carried}
              plain={handoffIsPlain(item.original, T.chatId ? (versionPlace(versionsOf(T.chatId, item.index), T.chatId)?.n ?? null) : null)}
              onopenimage={T.inAside ? undefined : (j, rect, size) => {
                if (!app.activeSessionId) return;
                openAttachment(
                  { kind: "attachment", session: app.activeSessionId, turn: item.index, index: j, media: "image", name: "image" },
                  rect,
                  size,
                );
              }}
              onopendoc={T.inAside ? undefined : (j, rect) => {
                if (!app.activeSessionId) return;
                const doc = item.documents[j];
                if (!doc) return;
                openAttachment(
                  { kind: "attachment", session: app.activeSessionId, turn: item.index, index: j, media: "document", name: doc.name },
                  rect,
                );
              }}
            >
              {#snippet body()}
                {#if diffShown && item.original !== null}
                  <!-- The edit as a diff over the current text (backlog 105):
                       the bubble's own face, the code diff view's colours. -->
                  <div class="user-text textdiff">
                    {#each wordDiff(splitAttachNote(item.original).said, splitAttachNote(item.text).said) as op, k (k)}
                      {#if op.kind === "del"}<del>{op.text}</del>{:else if op.kind === "add"}<ins>{op.text}</ins>{:else}{op.text}{/if}
                    {/each}
                  </div>
                {:else if adoptedMsg.carried}
                  <!-- An adopted agent's run (backlog 157): what this chat
                       was given, folded; his question below it. -->
                  <details class="adopted-carry" use:keptOpen={{ key: T.turnFold(item.index, "carried") }}>
                    <summary>Carried from agent “{adoptedMsg.agent ?? "subagent"}” — its task and run, which this chat answers from</summary>
                    <pre>{adoptedMsg.carried}</pre>
                  </details>
                  {#if adoptedMsg.said}<div class="user-text"><MathText text={adoptedMsg.said} /></div>{/if}
                {/if}
              {/snippet}
              {#snippet extra()}
                {#if !item.removed}
                  {@const council = councilOfTurn(T.evs, item.index)}
                  {#if council}
                    <!-- The council chip (nightshift backlog 149): this
                         message went to the seats the reply's record names. -->
                    <span
                      class="ns-chip mono council-chip"
                      use:tip={`Sent to a council of ${council.seats.length}: ${rosterLabel(council.seats)} · ${council.mode} pass`}
                      >council · {council.seats.length}</span
                    >
                  {/if}
                {/if}
              {/snippet}
            </UserBubble>
            {#if item.original !== null && item.removed}
              <details class="original" use:keptOpen={{ key: T.turnFold(item.index, "removed") }}>
                <summary>what was removed</summary>
                <div class="original-text">{item.original}</div>
              </details>
            {/if}
          {/if}
          <!-- The foot (backlog 123): the hover tools, then when the message
               was sent, in words, the exact moment on hover. The time is
               always drawn; the tools only when the turn can be acted on. -->
          <div class="turn-foot">
            {#if T.chatId && T.editing?.index !== item.index}
              {@const vlist = versionsOf(T.chatId, item.index)}
              {@const vplace = versionPlace(vlist, T.chatId)}
              {#if vlist && vplace}
                <!-- The versions of this message (item 299): ‹ n/N ›, the
                     original first; an arrow opens that version's chat in
                     this tab. Always drawn, not only on hover. -->
                <span class="versions" role="group" aria-label="Versions of this message">
                  <button
                    class="ver-btn"
                    disabled={vplace.n <= 1 || T.inPane}
                    aria-label="Previous version"
                    use:tip={"Open the previous version of this message"}
                    onclick={() => openVersion(vlist[vplace.n - 2])}>‹</button
                  >
                  <span class="ver-count">{vplace.n}/{vplace.total}</span>
                  <button
                    class="ver-btn"
                    disabled={vplace.n >= vplace.total || T.inPane}
                    aria-label="Next version"
                    use:tip={"Open the next version of this message"}
                    onclick={() => openVersion(vlist[vplace.n])}>›</button
                  >
                </span>
              {/if}
            {/if}
            {#if splitAttachNote(item.text).said && T.editing?.index !== item.index}
              <!-- Copy his own message (nightshift backlog 181, 2026-09-22):
                   the text exactly as he typed it, never the rendered or
                   diffed face. Shown during a turn and on a superseded or
                   removed message too — copying changes nothing. -->
              <span class="turn-tools">
                <button
                  class="tool-btn"
                  class:copied={T.copiedTurn === item.index}
                  use:tip={T.copiedTurn === item.index ? "Copied" : "Copy this message"}
                  aria-label={T.copiedTurn === item.index ? "Copied" : "Copy this message"}
                  onclick={() => void T.copyUserText(item.index, splitAttachNote(item.text).said)}
                >
                  <Icon name={T.copiedTurn === item.index ? "check" : "copy"} size={14} />
                </button>
              </span>
            {/if}
            {#if !item.superseded && !T.locked && T.editing?.index !== item.index}
              <!-- Offered on both engines since 2026-09-15 (backlog 062): on
                   Claude Code each of these rewrites the CLI's history by copy
                   and the next turn resumes the copy — the title says so.
                   Icons, with the full sentence on hover and for a reader. -->
              <span class="turn-tools" use:tip={T.controlsTitle}>
                {#if item.removed}
                  <!-- Restore on the placeholder itself (backlog 066): the
                       same restore an undo of the removal runs. -->
                  <button
                    class="tool-btn"
                    use:tip={"Restore to the context"}
                    aria-label="Restore to the context"
                    onclick={() => void restoreTurn(item.index)}
                  >
                    <Icon name="refresh" size={14} />
                  </button>
                {:else}
                  <button
                    class="tool-btn"
                    use:tip={T.src.words?.rewindTip ?? T.rewindTitle}
                    aria-label="Rewind to here"
                    onclick={() => void T.rewindHere(item.index)}
                  >
                    <Icon name="revert" size={14} />
                  </button>
                  {#if T.redo && T.redo.prompt === item.index && T.src.actions.retry}
                    <!-- Item 674: an aside's last question asked again, the
                         chat's Redo by the aside's own action. -->
                    <button
                      class="tool-btn"
                      use:tip={T.src.words?.retryTip ?? "Redo"}
                      aria-label="Redo the reply to this message"
                      onclick={() => void T.src.actions.retry?.(T.redo!.reply)}
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                  {:else if T.redo && T.redo.prompt === item.index && app.activeSessionId && T.src.chatActions}
                    <!-- Redo (item 439): Claude answers this message again,
                         no retyping — the Retry under the reply (item 333),
                         here beside Rewind. The old reply stays a version
                         away; a half-typed draft follows him. -->
                    <button
                      class="tool-btn"
                      use:tip={"Redo: Claude answers this message again, without retyping it. The old reply stays — ‹ › under your message flips between the two."}
                      aria-label="Redo the reply to this message"
                      onclick={() => void retryReply(T.redo!.reply)}
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                  {/if}
                  {#if item.editable && (T.src.chatActions || T.src.actions.askEdited)}
                    <button
                      class="tool-btn"
                      use:tip={T.src.words?.editTip ?? "Edit this message: Save keeps it here with the new text; Send starts a fork from here."}
                      aria-label="Edit this message"
                      onclick={() => T.beginEdit(item)}
                    >
                      <Icon name="pencil" size={14} />
                    </button>
                  {/if}
                  <!-- A delete look, apart from Edit's pencil (item 356). -->
                  {#if T.src.chatActions}
                  <button
                    class="tool-btn danger"
                    use:tip={removeTip("message")}
                    aria-label="Remove this message from the chat history"
                    onclick={() => (T.removing = { index: item.index, kind: "message", text: shownText(item.text), key: T.sessionKey })}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                  {/if}
                  {#if T.src.chatActions && app.connection?.engine === "claude-code" && checkpointOwner(T.userIndexes, app.checkpoint) !== item.index}
                    <!-- "Fork from here" (nightshift backlog 104, pass 3):
                         helpers fork from the end of this exchange — this
                         message and its reply — instead of the first one. -->
                    <button
                      class="tool-btn"
                      use:tip={"Fork helpers from here: a long-research helper starts with the chat up to the end of this exchange, at cache-read cost, and none of the later turns."}
                      aria-label="Fork helpers from here"
                      onclick={() => void setCheckpoint(item.index)}
                    >
                      <Icon name="branch" size={14} />
                    </button>
                  {/if}
                {/if}
              </span>
            {/if}
            {#if T.isChat && app.checkpoint && checkpointOwner(T.userIndexes, app.checkpoint) === item.index}
              <!-- The checkpoint's marker (backlog 104): on the exchange
                   helpers fork from, always drawn, not only on hover. -->
              <span class="checkpoint-mark" use:tip={checkpointLine(app.checkpoint, true)}>
                <Icon name="branch" size={12} />
                {checkpointLine(app.checkpoint, false)}
              </span>
            {/if}
            {#if T.editing?.index !== item.index && !item.superseded && !item.removed}
              <!-- His message's figure (backlog 245), in the reply footer's
                   mono 11px beside the time: the log's exact figure with
                   its share of the window (backlog 090), or the text's
                   estimate, marked ~, where the log cannot say. -->
              {@const fig = userFigure(T.sizes[item.index] ?? null, item.text, T.windowLimit)}
              {#if fig}
                {@const share = fig.exact ? shareOf(fig.tokens, T.windowLimit) : null}
                <span class="turn-size" use:tip={fig.title}>
                  {fig.label}
                  {#if fmtShare(share)}
                    <span class="share-bar" aria-hidden="true"><span class="share-fill" style:width="{(share ?? 0) * 100}%"></span></span>
                    <span class="share-pct">{fmtShare(share)}</span>
                  {/if}
                </span>
              {/if}
            {/if}
            {#if item.at}<span class="when" use:tip={exactTime(item.at)}>{relativeTimeLong(item.at, T.now)}</span>{/if}
          </div>
          {@render notes(item.index)}
        </div>
        <!-- Keep-warm (backlog 582): under his latest message until a reply
             arrives (item 663 moves it under the reply), while
             the chat's cache is being kept warm; one click switches it off. -->
        {#if item.index === T.warmNoticeIndex && T.chatId}<KeepWarmNotice chat={T.chatId} />{/if}
      {:else if item.kind === "compaction"}
        <details class="compaction" class:superseded={item.superseded} use:keptOpen={{ key: T.turnFold(item.index, "compaction") }}>
          <summary>conversation compacted — earlier turns replaced by a summary</summary>
          <div class="compaction-body">{item.summary}</div>
        </details>
      {:else}
        <div
          class="assistant-turn"
          class:superseded={item.superseded}
          class:removed={item.removed}
          class:run-cont={T.continued[i]}
          data-turn={item.index}
        >
          {#if T.editing?.index === item.index}
            <!-- The reply's text blocks as textareas in order, each tool
                 call between them a fixed marker (backlog 066): the text
                 around a call is edited, the call is not. A block's text
                 deleted entirely removes that block on Save. -->
            <div class="editor">
              {#each T.editing.parts ?? [] as part, p (part.block)}
                {#if part.kind === "text"}
                  <textarea
                    bind:this={T.editorEls[p]}
                    use:T.grow
                    use:trackPlace={(pl) => (T.editPlaces[p + 1] = pl)}
                    value={part.draft}
                    oninput={(e) => {
                      const el = e.target as HTMLTextAreaElement;
                      T.editing = editReduce(T.editing, { type: "draft", text: el.value, block: part.block });
                      T.autogrow(el);
                    }}
                    onkeydown={(e) => T.editorKeys(e, item)}
                    aria-label="Edit this part of the reply"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                  ></textarea>
                {:else}
                  <div class="editor-marker" use:tip={"A tool call stays where it is; remove it from its own hover"}>{part.label}</div>
                {/if}
              {/each}
              <div class="editor-line">{T.editCacheLine}</div>
              <div class="editor-row">
                <button
                  class="ns-btn small"
                  disabled={!editButtons(T.editing).save}
                  use:tip={"Keep this chat, with this reply reworded from here on"}
                  onclick={() => void T.commitSave()}
                >
                  Save
                </button>
                <button
                  class="ns-btn ghost small"
                  onclick={T.cancelEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          {:else}
            {@const editable = !item.superseded && !T.locked && !item.removed}
            <!-- The reply's own Edit and Remove ride its footer row since
                 backlog 121 (they were a row of their own below); Restore
                 for a removed reply stays a row under the placeholder. -->
            <AssistantMessage
              segs={item.segs}
              footer={T.src.bare?.has(item.index) ? { ...item.footer, bare: true } : item.footer}
              size={T.sizes[item.index] ?? null}
              limit={T.windowLimit}
              controlsTitle={T.controlsTitle}
              onremove={editable && T.src.chatActions ? (block) => void removeBlock(item.index, block) : null}
              onrestore={editable && T.src.chatActions ? (block) => void restoreBlock(item.index, block) : null}
              originals={item.originals ?? null}
              diff={T.isDiffOpen(item.index)}
              clock={T.now}
              headed={!T.continued[i]}
              onedit={editable && item.editable && T.src.chatActions ? () => T.beginEdit(item) : null}
              onremoveturn={editable && T.src.chatActions
                ? () => (T.removing = { index: item.index, kind: "reply", text: T.textOf(item.segs), key: T.sessionKey })
                : null}
              planUsage={T.src.planUse ? (T.src.planUse.get(item.index) ?? null) : replyUsageView(T.usageLines.get(item.index))}
              onretry={editable && T.turnEnds[i] && T.src.actions.retry
                ? () => void T.src.actions.retry?.(item.index)
                : editable && T.turnEnds[i] && app.activeSessionId && T.src.chatActions
                  ? () => void retryReply(item.index)
                  : null}
              cliSession={T.cliSession}
              folds={T.turnFolds(item.index)}
              runFrom={T.src.runFrom}
              nextChat={T.nextChat?.index === item.index ? T.nextChat : null}
            />
            {#if item.original !== null && item.removed}
              <details class="original" use:keptOpen={{ key: T.turnFold(item.index, "removed") }}>
                <summary>what was removed</summary>
                <div class="original-text">{item.original}</div>
              </details>
            {:else if item.original !== null}
              <div class="edited-row">
                <button
                  class="edited-mark"
                  class:on={T.isDiffOpen(item.index)}
                  type="button"
                  aria-pressed={T.isDiffOpen(item.index)}
                  use:tip={T.isDiffOpen(item.index) ? "Edited — show the current text" : "Edited — show the edit as a diff"}
                  onclick={(e) => T.toggleDiff(item.index, e.currentTarget)}>edited</button
                >
              </div>
            {/if}
          {/if}
          {@render notes(item.index)}
          {#if !item.superseded && !T.locked && item.removed}
            <span class="turn-tools assistant-tools" use:tip={T.controlsTitle}>
              <button
                class="tool-btn"
                use:tip={"Restore to the context"}
                aria-label="Restore to the context"
                onclick={() => void restoreTurn(item.index)}
              >
                <Icon name="refresh" size={14} />
              </button>
            </span>
          {/if}
        </div>
        {#if item.index === T.warmNoticeIndex && T.chatId}<KeepWarmNotice chat={T.chatId} side="reply" />{/if}
      {/if}
    {/each}
    <!-- The aside (nightshift backlog 081): a side question answered off the
         chat's warm cache and recorded nowhere — not in this log, not in
         the CLI's files. ~~Drawn at the foot, dashed, so it never reads as
         a turn~~ — since backlog 141 (2026-09-17) it is the floating card
         at the column's end below (`AsideCard.svelte`), placed under the
         marked passage, or pinned above the composer when there is no
         passage (blocker 225); its × is the only way it leaves, short of a
         chat switch. ~~About a passage (backlog 107): the highlighted text
         sits above the question as a quote~~ — the passage is marked in
         the transcript instead and not quoted again. Since backlog 128 the
         card reads as a turn does: his question in his bubble's face, the
         moon while nothing has arrived, the answer streaming in under it
         in the reply's face; × mid-stream stops it and keeps what had
         arrived, marked. The card hides while the thread is showing in a
         tab of its own (`asideInTab`, backlog 130 part 2), and its head
         row drags — onto a strip or a pane's half — to make that tab. The
         thread never moves. -->
    <!-- ~~The replace confirm (blocker 201)~~ — struck 2026-09-23,
         backlog 176: a new passage opens a new card beside the others. -->
    <!-- `shown` is the live turn, or its ghost for the moment between the
         turn's end and the re-synced log (backlog 131), so the reply never
         leaves the DOM under a reader. -->
    {#if T.cutPlaces.tail.length > 0}<SessionCutNotice cuts={T.cutPlaces.tail} resumed={false} />{/if}
    {#if T.dividerPlaces.tail.length > 0}<ChatDividers dividers={T.dividerPlaces.tail} foldKey={(ix) => T.turnFold(ix, "hand_off")} classic />{/if}
    {#if T.chapterPlaces.tail.length > 0}<ChapterRule chapters={T.chapterPlaces.tail} chat={T.chapterScope} classic />{/if}
    {#if T.shown}
      <!-- Item 359: the live reply's anchor for its rib on the rail. One
           flex item, as the reply alone was; nothing styles it. -->
      <div data-nav-live>
      {#if T.shown.segments.length === 0}
        <!-- Between send and the first streamed event there is nothing to
             render, and a blank row read as "nothing happened" (his words,
             backlog 049). So something moves: the moon rolls a short way
             and back until the first delta or tool call replaces it; with
             the OS asked for less motion it is three still dots. It says
             nothing about progress, because it can see none. -->
        <!-- Since item 403 the one piece the chat and its asides wait with. -->
        {#if T.inAside}
          <!-- An aside's wait says what it waits behind (317, 404). -->
          <WaitingMoon label="Waiting for the answer">{T.src.waitNote ?? ""}</WaitingMoon>
        {:else}
          <WaitingMoon />
        {/if}
      {:else}
        <AssistantMessage
          segs={T.shown.segments}
          streaming
          since={T.shown.since}
          model={T.src.liveModel}
          picked={T.src.livePick}
          approvals={T.approvalsNow}
          cliSession={T.cliSession}
          folds={T.liveFolds(T.shown.since)}
          runFrom={T.src.runFrom}
        />
      {/if}
      </div>
    {/if}
    {@render T.afterLive?.()}
    <!-- Item 522: between his answer to a prompt and the turn showing
         it, a line says the answer was taken (and, past 20 s, how long). -->
    {#if T.isChat}<AskHandBack />{/if}
    <!-- Item 465: messages he sent while this turn runs, not yet taken —
         greyed bubbles with Send now / Let it arrive / Edit / Cancel. -->
    {#if T.src.queue}<PendingBubbles of={T.src.queue} />{/if}
    {#each T.stranded as req (req.id)}
      <ApprovalPrompt {req} />
    {/each}
    <!-- Item 753: the question the last turn ended on, as a card, until he answers. -->
    {#if T.isChat}<TurnAskHost />{/if}
    <!-- A call held at the 85% stop line for his answer (nightshift
         backlog 189): ~~only in the chat the turn runs in~~ — since 192 in
         the chat on screen whichever it is, naming the running chat when
         that is another (review 2026-09-23 finding 3), while it runs. -->
    {#if T.isChat && app.busy && app.budgetSession && app.turnBudget?.pending_since_ms}
      <BudgetStopCard
        session={app.budgetSession}
        elsewhere={app.parked && app.activeSessionId !== app.budgetSession ? runningChatName() : null}
      />
    {/if}
    {#if T.isChat && app.error}
      <div class="error-banner">{app.error}</div>
    {/if}
    <!-- The files the rewound turns wrote (item 259): the next run would
         read them as real. Ticked ones move to a dated folder outside the
         project, never deleted; Keep leaves them all. -->
    <!-- Item 765: the rewound turns' files from their hidden git
         snapshots — Restore puts the ticked ones back as they were before
         the turn (files the turns made move aside, never deleted); a file
         changed since the turn ended is left alone; Undo puts them back. -->
    {#if T.isChat && app.rewindRestore && app.rewindRestore.session === app.activeSessionId}
      {@const rr = app.rewindRestore}
      <div class="limit-card" role="status">
        <div class="limit-head">
          <span class="ns-chip mono">rewound turns changed {rr.files.length === 1 ? "1 file" : `${rr.files.length} files`}</span>
          <span class="limit-sub">restore them to before the turn, or keep them as they are</span>
        </div>
        {#if rr.done === null}
          <div class="aside-files">
            {#each rr.files as f (f.path)}
              <label class="aside-file">
                <input
                  type="checkbox"
                  checked={T.restoreTicked(f)}
                  disabled={f.since || rr.busy}
                  onchange={(e) => (T.restoreTicks[f.path] = (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="mono">{f.path}</span>
                <span class="limit-sub">{f.since ? "changed since the turn — left alone" : HOW_RESTORE[f.how]}{!f.named && !f.since ? " · not by a named tool (a shell command, a helper or another chat)" : ""}</span>
              </label>
            {/each}
          </div>
          <div class="limit-actions">
            <button
              class="ns-btn accent small"
              disabled={T.restoreCount === 0 || rr.busy}
              use:tip={"Put the ticked files back as they were before the turn; files it made move to ~/.nightloom/rewound. Undo stays offered"}
              onclick={() => void restoreRewound(T.restoreTicked)}
            >Restore {T.restoreCount === 1 ? "1 file" : `${T.restoreCount} files`}</button>
            <button class="ns-btn ghost small" disabled={rr.busy} onclick={keepRewindFiles}>Keep files</button>
          </div>
        {:else}
          <div class="limit-text">{rr.done}</div>
          <div class="limit-actions">
            {#if rr.undo}
              <button class="ns-btn ghost small" disabled={rr.busy} use:tip={"Put the files back as they were just before the restore; anything changed since stays"} onclick={() => void undoRestore()}>Undo restore</button>
            {/if}
            <button class="ns-btn ghost small" disabled={rr.busy} onclick={keepRewindFiles}>Done</button>
          </div>
        {/if}
      </div>
    {/if}
    {#if T.isChat && app.rewoundWrites && app.rewoundWrites.session === app.activeSessionId}
      {@const rw = app.rewoundWrites}
      <div class="limit-card" role="status">
        <div class="limit-head">
          <span class="ns-chip mono">rewound turn wrote {rw.files.length === 1 ? "1 file" : `${rw.files.length} files`}</span>
          <span class="limit-sub">still on disk — the next run reads them as real</span>
        </div>
        {#if rw.note}
          <div class="limit-sub">{rw.note}</div>
        {/if}
        {#if rw.done === null}
          <div class="aside-files">
            {#each rw.files as f (f.path)}
              <label class="aside-file">
                <input
                  type="checkbox"
                  checked={T.asideTicked(f.path, f.how)}
                  onchange={(e) => (T.asideTicks[f.path] = (e.currentTarget as HTMLInputElement).checked)}
                />
                <span class="mono">{f.path}</span>
                <span class="limit-sub">{T.HOW_LABEL[f.how] ?? f.how}</span>
              </label>
            {/each}
          </div>
          <div class="limit-actions">
            <button
              class="ns-btn accent small"
              disabled={T.asidePaths.length === 0}
              use:tip={"Move the ticked files to a dated folder outside the project (~/.nightloom/rewound); nothing is deleted"}
              onclick={() => void setAsideRewound(T.asidePaths)}
            >Set aside {T.asidePaths.length === 1 ? "1 file" : `${T.asidePaths.length} files`}</button>
            <button class="ns-btn ghost small" onclick={keepRewound}>Keep them</button>
          </div>
        {:else}
          <div class="limit-text">{rw.done}</div>
          <div class="limit-actions">
            <button class="ns-btn ghost small" onclick={keepRewound}>Done</button>
          </div>
        {/if}
      </div>
    {/if}
    <!-- Not connected, and why (item 261): a failed connect used to leave
         every chat saying "not connected" with nothing to press but a
         relaunch. One Retry connects again with the rail as it is. -->
    {#if T.isChat && !app.connection && app.connectError && !app.connecting}
      <div class="limit-card" role="status">
        <div class="limit-head">
          <span class="ns-chip mono">not connected</span>
        </div>
        <div class="limit-text">{app.connectError}</div>
        {#if app.retryAfterTurn}
          <!-- Item 941: Retry during a turn is owed, and said so. -->
          <div class="limit-text">Connects the moment this turn ends.</div>
        {:else}
          <div class="limit-actions">
            <button class="ns-btn accent small" use:tip={app.busy ? "Connect again when this turn ends" : "Connect again with the rail's settings"} onclick={() => void retryConnect()}>Retry</button>
          </div>
        {/if}
      </div>
    {/if}
    <!-- A turn paused by the usage limit (nightshift backlog 164): not
         failed — the mark says when the window opens, and one Resume
         continues the turn then (scheduled if pressed early, never into
         an exhausted window), naming the subagents that died so they are
         resumed rather than relaunched. -->
    {#if T.src.limit}
      {@const L = T.src.limit}
      {@const pause = L.pause}
      <div class="limit-card" role="status">
        <div class="limit-head">
          <span class="ns-chip mono">{L.label}</span>
          {#if pause.agents.length > 0}
            <span class="limit-sub" use:tip={pause.agents.map((a) => a.description || a.agent_id || a.tool_use_id).join(" · ")}>{pause.agents.length === 1 ? "one subagent" : `${pause.agents.length} subagents`} stopped before returning · resumed, not relaunched</span>
          {/if}
        </div>
        <div class="limit-text">{pause.text}</div>
        <div class="limit-actions">
          {#if L.scheduled !== null}
            <span class="limit-sub">{L.scheduled}</span>
            <button class="ns-btn ghost small" onclick={L.cancel}>Cancel</button>
          {:else}
            <button class="ns-btn accent small" disabled={!L.can} use:tip={L.tip} onclick={L.go}>
              {L.button}
            </button>
          {/if}
        </div>
      </div>
    {/if}
    <!-- The floating aside cards (backlog 141; several since 176): the
         column's last children, absolute under their passages, stuck
         above the composer when there is none. -->
    {@render T.foot?.()}
    {#if T.isChat}
      <AsideLayer viewport={T.viewport} inner={T.inner} proseBlocks={T.proseBlocks} version={T.items.length} drawn={T.turnDrawn} reveal={T.revealTurn} />
    {/if}
  </div>
</div>
<ChapterContents chapters={T.chapterList} chat={T.chapterScope} viewport={T.viewport} classic onjump={T.jumpToChapter} />
{#if T.showNav}
  <Navigator
    ticks={T.navTicks}
    active={T.navActive}
    viewport={T.viewport}
    onjump={T.jumpTo}
    ontop={T.toTop}
    onend={(instant) => {
      // The rail's terminus: the foot, re-pinned, as the ⌄ above the
      // composer does; a drag past the rail's end lands there at once.
      if (instant && T.viewport) {
        cancelScroll();
        T.pinned = true;
        T.viewport.scrollTop = T.viewport.scrollHeight;
        return;
      }
      T.toBottom();
    }}
  />
{/if}
<!-- The jump to the latest message (item 218): round, centred just above
     the composer where the Claude app keeps it, faded in only when the
     view is scrolled up. It replaces the strip's small bottom chevron.
     While a reply is still coming (item 304) it shows three dots throbbing
     out of step, like a voice, which gather into the ⌄ on hover or focus
     and settle into it when the reply ends; still dots with less motion. -->
<button
  class="jump-down"
  class:shown={T.jumpDown}
  class:speaking={T.speaking}
  use:tip={T.speaking ? "The reply is still coming — jump to it and follow along" : "Jump to the latest message — and follow the reply again"}
  aria-label={T.speaking ? "Jump to the latest message; the reply is still coming" : "Jump to the latest message"}
  aria-hidden={!T.jumpDown}
  tabindex={T.jumpDown ? 0 : -1}
  onclick={T.toBottom}
>
  <span class="jd-dots" aria-hidden="true"><i><b></b></i><i><b></b></i><i><b></b></i></span>
  <!-- A chevron drawn for this button: the shared `chev` spans 6 of its 20
       units and read as a speck at this size. -->
  <svg class="ns-ico jd-arrow" viewBox="0 0 20 20" aria-hidden="true" style:width="18px" style:height="18px"
    ><path d="m5 7.5 5 5 5-5" /></svg
  >
</button>
<!-- The Ask aside pill over a selection (backlog 107), with Reply beside
     it since backlog 215. Mousedown is swallowed on both so the click
     keeps the selection it is about. -->
{#if T.asidePill && T.asidePill.source !== "diff"}
  <!-- One outline since item 223 (his ask: "part of the same view"),
       a thin divider between the two; Reply alone when asking aside is
       not offered (`pillParts`). -->
  <div class="aside-pill" style:top="{T.asidePill.top}px" style:left="{T.asidePill.left}px">
    {#each pillParts(T.canAsk) as part (part)}
      {#if part === "ask"}
        <button
          class="pill-btn"
          use:tip={"Ask aside about the highlighted passage: a side question on this text, answered from the chat's context, recorded nowhere"}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => void T.askAboutSelection()}
        >
          Ask aside <kbd class="aside-key">{isMac ? "⌘⇧A" : "Ctrl+Shift+A"}</kbd>
        </button>
      {:else if part === "divider"}
        <span class="pill-div" aria-hidden="true"></span>
      {:else}
        <button
          class="pill-btn"
          use:tip={"Reply: quote the highlighted passage in your message, at the cursor, and keep typing after it"}
          onmousedown={(e) => e.preventDefault()}
          onclick={T.replyToSelection}
        >
          Reply
        </button>
      {/if}
    {/each}
    {#if T.canComment}
      <span class="pill-div" aria-hidden="true"></span>
      <button
        class="pill-btn"
        use:tip={"Comment: keep this passage as a comment chip over the message box and write what you think of it; Send sends every comment, each passage quoted, as one message"}
        onmousedown={(e) => e.preventDefault()}
        onclick={T.commentOnSelection}
      >
        Comment
      </button>
    {/if}
  </div>
{:else if T.asidePill}
  <!-- Item 754: over a diff, Comment alone (Ask aside and Reply are for prose). -->
  <div class="aside-pill" style:top="{T.asidePill.top}px" style:left="{T.asidePill.left}px">
    <button
      class="pill-btn"
      use:tip={"Comment: keep these diff lines as a comment chip over the message box and write what you think of them; Send sends every comment as one message"}
      onmousedown={(e) => e.preventDefault()}
      onclick={T.commentOnSelection}
    >
      Comment
    </button>
  </div>
{/if}

<style>
  /* Positioned by the parent's `.content` (the transcript's area, the
     composer right under it): centred on it, a little above its foot. */
  .jump-down {
    position: absolute;
    left: 50%;
    bottom: 14px;
    z-index: 5;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--line2);
    background: var(--sheet);
    color: var(--ink2);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, 6px);
    transition:
      opacity 0.16s ease,
      transform 0.16s ease;
  }
  .jump-down.shown {
    opacity: 1;
    pointer-events: auto;
    transform: translate(-50%, 0);
  }
  .jump-down:hover {
    color: var(--ink);
    background: var(--well);
  }
  /* Item 304: the speaking dots and the ⌄ share the button; one gives way
     to the other. On hover or focus the outer dots slide in and shrink
     while the ⌄ grows from their middle, so the dots read as becoming it. */
  .jd-arrow {
    transition:
      opacity 0.2s ease,
      transform 0.2s ease;
  }
  .jd-dots {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    color: var(--accent);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  .jd-dots i {
    display: block;
    transition: transform 0.2s ease;
  }
  .jd-dots b {
    display: block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
  }
  /* At rest (and with less motion) the middle one is smaller, as in the
     Claude app's. */
  .jd-dots i:nth-child(2) b {
    transform: scale(0.7);
  }
  .jump-down.speaking .jd-dots {
    opacity: 1;
  }
  .jump-down.speaking .jd-arrow {
    opacity: 0;
    transform: translateY(-4px) scale(0.4);
  }
  .jump-down.speaking:hover .jd-dots,
  .jump-down.speaking:focus-visible .jd-dots {
    opacity: 0;
  }
  .jump-down.speaking:hover .jd-dots i:first-child,
  .jump-down.speaking:focus-visible .jd-dots i:first-child {
    transform: translateX(8px) scale(0.4);
  }
  .jump-down.speaking:hover .jd-dots i:last-child,
  .jump-down.speaking:focus-visible .jd-dots i:last-child {
    transform: translateX(-8px) scale(0.4);
  }
  .jump-down.speaking:hover .jd-dots i:nth-child(2),
  .jump-down.speaking:focus-visible .jd-dots i:nth-child(2) {
    transform: translateY(4px) scale(0.4);
  }
  .jump-down.speaking:hover .jd-arrow,
  .jump-down.speaking:focus-visible .jd-arrow {
    opacity: 1;
    transform: none;
  }
  /* The throb: each dot swells and shrinks on its own beat (three lengths,
     three offsets), so the three never line up into a wave the way typing
     dots do — it reads as a voice's level, not as text. Only while shown. */
  .jump-down.shown.speaking .jd-dots b {
    animation: jd-throb 0.84s ease-in-out infinite;
  }
  .jump-down.shown.speaking .jd-dots i:nth-child(2) b {
    animation-duration: 0.62s;
    animation-delay: -0.31s;
  }
  .jump-down.shown.speaking .jd-dots i:nth-child(3) b {
    animation-duration: 1.06s;
    animation-delay: -0.7s;
  }
  @keyframes jd-throb {
    0%,
    100% {
      transform: scale(0.55);
      opacity: 0.7;
    }
    50% {
      transform: scale(1.25);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .jump-down.shown.speaking .jd-dots b {
      animation: none;
    }
    .jd-arrow,
    .jd-dots,
    .jd-dots i {
      transition: none;
    }
  }
  .transcript {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* Item 592 via 856: a chat never scrolls sideways (Jarvis's rule);
       `narrow-gutter` brings a call's hover controls inside the row. */
    overflow-x: hidden;
    padding: 28px 20px 20px;
    /* A message the keys or the strip jump to is not the one that stole
       the outline; the viewport is focused only so ⌥↑ / ⌥↓ reach it. */
    outline: none;
  }
  /* Item 674 via 856: an aside drawn by this transcript (its card or side
     panel) — the card's own padding, plainly. */
  .transcript.compact {
    padding: 10px 12px;
  }
  .transcript.compact .inner {
    gap: 14px;
  }
  /* An aside's note under an exchange ("stopped here", its error). */
  .turn-mark {
    align-self: flex-start;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
  }
  .turn-note {
    align-self: stretch;
  }
  .inner {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 26px;
    /* Item 478: the turns' column, for a bubble drawn inside a reply (his
       mid-turn message) to reach the column's right edge, where his own
       messages sit. */
    container: turns / inline-size;
    /* The floating aside card (backlog 141) is placed in this frame. */
    position: relative;
  }
  /* The board's continued-from row: dashed, the branch mark, the earlier
     chat's name in the ink, a link to open it. */
  .continued {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border: 1px dashed var(--line2);
    border-radius: 10px;
    font-size: 13px;
    color: var(--ink2);
    background: color-mix(in srgb, var(--sheet) 50%, transparent);
  }
  .continued-ic {
    color: var(--dim);
    display: inline-flex;
  }
  .continued-t {
    color: var(--ink);
  }
  .continued .mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .continued .spacer {
    flex: 1;
  }
  .continued-open {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 12.5px;
    color: var(--accent-ink);
    cursor: pointer;
  }
  .continued-open:hover {
    text-decoration: underline;
  }
  .user-turn {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
  }
  .user-key {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  /* Dropped by a rewind: still shown, because the log still holds it and a
     hidden turn would make a rewind look like a delete. */
  .superseded {
    opacity: 0.38;
    filter: saturate(0.4);
  }
  /* Where rewound turns were (backlog 247, blocker 582): out of the way —
     small, faint, a hairline either side; the turns themselves are not
     drawn, so .superseded above no longer shows in the thread. */
  .rewound {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 0;
    font-size: 11px;
    color: var(--dim);
    opacity: 0.55;
    user-select: none;
  }
  .rewound::before,
  .rewound::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--line2);
    opacity: 0.6;
  }
  /* The hover controls on a turn — Rewind, Edit, Remove — shown on both
     engines since 2026-09-15 (backlog 062). Under the bubble as a row of
     icons, the sentence on hover (his review that evening: "below, and
     icons"). Hidden until the turn is hovered or a control is focused; the
     row keeps its height so the transcript does not shift on hover. */
  .turn-tools {
    display: inline-flex;
    gap: 2px;
    height: 22px;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .user-turn:hover .turn-tools,
  .assistant-turn:hover .turn-tools,
  .turn-tools:focus-within {
    opacity: 1;
  }
  .assistant-tools {
    align-self: flex-start;
  }
  /* The user message's foot (backlog 123): the hover tools and the time on
     one 22px row under the bubble's corner, so the transcript does not
     shift on hover. The time in the footer's dim 11px, the interface face. */
  .turn-foot {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 22px;
  }
  /* The versions of an edited message (item 299): ‹ n/N ›, the foot's
     dim 11px, the arrows the size of a tool button's glyph. */
  .versions {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .ver-btn {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 20px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--dim);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .ver-btn:hover:not(:disabled),
  .ver-btn:focus-visible {
    color: var(--ink);
    border-color: var(--line2);
  }
  .ver-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .ver-count {
    min-width: 22px;
    text-align: center;
  }
  .when {
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    cursor: default;
  }
  /* The checkpoint's marker (backlog 104): the foot's dim 11px, with the
     branch glyph, on the exchange helpers fork from. */
  .checkpoint-mark {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--sans);
    font-size: 11px;
    color: var(--dim);
    cursor: default;
  }
  .tool-btn {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    background: none;
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
  .assistant-turn {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  /* A continuation of the reply before it (backlog 121; `.continued` is
     the "Continued from" row above): pulled up through the list's 26px gap
     to the activity block's own 6px, so a run reads as one reply. */
  .assistant-turn.run-cont {
    margin-top: -20px;
  }
  .edited-mark {
    font-family: var(--sans);
    font-size: 11px;
    line-height: 1.5;
    color: var(--dim);
    background: transparent;
    border: 1px solid var(--line2);
    border-radius: 999px;
    padding: 0 7px;
    cursor: pointer;
  }
  .edited-mark:hover {
    color: var(--ink);
    border-color: var(--dim);
  }
  .edited-mark.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .edited-mark:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .edited-row {
    display: flex;
    max-width: 640px;
    padding: 2px 0 0;
  }
  /* The edit as a diff (backlog 105): the code diff view's colours on the
     message's own text, removed spans struck through. */
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
  /* The turn's size (backlog 090), in the gauge's mono figure style, and
     the gauge's own 56px bar scaled to the turn's share of the window. */
  .turn-size {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--dim);
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
  .share-pct {
    color: var(--dim);
  }
  /* Removed from the context: the placeholder, greyed like a superseded
     turn, with the original a click away. */
  .removed :global(.user-bubble),
  .removed :global(.assistant) {
    opacity: 0.45;
    font-style: italic;
  }
  .original {
    font-size: 0.78rem;
    color: var(--dim);
    max-width: 560px;
  }
  .original summary {
    cursor: pointer;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .original-text {
    margin-top: 0.3rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.6;
  }
  /* The in-place editor: the message's own width and face, the cache line
     from backlog 063 above the buttons. */
  .editor {
    width: 100%;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .assistant-turn .editor {
    max-width: 640px;
  }
  /* Item 399: the box's face is its wrap's, so the layer behind the
     textarea (BoxLayer) shows through it; the textarea's glyphs go
     transparent over the layer while it is drawn, its caret kept. */
  .edit-wrap {
    position: relative;
    background: var(--sheet);
    border-radius: 10px;
  }
  .edit-wrap textarea {
    position: relative;
    z-index: 1;
    display: block;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .edit-wrap textarea.layered {
    color: transparent;
    caret-color: var(--ink);
  }
  .edit-live {
    background: var(--sheet);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 8px 14px 6px 4px;
  }
  .edit-live :global(.cm-editor) {
    max-height: 420px;
    min-height: 3.2em;
    font-family: var(--transcript-font, var(--sans));
  }
  .editor textarea {
    width: 100%;
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 10px 14px;
    font-family: var(--transcript-font, var(--sans));
    font-size: calc(var(--transcript-size, 16px) - 1px);
    line-height: 1.5;
    resize: none;
    overflow-y: auto;
    min-height: 3.2em;
  }
  .editor textarea:focus {
    outline: none;
  }
  .editor-line {
    font-family: var(--sans);
    font-size: 11.5px;
    color: var(--dim);
  }
  /* A tool call inside the reply editor (backlog 066): greyed, in the
     tool line's face, not a field. */
  .editor-marker {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--dim);
    opacity: 0.7;
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.3rem 0.6rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .editor-row {
    display: flex;
    gap: 6px;
  }
  .council-chip {
    display: inline-block;
    margin-top: 6px;
    font-size: 10.5px;
    color: var(--dim);
  }
  /* The bubble's own rules moved to `UserBubble.svelte` (backlog 283);
     the words drawn here (an edit's diff, an adopted run's) keep these. */
  .user-text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .adopted-carry {
    margin-bottom: 0.4rem;
    font-size: 12.5px;
  }
  .adopted-carry summary {
    cursor: pointer;
    opacity: 0.8;
  }
  .adopted-carry pre {
    margin: 0.4rem 0 0;
    max-height: 24rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .compaction {
    font-size: 0.78rem;
    color: var(--dim);
  }
  .compaction summary {
    cursor: pointer;
    text-align: center;
    list-style: none;
  }
  .compaction summary::before,
  .compaction summary::after {
    content: "—— ";
  }
  .compaction summary::after {
    content: " ——";
  }
  .compaction[open] summary {
    margin-bottom: 0.5rem;
  }
  .compaction-body {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* ~~The aside card (backlog 081): dashed, dim, outside the turns~~ — its
     rules moved to `AsideCard.svelte` with the card (backlog 141,
     2026-09-17). What stays here is the passage's mark: the CSS Custom
     Highlight API's pseudo-element, and the `<mark>` fallback for a
     webview without it — the accent at low alpha, not a literal yellow
     on a dark sheet. */
  :global(::highlight(aside-passage)) {
    background-color: color-mix(in srgb, var(--accent) 30%, transparent);
    color: inherit;
  }
  :global(mark.aside-passage) {
    background-color: color-mix(in srgb, var(--accent) 30%, transparent);
    color: inherit;
    border-radius: 2px;
  }
  /* The pill is two buttons since backlog 215: Ask aside and Reply —
     one outline since item 223, a thin divider between them, no gap. */
  .aside-pill {
    position: fixed;
    transform: translateX(-50%);
    z-index: 10;
    display: flex;
    align-items: stretch;
    gap: 0;
    white-space: nowrap;
    border: 1px solid var(--line2);
    border-radius: 999px;
    background: var(--sheet);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .pill-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--ink);
    font-size: 11.5px;
    font-family: var(--sans);
    line-height: 1.3;
    cursor: pointer;
  }
  .pill-btn:hover {
    background: color-mix(in srgb, var(--ink) 8%, transparent);
  }
  .pill-div {
    width: 1px;
    align-self: stretch;
    margin: 5px 0;
    background: var(--line2);
  }
  .aside-key {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--dim);
  }
  /* The waiting moon's styles moved to `WaitingMoon.svelte` with it
     (item 403), so an aside waits with the same one. */
  /* The limit card (backlog 164): a pause, drawn like a notice and not
     like the error banner above it. */
  .limit-card {
    border: 1px dashed var(--line);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.82rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .limit-head,
  .limit-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .limit-sub {
    color: var(--muted);
  }
  .limit-text {
    color: var(--muted);
    white-space: pre-wrap;
  }
  .aside-files {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .aside-file {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    word-break: break-all;
  }
  .error-banner {
    color: var(--failed);
    background: var(--failed-soft);
    border: 1px solid var(--failed);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.82rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
