<script lang="ts">
  /**
   * The menu a long-press opens on a message (item 246, wave 1C): the
   * desktop's per-message controls — Copy, Edit, Edit and send, Remove or
   * Restore, Rewind here, Fork here — and, on one block of a reply, that
   * block's Copy, Edit and Remove. Rendered inside the page's sheet; the
   * page runs the actions (`onact`) against the Mac.
   *
   * The editor keeps his text (practices §7): every keystroke is saved
   * under the message's own key, so closing the sheet, a reload or a
   * refused Save leaves it there to be offered back; only Save, Send or a
   * confirmed Discard drops it.
   */
  import { editAction, loadDraft, rowRemoval, saveDraft, type ChatAction, type Row, type TextPart, type ToolRow } from "./client";

  interface Props {
    chat: string;
    row: Row;
    /** One block of a reply, when the press was on it. */
    part?: TextPart | null;
    tool?: ToolRow | null;
    /** Where Rewind and Fork point (`rowTarget`); null hides the item. */
    rewind: number | null;
    fork: number | null;
    /** The host serves `act` and nothing refuses it now. */
    canAct: boolean;
    /** Why the log cannot be changed now, when it cannot (a turn runs). */
    blocked: string | null;
    onact: (actions: ChatAction[], label: string, starts?: boolean) => Promise<boolean>;
    oncopy: (text: string) => void;
    /** The Mac's last refusal, shown here since the page's bar is under
     *  the sheet. */
    problem?: string | null;
    /** From a block's menu to the whole reply's (Rewind, Fork live there). */
    onwhole?: () => void;
    onclose: () => void;
  }
  let { chat, row, part = null, tool = null, rewind, fork, canAct, blocked, problem = null, onact, oncopy, onwhole, onclose }: Props = $props();

  /** What an Edit changes: his message, or one text block of a reply. */
  const editTarget = $derived.by((): { index: number; block: number | null; text: string } | null => {
    if (tool) return null;
    if (part) return { index: part.index, block: part.block, text: part.text };
    if (row.kind === "user") return { index: row.index, block: null, text: row.text };
    if (row.kind === "assistant") {
      const live = row.parts.filter((p) => !p.removed);
      return live.length === 1 ? { index: live[0].index, block: live[0].block, text: live[0].text } : null;
    }
    return null;
  });
  const key = $derived(editTarget ? `edit:${chat}:${editTarget.index}:${editTarget.block ?? "u"}` : "");
  const kept = $derived(key ? loadDraft(key) : "");

  let mode = $state<"menu" | "edit" | "discard">("menu");
  let sendAfter = $state(false);
  let text = $state("");
  let working = $state(false);

  const removed = $derived(tool ? !!tool.removed : part ? part.removed : row.kind !== "note" && row.removed);
  const heading = $derived(
    tool ? `${tool.name} call` : part ? "This part of the reply" : row.kind === "user" ? "Your message" : "The reply",
  );
  const copyText = $derived(tool ? tool.summary : part ? part.text : row.kind === "note" ? row.text : row.text);
  const dead = $derived(!canAct || blocked !== null);

  function beginEdit(send: boolean) {
    if (!editTarget) return;
    sendAfter = send;
    text = kept || editTarget.text;
    mode = "edit";
  }

  function typed() {
    if (key) saveDraft(key, text === editTarget?.text ? "" : text);
  }

  async function run(actions: ChatAction[], label: string, starts = false) {
    if (working || actions.length === 0) return;
    working = true;
    const ok = await onact(actions, label, starts);
    working = false;
    if (ok) onclose();
  }

  async function save() {
    if (!editTarget) return;
    const t = text.trim();
    if (!t) return;
    working = true;
    const ok = await onact([editAction(editTarget.index, t, sendAfter ? "send" : "save", editTarget.block)], sendAfter ? "Sent as a fork" : "Saved", sendAfter);
    working = false;
    // A refusal keeps the editor open with his text, and the draft on disk.
    if (ok) {
      saveDraft(key, "");
      onclose();
    }
  }

  function discard() {
    if (editTarget && text.trim() !== editTarget.text.trim() && mode === "edit") {
      mode = "discard";
      return;
    }
    dropDraft();
  }

  function dropDraft() {
    saveDraft(key, "");
    text = "";
    mode = "menu";
  }

  function removeActions(restore: boolean): ChatAction[] {
    if (tool && tool.index != null && tool.block != null)
      return [{ op: restore ? "restore_block" : "remove_block", index: tool.index, block: tool.block }];
    if (part) return [{ op: restore ? "restore_block" : "remove_block", index: part.index, block: part.block }];
    return rowRemoval(row, restore);
  }
</script>

