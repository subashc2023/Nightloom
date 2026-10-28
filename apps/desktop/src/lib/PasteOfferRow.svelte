<script lang="ts">
  /*
   * The long ⌘V paste's offer (item 284), a slim line under a message box:
   * "Make this an attachment" with its × (item 318) while the paste stands,
   * then "moved into an attachment · Undo" while the conversion can be
   * undone. Shared by the composer and the edit box of one of his messages
   * (item 399b); the owner holds the offer and does the moving.
   */
  import { tip } from "./tip";
  import { pastedLabel, type LongPaste } from "./pasteAttach";

  let {
    offer,
    undoable,
    onconvert,
    ondismiss,
    onundo,
  }: {
    offer: LongPaste | null;
    undoable: boolean;
    onconvert: () => void;
    ondismiss: () => void;
    onundo: () => void;
  } = $props();
</script>

{#if offer && offer.after !== null}
  <!-- Item 284: a long ⌘V paste, offered as an attachment. -->
  <div class="paste-offer" role="status">
    <span class="mono dim">long paste · {pastedLabel(offer.pasted)}</span>
    <button
      class="ns-btn ghost small"
      use:tip={"Move the pasted text out of the box into an attachment — Undo puts it back. ⌥⌘V pastes as an attachment from the start."}
      onmousedown={(e) => e.preventDefault()}
      onclick={onconvert}>Make this an attachment</button
    >
    <!-- Item 318: keep the paste as text; the offer goes for this paste. -->
    <button
      class="offer-x"
      aria-label="Dismiss — keep the paste as text"
      use:tip={"Keep it as text (Esc)"}
      onmousedown={(e) => e.preventDefault()}
      onclick={ondismiss}>×</button
    >
  </div>
{:else if undoable}
  <div class="paste-offer" role="status">
    <span class="mono dim">moved into an attachment</span>
    <button
      class="ns-btn ghost small"
      use:tip={"Put the text back in the box (⌘Z)"}
      onmousedown={(e) => e.preventDefault()}
      onclick={onundo}>Undo</button
    >
  </div>
{/if}

<style>
  /* Item 284: the long paste's offer, a slim line under the box. */
  .paste-offer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 2px 10px 4px;
    font-size: 12px;
  }
  /* Item 318: the offer's dismiss, a small × beside it. */
  .offer-x {
    width: 1.15rem;
    height: 1.15rem;
    padding: 0;
    background: none;
    color: var(--dim);
    border: 1px solid transparent;
    border-radius: 50%;
    font-size: 0.85rem;
    line-height: 1;
    cursor: pointer;
  }
  .offer-x:hover {
    color: var(--text);
    border-color: var(--border);
  }
</style>
