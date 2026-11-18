<script lang="ts">
  // Item 795: the Quick Entry box. Three targets — the chat he last used, a
  // new chat in a project, an aside on the last chat — the last one used
  // remembered; typed text, macOS dictation (any text box takes it) and a
  // paste of the clipboard (never another app's selection: no Accessibility
  // dialog). Enter sends and closes; Escape or a click elsewhere closes and
  // keeps the draft, which is saved on every keystroke.
  import { onMount, tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { emitTo, listen } from "@tauri-apps/api/event";
  import {
    KEYS,
    TARGETS,
    loadDraft,
    openingProject,
    openingTarget,
    readContext,
    remember,
    saveDraft,
    sendOf,
    targetName,
    type QuickContext,
    type QuickTarget,
  } from "../lib/quickEntry";

  let ctx = $state<QuickContext>(readContext(localStorage));
  let target = $state<QuickTarget>("last");
  let project = $state<string | null>(null);
  let text = $state("");
  let error = $state<string | null>(null);
  let box: HTMLTextAreaElement | undefined = $state();

  /** Every open: the targets as the main window last wrote them, the draft. */
  async function refresh(): Promise<void> {
    ctx = readContext(localStorage);
    target = openingTarget(localStorage, ctx);
    project = openingProject(localStorage, ctx);
    text = loadDraft(localStorage);
    error = null;
    await tick();
    box?.focus();
    box?.setSelectionRange(text.length, text.length);
  }

  function hide(): void {
    saveDraft(localStorage, text);
    void invoke("quick_entry_hide").catch(() => {});
  }

  async function send(): Promise<void> {
    const out = sendOf(target, text, ctx, project);
    if (typeof out === "string") {
      error = out;
      return;
    }
    try {
      await emitTo("main", "quick-entry-send", out);
    } catch (e) {
      // Not handed over: the words stay.
      error = `not sent: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    remember(localStorage, target, project);
    text = "";
    saveDraft(localStorage, "");
    void invoke("quick_entry_hide").catch(() => {});
  }

  /** ⌘V pastes the clipboard's text at the caret, read by the backend
   *  (`clipboard_text`), so it works while Nightloom is not the active app. */
  async function paste(): Promise<void> {
    const clip = await invoke<string | null>("clipboard_text").catch(() => null);
    if (!clip || !box) return;
    const a = box.selectionStart;
    const b = box.selectionEnd;
    text = text.slice(0, a) + clip + text.slice(b);
    saveDraft(localStorage, text);
    await tick();
    box.setSelectionRange(a + clip.length, a + clip.length);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void paste();
    }
  }

  function pick(t: QuickTarget): void {
    target = t;
    error = null;
    box?.focus();
  }

  onMount(() => {
    void refresh();
    const un = listen("quick-entry-shown", () => void refresh());
    // A click in another app: closed, the draft kept.
    const blur = () => hide();
    window.addEventListener("blur", blur);
    // A refused send's words put back by the main window while the box is open.
    const storage = (e: StorageEvent) => {
      if (e.key === KEYS.draft && !text.trim()) text = e.newValue ?? "";
    };
    window.addEventListener("storage", storage);
    return () => {
      void un.then((f) => f());
      window.removeEventListener("blur", blur);
      window.removeEventListener("storage", storage);
    };
  });
</script>

<main class="qe">
  <div class="targets" role="tablist" aria-label="Send to">
    {#each TARGETS as t (t)}
      <button
        role="tab"
        class:on={target === t}
        class:fixed={t === "new"}
        aria-selected={target === t}
        disabled={t !== "new" && !ctx.chat}
        onclick={() => pick(t)}>{targetName(t, ctx)}</button
      >
    {/each}
    {#if target === "new"}
      <select aria-label="Project" bind:value={project}>
        <option value={null}>No project</option>
        {#each ctx.projects as p (p.id)}
          <option value={p.id}>{p.name}</option>
        {/each}
      </select>
    {/if}
  </div>
  <textarea
    bind:this={box}
    bind:value={text}
    oninput={() => saveDraft(localStorage, text)}
    onkeydown={onKey}
    placeholder={target === "aside" ? "Ask an aside…" : "Type, dictate (Fn Fn) or paste…"}
    spellcheck="true"></textarea>
  <div class="foot">
    {#if error}<span class="err">{error}</span>{:else}<span class="hint">↩ send · ⇧↩ new line · esc keeps the draft</span>{/if}
    <button class="send" disabled={!text.trim()} onclick={() => void send()}>Send</button>
  </div>
</main>

<style>
  :global(html),
  :global(body),
  :global(#app) {
    margin: 0;
    height: 100%;
    background: #1b1916;
    color: #ece6da;
    font-family: "IBM Plex Sans", system-ui, sans-serif;
    font-size: 13px;
    overflow: hidden;
  }
  @media (prefers-color-scheme: light) {
    :global(html),
    :global(body) {
      background: #f6f2ea;
      color: #2a2620;
    }
  }
  .qe {
    box-sizing: border-box;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-radius: 10px;
  }
  .targets {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
  }
  .targets button,
  select {
    font: inherit;
    font-size: 12px;
    color: inherit;
    background: color-mix(in srgb, currentColor 7%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
    border-radius: 6px;
    padding: 3px 8px;
    max-width: 210px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .targets button {
    flex: 0 1 auto;
    min-width: 0;
  }
  .targets button.fixed,
  select {
    flex-shrink: 0;
  }
  .targets button.on {
    border-color: #c98a4b;
    background: color-mix(in srgb, #c98a4b 22%, transparent);
  }
  .targets button:disabled {
    opacity: 0.4;
  }
  textarea {
    flex: 1;
    resize: none;
    font: inherit;
    font-size: 14px;
    color: inherit;
    background: color-mix(in srgb, currentColor 5%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    border-radius: 8px;
    padding: 8px 10px;
    outline: none;
  }
  textarea:focus {
    border-color: color-mix(in srgb, #c98a4b 70%, transparent);
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
  }
  .hint {
    opacity: 0.6;
  }
  .err {
    color: #e0755f;
  }
  .send {
    font: inherit;
    font-size: 12px;
    color: #1b1916;
    background: #c98a4b;
    border: none;
    border-radius: 6px;
    padding: 4px 14px;
  }
  .send:disabled {
    opacity: 0.45;
  }
</style>