{#snippet ico(name: "copy" | "pencil" | "send" | "minus" | "restore" | "rewind" | "fork")}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
    {#if name === "copy"}<rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    {:else if name === "pencil"}<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    {:else if name === "send"}<path d="M12 19V5M5 12l7-7 7 7" />
    {:else if name === "minus"}<circle cx="12" cy="12" r="9" /><path d="M8 12h8" />
    {:else if name === "restore"}<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />
    {:else if name === "rewind"}<path d="M11 18 5 12l6-6M19 18l-6-6 6-6" />
    {:else if name === "fork"}<circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 7v10M18 10c0 4-6 3-11 7" />
    {/if}
  </svg>
{/snippet}

{#if mode === "menu"}
  <div class="mm-title">{heading}</div>
  <div class="mm-quote" class:removed>{copyText || "—"}</div>
  {#if problem}<p class="mm-problem">{problem}</p>{/if}
  {#if blocked}<p class="mm-note">{blocked}</p>{:else if !canAct}<p class="mm-note">This Mac's Nightloom is older than the phone page: only Copy works until it updates.</p>{/if}
  <div class="mm-menu">
    <button onclick={() => (oncopy(copyText), onclose())}>{@render ico("copy")} Copy</button>
    {#if editTarget && !removed}
      <button disabled={dead} onclick={() => beginEdit(false)}>{@render ico("pencil")} Edit{kept ? " · draft kept" : ""}</button>
      {#if row.kind === "user" && !part}
        <button disabled={dead} onclick={() => beginEdit(true)}>{@render ico("send")} Edit and send</button>
      {/if}
    {/if}
    {#if removed}
      <button disabled={dead || working} onclick={() => run(removeActions(true), "Restored to the context")}>{@render ico("restore")} Restore to the context</button>
    {:else}
      <button disabled={dead || working} onclick={() => run(removeActions(false), "Removed from the context — still in the log")}>{@render ico("minus")} Remove from the context</button>
    {/if}
    {#if (part || tool) && onwhole}
      <button onclick={onwhole}>{@render ico("rewind")} The whole reply…</button>
    {/if}
    {#if !part && !tool}
      {#if rewind !== null}
        <button disabled={dead || working} onclick={() => run([{ op: "rewind", to: rewind! }], "Rewound")}>{@render ico("rewind")} Rewind here</button>
      {/if}
      {#if fork !== null}
        <button disabled={dead || working} onclick={() => run([{ op: "fork", upto: fork! }], "Forked — this is the new chat")}>{@render ico("fork")} Fork here</button>
      {/if}
    {/if}
  </div>
  {#if !part && !tool && rewind !== null}
    <p class="mm-note">{row.kind === "user" ? "Rewind drops this message and everything after it; Fork starts a new chat that ends just before it." : "Rewind drops everything after this reply; Fork starts a new chat that ends with it."}</p>
  {/if}
{:else if mode === "edit"}
  <div class="mm-title">{sendAfter ? "Edit and send" : "Edit"}</div>
  <p class="mm-note">
    {sendAfter ? "Sends from a fork: a new chat with this text in place of the message, and this chat stays as it is." : "Save keeps the chat here with the new text; the model reads it from the next turn."}
  </p>
  <!-- svelte-ignore a11y_autofocus -->
  <textarea class="mm-box" rows="6" bind:value={text} oninput={typed} autofocus></textarea>
  <div class="mm-actions">
    <button class="mm-btn" onclick={discard} disabled={working}>Discard</button>
    <span class="mm-grow"></span>
    <button class="mm-btn accent" disabled={working || !text.trim() || dead} onclick={save}>{sendAfter ? "Send" : "Save"}</button>
  </div>
  {#if problem}<p class="mm-problem">{problem} Your text is kept.</p>{:else if blocked}<p class="mm-note">{blocked} Your text is kept.</p>{/if}
{:else}
  <div class="mm-title">Discard the edit?</div>
  <p class="mm-note">The text you typed goes; the message stays as it was.</p>
  <div class="mm-actions">
    <button class="mm-btn" onclick={() => (mode = "edit")}>Keep editing</button>
    <span class="mm-grow"></span>
    <button class="mm-btn danger" onclick={dropDraft}>Discard</button>
  </div>
{/if}

<style>
  .mm-title {
    font-weight: 600;
    font-size: 17px;
  }
  .mm-quote {
    font-size: 14px;
    color: var(--ink2);
    background: var(--paper);
    border-radius: 12px;
    padding: 8px 12px;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .mm-quote.removed {
    opacity: 0.55;
    text-decoration: line-through;
  }
  .mm-note {
    font-size: 13px;
    color: var(--dim);
    margin: 0;
  }
  .mm-problem {
    font-size: 14px;
    color: var(--failed);
    margin: 0;
  }
  .mm-menu {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    border-radius: 16px;
    overflow: hidden;
  }
  .mm-menu button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 50px;
    padding: 0 16px;
    cursor: pointer;
    font-size: 16px;
  }
  .mm-menu button + button {
    border-top: 1px solid var(--line);
  }
  .mm-menu button:active:not(:disabled) {
    background: var(--well);
  }
  .mm-menu button:disabled {
    opacity: 0.4;
  }
  .ico {
    width: 22px;
    height: 22px;
    stroke: var(--ink2);
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }
  .mm-box {
    width: 100%;
    background: var(--well);
    color: inherit;
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    font-size: 16px;
    outline: none;
    resize: none;
    max-height: 40dvh;
  }
  .mm-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .mm-grow {
    flex: 1;
  }
  .mm-btn {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 16px;
    display: inline-flex;
    align-items: center;
    border-radius: 12px;
    border: 1px solid var(--line2);
    font-size: 15px;
    box-sizing: border-box;
  }
  .mm-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .mm-btn.accent {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .mm-btn.danger {
    color: var(--failed);
    border-color: color-mix(in srgb, var(--failed) 45%, transparent);
  }
</style>
