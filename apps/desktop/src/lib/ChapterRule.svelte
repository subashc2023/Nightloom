<script lang="ts">
  /**
   * One chapter's divider in the transcript (item 799): a rule with the
   * chapter's name, and on hover Rename and Remove. The name is edited in
   * place; the field saves on every way out (Enter, Escape, leaving it), so
   * nothing typed is lost; Reset name in the contents brings back the code's.
   * Remove moves it to the contents' Removed list, where Restore brings it back.
   */
  import { tip } from "./tip";
  import { clock } from "./home";
  import { renameChapter, setChapterRemoved, type ShownChapter } from "./chapterEdits.svelte";

  let {
    chapters,
    chat,
    classic = false,
  }: {
    chapters: readonly ShownChapter[];
    chat: string | null;
    classic?: boolean;
  } = $props();

  let editing = $state<string | null>(null);
  let draft = $state("");

  const KIND_WORD: Record<string, string> = { plan: "Plan", wave: "Helpers", commit: "Commit", hand_off: "Hand-off", start: "Start" };

  function begin(c: ShownChapter) {
    draft = c.shown;
    editing = c.key;
  }
  function finish(c: ShownChapter) {
    if (editing !== c.key) return;
    if (chat) renameChapter(chat, c, draft);
    editing = null;
  }
  function focusSelect(el: HTMLInputElement) {
    el.focus();
    el.select();
  }
</script>

{#each chapters.filter((c) => !c.removed) as c (c.key)}
  <div class="chapter" class:classic data-chapter={c.key} role="separator" aria-label={`Chapter: ${c.shown}`}>
    <span class="ch-line"></span>
    {#if editing === c.key}
      <input
        class="ch-input"
        aria-label="Chapter name"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={draft}
        use:focusSelect
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(c);
          }
        }}
        onblur={() => finish(c)}
      />
    {:else}
      <span class="ch-label" use:tip={`${KIND_WORD[c.kind] ?? "Chapter"}${c.at ? ` · ${clock(c.at)}` : ""}${c.renamed ? `\nWas: ${c.title}` : ""}`}>
        <span class="ch-kind">{KIND_WORD[c.kind] ?? "Chapter"}</span>{c.shown}
      </span>
      <span class="ch-acts">
        <button class="ch-act" onclick={() => begin(c)} disabled={!chat}>Rename</button>
        <button class="ch-act" onclick={() => chat && setChapterRemoved(chat, c, true)} disabled={!chat}>Remove</button>
      </span>
    {/if}
    <span class="ch-line"></span>
  </div>
{/each}

<style>
  .chapter {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 22px 0 14px;
    position: relative;
  }
  .ch-line {
    flex: 1;
    min-width: 16px;
    height: 1px;
    background: var(--line2);
  }
  .ch-label {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--ink2);
    text-align: center;
    min-width: 0;
    max-width: calc(100% - 64px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ch-kind {
    font-size: 10.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--dim);
    margin-right: 8px;
  }
  .classic .ch-label {
    font-family: var(--sans);
    font-size: 12.5px;
  }
  .classic .ch-kind {
    font-size: 11.5px;
    letter-spacing: 0;
    text-transform: none;
  }
  .ch-acts {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 4px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s;
    background: var(--bg);
    padding-left: 6px;
  }
  .chapter:hover .ch-acts,
  .chapter:focus-within .ch-acts {
    opacity: 1;
    pointer-events: auto;
  }
  .ch-act {
    background: none;
    border: 1px solid var(--line2);
    border-radius: 6px;
    padding: 1px 7px;
    font: inherit;
    font-size: 11.5px;
    color: var(--ink2);
    cursor: pointer;
  }
  .ch-act:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--line);
  }
  .ch-input {
    flex: 0 1 60%;
    min-width: 120px;
    font: inherit;
    font-size: 12.5px;
    padding: 3px 8px;
    border: 1px solid var(--accent-ink);
    border-radius: 6px;
    background: var(--sheet);
    color: var(--ink);
    text-align: center;
  }
</style>
