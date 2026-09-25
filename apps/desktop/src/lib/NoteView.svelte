<script lang="ts">
  import { tip } from "./tip";
  import * as api from "./api";
  import {
    app,
    acceptProposal,
    addToast,
    closeNote,
    dismissProposal,
    mirrorDraft,
    noteDraftKey,
    revealFolder,
    saveNote,
    showNote,
    stageProposal,
    unstageProposal,
  } from "./state.svelte";
  import { renderMarkdown } from "./markdown";
  import ProposalReview from "./ProposalReview.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import {
    hrefTarget,
    linkTitle,
    parseLinks,
    renderNote,
    resolveLink,
  } from "./links";
  import type { NoteResolution } from "./links";
  import { modelOfInstructionFile } from "./catalog";
  import type { NoteScope } from "./types";
  import { tick } from "svelte";
  import NoteEditor from "./NoteEditor.svelte";
  import { clampCaret, loadNoteMode, saveNoteMode, type NoteMode } from "./noteMode";
  import { fieldScrollTop } from "./find";
  import NoteEditPanel from "./NoteEditPanel.svelte";
  import { noteEditUi, onLanded, runningTurn } from "./noteEdit.svelte";
  import { changedLines, splitReply } from "./noteEdit";

  /**
   * Which note the editor has loaded, as `scope:name`. A plain variable, not
   * `$state`: it exists to stop the load effect re-running, and making it
   * reactive would put the effect's own write in its dependency set.
   *
   * Keyed by scope as well as name because the two stores can each hold a
   * `plan.md`, and switching between them must reload rather than look like
   * the same note.
   */
  /**
   * The note this view shows, when it is a pane's tab rather than the
   * centre's one open note (nightshift backlog 099): a note beside a chat
   * reads and saves as the open one does, keyed by its own scope and
   * name. Absent — every caller before tabs — the view follows
   * `app.openNote` as it always has.
   */
  let { note = null }: { note?: { scope: NoteScope; name: string } | null } = $props();

  let loaded: string | null = null;
  let text = $state("");
  let saved = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let preview = $state(false);
  /**
   * Plain (the textarea) or formatted (the CodeMirror editor that draws the
   * Markdown and math in place) — nightshift backlog 150. One setting for
   * every note, the last picked (`noteMode.ts`). Both sides bind `text`, so
   * the draft, Revert and Save are the same whichever is showing.
   */
  let mode = $state<NoteMode>(loadNoteMode());
  /** Where the cursor was, as an offset into `text`: carried across a
   *  switch between the two sides and back from the preview. */
  let caret = $state(0);
  let area = $state<HTMLTextAreaElement | null>(null);
  let formatted = $state<ReturnType<typeof NoteEditor> | null>(null);

  const dirty = $derived(text !== saved);
  const open = $derived(note ?? app.openNote);
  const isVault = $derived(open?.scope === "knowledge");
  /**
   * Proposal mode: the dream suggested a replacement for this fixed file,
   * and the pane shows it as a diff against the saved text instead of the
   * editor. Only while the review is for the open scope — `showNote` clears
   * it on the way to any other note. The buffer is untouched until *Open
   * in the editor*, which makes the proposed text a draft and nothing more,
   * or *Accept*, which saves it (backlog 184).
   */
  const reviewing = $derived(
    app.proposalReview && open && app.proposalReview.scope === open.scope
      ? app.proposalReview
      : null,
  );
  /**
   * The card's proposed side as it reads now (backlog 184): the dream's
   * text, or his edit of it. Taken from `app.proposalEdits` when a review
   * opens, so an edit left behind comes back; mirrored there while it
   * differs from the dream's text. `proposedFor` is the proposal it
   * belongs to, set only once `proposed` holds that proposal's text — the
   * same guard `bufferKey` is for the note buffer.
   */
  let proposed = $state("");
  let proposedFor = $state<string | null>(null);
  $effect(() => {
    const r = reviewing;
    if (!r) {
      proposedFor = null;
      return;
    }
    if (r.entry.id === proposedFor) return;
    proposed = app.proposalEdits[r.entry.id] ?? r.entry.proposal.text;
    proposedFor = r.entry.id;
  });
  $effect(() => {
    const r = reviewing;
    if (!r || proposedFor !== r.entry.id) return;
    if (proposed !== r.entry.proposal.text) app.proposalEdits[r.entry.id] = proposed;
    else delete app.proposalEdits[r.entry.id];
  });
  let accepting = $state(false);
  /** Dismiss asks first: the badge goes with it, and a click must not lose
   *  something the user has not read (the never-lose-work rule). */
  let confirmDismiss = $state(false);
  /** A model's own instruction file: named after the id, read whole. */
  const isModel = $derived(open?.scope === "models");
  const modelId = $derived(isModel && open ? modelOfInstructionFile(open.name) : "");
  /**
   * The note whose text is in the buffer — set by `load` only once that
   * note's content is in `text` and `saved`, and cleared while a load is in
   * flight. Deliberately *not* derived from `open`: the selection changes a
   * tick before the buffer does, and an effect keyed on it wrote the
   * previous note's unsaved text as a draft under the next note's name.
   */
  let bufferKey = $state<string | null>(null);

  /**
   * Mirror the buffer into `app.noteDrafts` while it differs from the saved
   * text, and drop the entry once it matches again — so an edit typed and
   * then undone leaves no draft behind.
   */
  $effect(() => {
    const key = bufferKey;
    if (!key) return;
    mirrorDraft(key, text, saved);
  });

  /**
   * Edit with a prompt (nightshift backlog 151). While a rewrite of this
   * note streams, the note's pane shows the new text as it arrives, the
   * lines that differ from the old text marked; the buffer keeps the old
   * text until the reply is whole, so nothing typed or saved is touched by
   * a reply that stops halfway. When it lands (`onLanded`) the buffer takes
   * it — saved, or as a draft — and the changed lines stay marked for a few
   * seconds, or until a click or a key.
   */
  const streaming = $derived(bufferKey ? runningTurn(bufferKey) : null);
  const streamed = $derived.by(() => {
    const t = streaming;
    if (!t) return null;
    const note = splitReply(t.partial ?? "", t.before).note;
    const lines = note === "" ? [] : note.replace(/\n$/, "").split("\n");
    const marked = lines.length <= 2000 ? new Set(changedLines(t.before, note)) : new Set<number>();
    return { lines, marked };
  });
  let marks = $state<{ lines: string[]; marked: Set<number> } | null>(null);
  let marksTimer: ReturnType<typeof setTimeout> | null = null;
  const MARK_MS = 5000;
  function clearMarks() {
    if (marksTimer !== null) clearTimeout(marksTimer);
    marksTimer = null;
    marks = null;
  }
  $effect(() => {
    const key = bufferKey;
    if (!key) return;
    return onLanded(key, (l) => {
      text = l.text;
      if (l.saved) saved = l.text;
      clearMarks();
      if (l.marks.length > 0) {
        marks = { lines: l.text.replace(/\n$/, "").split("\n"), marked: new Set(l.marks) };
        marksTimer = setTimeout(clearMarks, MARK_MS);
      }
    });
  });
  $effect(() => () => clearMarks());
  let streamPane = $state<HTMLDivElement | null>(null);
  $effect(() => {
    void streamed?.lines.length;
    const el = streamPane;
    if (el) el.scrollTop = el.scrollHeight;
  });
  /** The first marked line in view when the marks show. */
  $effect(() => {
    const m = marks;
    const el = streamPane;
    if (!m || !el) return;
    const first = el.querySelector(".ln.mark");
    if (first instanceof HTMLElement) el.scrollTop = Math.max(0, first.offsetTop - el.clientHeight / 3);
  });

  /**
   * Links out of the note as it currently reads — from the buffer rather than
   * from the backend's graph, so a link typed a moment ago is already listed.
   * Only for the vault: the docspace has no link convention.
   *
   * Carries the whole resolution rather than a note-or-null, because the chip
   * has three states to draw and collapsing ambiguity into "missing" is what
   * offered to create a third copy of a note that already existed twice.
   */
  const outbound = $derived.by(() => {
    if (!isVault) return [];
    return parseLinks(text).map((l) => ({
      target: l.target,
      found: resolveLink(l.target, app.vault),
    }));
  });

  /**
   * Notes that link *to* this one — the half a file listing cannot show, and
   * most of why a vault is worth more than a folder.
   *
   * Read from the backend's graph rather than computed here, because it needs
   * the contents of every note in the vault and the frontend holds none of
   * them. It is therefore a snapshot: a backlink created by an unsaved edit
   * elsewhere is not in it, which cannot happen — there is one editor.
   */
  let backlinks = $state<string[]>([]);

  $effect(() => {
    const wanted = open ? `${open.scope}:${open.name}` : null;
    if (wanted === loaded) return;
    loaded = wanted;
    void load(open);
  });

  async function load(target: { scope: NoteScope; name: string } | null) {
    bufferKey = null;
    caret = 0;
    text = "";
    saved = "";
    error = null;
    backlinks = [];
    if (!target) return;
    loading = true;
    try {
      const content = await api.readNote(target.scope, target.name);
      const key = noteDraftKey(target.scope, target.name);
      saved = content;
      // A draft left on this note takes the buffer; the file stays the
      // saved baseline, so the ● and the Revert button say what differs.
      const draft = app.noteDrafts[key];
      text = draft !== undefined && draft !== content ? draft : content;
      bufferKey = key;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
    if (target.scope === "knowledge") void loadBacklinks(target.name);
  }

  async function loadBacklinks(name: string) {
    try {
      const graph = await api.knowledgeGraph();
      const index = graph.notes.findIndex((n) => n.name === name);
      if (index < 0) return;
      // Guarded on the note still being the open one: the graph is a round
      // trip, and clicking through two links quickly would otherwise leave
      // the first note's backlinks under the second.
      if (open?.name !== name) return;
      backlinks = graph.edges
        .filter((e) => e.to === index)
        .map((e) => graph.notes[e.from]?.name)
        .filter((n): n is string => !!n);
    } catch {
      backlinks = [];
    }
  }

  async function commit() {
    const target = open;
    if (!target || !dirty) return;
    const pending = text;
    if (await saveNote(target.scope, target.name, pending)) {
      saved = pending;
      addToast(`Saved ${target.name}`);
      if (target.scope === "knowledge") void loadBacklinks(target.name);
      // Opened from the popover or Settings: Save is the way back, as it is
      // for the prompt library (nightshift blocker 042), so the surface that
      // opened the file is what shows the result.
      if (app.noteFrom) closeNote();
    }
  }

  /** The folder this note is in. The models folder is not in app state —
   *  nothing else needs it — so it is asked for when the button is pressed. */
  async function showFolder() {
    if (!isModel) return revealFolder(folder);
    try {
      await revealFolder((await api.modelInstructionsDir()) ?? undefined);
    } catch (e) {
      addToast(String(e));
    }
  }

  /** Drop the draft: the buffer goes back to the last saved text. A
   *  proposal that was loaded is no longer what a Save would apply. */
  function revert() {
    if (!dirty) return;
    text = saved;
    if (bufferKey) unstageProposal(bufferKey);
  }

  /**
   * Load the proposal into the buffer as a draft. `stageProposal` writes
   * the draft entry and remembers which proposal it was; the buffer takes
   * the same text so ● draft, Revert and Save behave exactly as for typed
   * text. The file is not written here or anywhere but Save.
   */
  function loadProposal() {
    const r = reviewing;
    if (!r || !open) return;
    // The proposed side as the card shows it, his edits there included.
    const next = proposed;
    if (next === saved) {
      addToast("The proposal matches the file as saved — nothing to load");
      app.proposalReview = null;
      return;
    }
    stageProposal(r.scope, r.entry, saved, next);
    text = next;
  }

  /**
   * Accept on the card (backlog 184): the proposed side, edited or not, is
   * saved to the file in one click — the header's Save path, so the chat
   * re-connects and the proposal is filed as applied. A draft already in
   * the editor stays a draft, now against the new saved text; with none,
   * the editor shows what was saved.
   */
  async function accept() {
    const r = reviewing;
    const target = open;
    if (!r || !target || accepting || proposed === saved) return;
    const next = proposed;
    const hadDraft = dirty;
    const heldKey = bufferKey;
    accepting = true;
    const ok = await acceptProposal(r.scope, r.entry, next);
    accepting = false;
    if (!ok) return;
    // The save and the re-connect are round trips: if another note took
    // the buffer meanwhile, its text is not ours to overwrite (review of
    // 1285561): writing it would put AGENTS.md's text under that note's
    // name and drop that note's draft.
    if (bufferKey === heldKey) {
      saved = next;
      if (!hadDraft) text = next;
    }
    addToast(`Accepted — saved ${target.name}`);
    if (app.noteFrom) closeNote();
  }

  async function confirmDismissal() {
    const r = reviewing;
    confirmDismiss = false;
    if (!r) return;
    if (await dismissProposal(r.scope, r.entry.id)) addToast("Proposal dismissed — kept under proposals/dismissed");
  }

  /**
   * Follow a `[[link]]` from the preview.
   *
   * Delegated from the pane rather than bound per anchor, because the HTML is
   * produced by the markdown renderer and there is nothing to bind to. A
   * target that resolves to nothing *creates* the note — writing `[[thing]]`
   * before it exists is how a note gets planned, so the click is the natural
   * moment to start it. An *ambiguous* one does not: the note it names already
   * exists more than once, and a third copy is the one outcome that makes the
   * vault worse.
   */
  async function onPreviewClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest("a");
    const target = hrefTarget(anchor?.getAttribute("href") ?? null);
    if (target === null) return;
    e.preventDefault();
    await follow(target);
  }

  async function follow(target: string) {
    const found = resolveLink(target, app.vault);
    if (found.kind === "note") {
      showNote("knowledge", found.note.name);
      return;
    }
    // Nowhere to go and nothing to create: name the candidates and leave the
    // choice to the writer, who is the only one who knows which was meant.
    if (found.kind === "ambiguous") {
      addToast(linkTitle(target, found));
      return;
    }
    const name = /\.[a-z0-9]+$/i.test(target) ? target : `${target}.md`;
    if (await saveNote("knowledge", name, "")) showNote("knowledge", name);
  }

  /**
   * What an outbound chip's hover says. Only the missing case differs from the
   * preview's wording, because only this chip acts on it: clicking it writes
   * the note. The other two, ambiguity included, read the same everywhere.
   */
  function chipTitle(target: string, found: NoteResolution): string {
    return found.kind === "missing"
      ? `${target} — click to create`
      : linkTitle(target, found);
  }

  /** Read the cursor off whichever side is showing. */
  function readCaret() {
    if (area) caret = area.selectionStart;
    else if (formatted) caret = formatted.head();
  }

  /**
   * Switch plain ↔ formatted. The text is one buffer, so nothing is copied
   * and nothing can be lost; the cursor is read off the side going away and
   * put back on the side arriving. From the preview, either choice also
   * leaves the preview.
   */
  async function setMode(next: NoteMode) {
    readCaret();
    const was = mode;
    preview = false;
    mode = next;
    if (next !== was) saveNoteMode(next);
    if (next === "plain") await focusArea();
  }

  function togglePreview() {
    readCaret();
    preview = !preview;
    if (!preview && mode === "plain") void focusArea();
  }

  /** The textarea, focused with the cursor where it was and its line in view. */
  async function focusArea() {
    await tick();
    const el = area;
    if (!el) return;
    const at = clampCaret(caret, el.value);
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    if (el.scrollHeight > el.clientHeight) el.scrollTop = fieldScrollTop(el.value, at, lh, el.clientHeight);
  }

  function onkeydown(e: KeyboardEvent) {
    // A key ends the marks of a landed rewrite, back to the editor — unless
    // it is typed into the prompt panel, which sits beside the marks.
    if (marks && !(e.target instanceof HTMLElement && e.target.closest(".panel"))) clearMarks();
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void commit();
    }
  }

  const folder = $derived(
    isVault ? app.knowledge?.dir : app.project?.notes_dir,
  );
</script>

<svelte:window {onkeydown} />

<div class="note">
  <header>
    <button class="back" onclick={closeNote}>
      {app.noteFrom === "rail" ? "← Model" : app.noteFrom === "settings" ? "← Settings" : "← Chat"}
    </button>
    <span class="scope" class:vault={isVault}>
      {open?.scope ?? "project"}
    </span>
    <span class="title">{open?.name ?? "no note"}</span>
    {#if reviewing}<span class="proposed" use:tip={"The dream proposed a replacement; nothing is applied until you Accept it (or open it in the editor and save)"}>proposed change</span>{/if}
    {#if dirty}<span class="dirty" use:tip={"Unsaved changes — kept as a draft until you save or revert"}>● draft</span>{/if}
    <span class="spacer"></span>
    {#if dirty}
      <button
        class="ghost revert"
        use:tip={"Discard the draft and go back to the last saved version"}
        onclick={revert}>Revert</button
      >
    {/if}
    <!-- Plain or formatted (backlog 150): two halves of one chip, the
         lit half the side that shows when not previewing. -->
    <span class="modes" role="group" aria-label="Editor">
      <button
        class="ghost mode"
        class:on={!preview && mode === "plain"}
        use:tip={"Plain: the Markdown source as typed"}
        onclick={() => void setMode("plain")}
        disabled={!open || !!reviewing}>Plain</button
      ><button
        class="ghost mode"
        class:on={!preview && mode === "formatted"}
        use:tip={"Formatted: headings, emphasis, code and math drawn in place, still editable — the cursor's line shows its source"}
        onclick={() => void setMode("formatted")}
        disabled={!open || !!reviewing}>Formatted</button
      >
    </span>
    <button
      class="ghost"
      class:on={preview}
      onclick={togglePreview}
      disabled={!open || !!reviewing}
    >
      {preview ? "Edit" : "Preview"}
    </button>
    <button
      class="ghost"
      class:on={noteEditUi.open}
      use:tip={"Tell a model what changed and it rewrites the whole note to fit, in a small chat on the right. Direct editing stays as it is."}
      onclick={() => (noteEditUi.open = !noteEditUi.open)}
      disabled={!open}>Edit with a prompt</button
    >
    <button
      class="ghost"
      use:tip={"Show the folder"}
      onclick={() => void showFolder()}>Folder</button
    >
    <button class="save" onclick={() => void commit()} disabled={!dirty}>
      Save
    </button>
  </header>

  <div class="body">
  <div class="main">
  {#if error}
    <p class="err">{error}</p>
  {:else if loading}
    <p class="err quiet">Reading…</p>
  {:else if streamed || marks}
    <!-- A rewrite streaming in, or one that just landed with its changed
         lines marked (backlog 151). Read-only; a click or a key goes back
         to the editor, which already holds the landed text. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="pane stream"
      class:live={!!streamed}
      bind:this={streamPane}
      onclick={() => {
        if (!streamed) clearMarks();
      }}
    >
      {#each (streamed ?? marks)?.lines ?? [] as line, i (i)}
        <div class="ln" class:mark={(streamed ?? marks)?.marked.has(i)}>{line || " "}</div>
      {/each}
      {#if streamed}<div class="ln caret">▍</div>{/if}
    </div>
  {:else if reviewing}
    <!-- The proposal: why, the diff with its proposed side editable, four
         ways out. The editor and its buffer are behind this, untouched,
         until Accept or Open in the editor (backlog 184). -->
    <div class="review">
      <div class="why">
        <span class="label">why</span>
        <p>{reviewing.entry.proposal.why}</p>
        <span class="when">
          proposed by the dream · {new Date(reviewing.entry.proposal.at).toLocaleString()}
          {#if app.proposals[reviewing.scope].length > 1}
            · {app.proposals[reviewing.scope].length - 1} older pending
          {/if}
        </span>
      </div>
      <ProposalReview
        saved={saved}
        original={reviewing.entry.proposal.text}
        name={open?.name ?? "AGENTS.md"}
        bind:proposed
      />
      <div class="actions">
        <button
          class="accept"
          use:tip={proposed === saved
            ? "The proposed side matches the file as saved — nothing to save"
            : "Save the proposed side, as it reads now, to the file"}
          disabled={accepting || proposed === saved}
          onclick={() => void accept()}>{accepting ? "Saving…" : "Accept"}</button
        >
        <button
          class="load"
          use:tip={"Put the proposed side in the editor as a draft for a longer rework — Revert drops it, Save applies it"}
          onclick={loadProposal}>Open in the editor</button
        >
        <button
          class="ghost revert"
          use:tip={"Turn the proposal down — it is moved aside, not deleted"}
          onclick={() => (confirmDismiss = true)}>Dismiss</button
        >
        <button class="ghost" use:tip={"Close for now; the badge stays"} onclick={closeNote}
          >Keep for later</button
        >
      </div>
    </div>
  {:else if preview}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pane preview markdown" onclick={onPreviewClick}>
      {#if isVault}
        {@html renderNote(text, app.vault)}
      {:else}
        {@html renderMarkdown(text)}
      {/if}
    </div>
  {:else if mode === "formatted"}
    {#key bufferKey}
      <NoteEditor
        bind:this={formatted}
        bind:value={text}
        {caret}
        placeholder={isVault
          ? "Yours, and readable from every project. Link another note with [[name]]."
          : isModel
            ? `How you want ${modelId} in particular to behave. Empty means no file.`
            : "Anything here is read by every chat in this project."}
        oncaret={(o) => (caret = o)}
        onfollow={(t) => void follow(t)}
      />
    {/key}
  {:else}
    <!-- Named, so the field has an accessible name when it is empty (an
         unnamed empty textarea is invisible to assistive tech and to the
         driving tools alike — the prompt library's fields had the same fix). -->
    <textarea
      class="pane"
      aria-label="Note text"
      bind:this={area}
      bind:value={text}
      onblur={() => {
        if (area) caret = area.selectionStart;
      }}
      spellcheck="false"
      placeholder={isVault
        ? "Yours, and readable from every project. Link another note with [[name]]."
        : isModel
          ? `How you want ${modelId} in particular to behave. Empty means no file.`
          : "Anything here is read by every chat in this project."}
    ></textarea>
  {/if}

  <!-- Links, both directions. Only for the vault: the docspace has no link
       convention, and an empty strip on every project note would be chrome
       that never says anything. -->
  {#if isVault && (outbound.length > 0 || backlinks.length > 0)}
    <div class="links">
      {#if outbound.length > 0}
        <div class="strip">
          <span class="label">links to</span>
          {#each outbound as l (l.target)}
            <button
              class="chip"
              class:broken={l.found.kind !== "note"}
              use:tip={chipTitle(l.target, l.found)}
              onclick={() => void follow(l.target)}
              >{l.target}{l.found.kind === "ambiguous" ? " ⚠" : ""}</button
            >
          {/each}
        </div>
      {/if}
      {#if backlinks.length > 0}
        <div class="strip">
          <span class="label">linked from</span>
          {#each backlinks as name (name)}
            <button class="chip" onclick={() => showNote("knowledge", name)}
              >{name}</button
            >
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  </div>
  {#if noteEditUi.open && open}
    <NoteEditPanel
      scope={open.scope}
      name={open.name}
      {text}
      disabled={loading || !!error || !!reviewing || bufferKey === null}
    />
  {/if}
  </div>

  <footer>
    {#if open?.scope === "instructions"}
      Standing instructions for <strong>{app.project?.name ?? "this project"}</strong
      >. Read <em>whole</em> into every chat's system prompt — keep it short and
      specific; anything that is only sometimes relevant belongs in a note
      below, which the model reads on demand. Saving re-connects the open chat.
    {:else if open?.scope === "memory"}
      How you want the model to behave, in every project and in chats with no
      project. Read <em>whole</em> into every chat's system prompt — keep it
      short; facts and decisions worth keeping belong in the knowledge base,
      which the model reads on demand. Saving re-connects the open chat.
    {:else if isModel}
      Instructions for <strong>{modelId}</strong> and no other model, in every
      project. Read <em>whole</em> into the system prompt of a chat on that
      model, after your memory and before the project's instructions — for
      what you want of this model in particular; what applies to every model
      belongs in Memory. An empty file is the same as none. Saving re-connects
      the open chat.
    {:else if isVault}
      Yours, across every project — the model sees this file's name and first
      line in its system prompt and reads the rest with the file tools, at
      <code>@kb/{open?.name ?? ""}</code>.
    {:else}
      Shared with every chat in <strong>{app.project?.name ?? "this project"}</strong
      >. The model sees this file's name and first line in its system prompt, and
      reads the rest with the file tools when it needs to.
    {/if}
  </footer>
</div>

{#if confirmDismiss && reviewing}
  <ConfirmDialog
    title="Dismiss this proposal?"
    lead="The proposed text is moved to proposals/dismissed and the badge goes; the file is not touched either way."
    facts={[["for", reviewing.scope === "memory" ? "your memory" : `${app.project?.name ?? "this project"}'s instructions`]]}
    confirmLabel="Dismiss"
    onconfirm={() => void confirmDismissal()}
    onclose={() => (confirmDismiss = false)}
  />
{/if}

<style>
  .note {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* The note beside its prompt panel (backlog 151): the note's column is
     what every branch below lays out in, as `.note` was before. */
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .stream {
    font-family: var(--mono);
    font-size: 0.84rem;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    cursor: default;
  }
  .stream .ln {
    border-radius: 3px;
    transition: background-color 1.2s ease;
  }
  .stream .ln.mark {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }
  .stream .caret {
    color: var(--accent);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    to {
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.55rem 0.9rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    flex-shrink: 0;
  }
  .back {
    background: transparent;
    border: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.2rem 0.3rem;
    cursor: pointer;
    border-radius: 5px;
  }
  .back:hover {
    color: var(--text);
  }
  /* Which store this note is in. Two of them can hold the same name, and the
     header is the only place that says which one is open. */
  .scope {
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--dim);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0.1rem 0.35rem;
    flex-shrink: 0;
  }
  .scope.vault {
    color: var(--accent);
    border-color: var(--accent);
  }
  .title {
    font-family: var(--mono);
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dirty {
    color: var(--accent);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
  }
  /* The review's marker, in the scope chip's shape so the header reads
     "instructions · AGENTS.md · proposed change". */
  .proposed {
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 5px;
    padding: 0.1rem 0.35rem;
    flex-shrink: 0;
  }
  .review {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .why {
    flex-shrink: 0;
    padding: 0.7rem 1.2rem 0.6rem;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .why p {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--text);
  }
  .why .when {
    font-size: 0.68rem;
    color: var(--dim);
  }
  .actions {
    flex-shrink: 0;
    display: flex;
    gap: 0.5rem;
    padding: 0.55rem 1.2rem;
    border-top: 1px solid var(--border);
    background: var(--panel);
  }
  .load {
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 7px;
    color: var(--accent);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
  }
  .load:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  /* The one-click way out (backlog 184): filled, so it reads as the
     primary action beside the outlined ones. */
  .accept {
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 7px;
    color: var(--bg);
    font-family: inherit;
    font-size: 0.76rem;
    font-weight: 600;
    padding: 0.25rem 0.75rem;
    cursor: pointer;
  }
  .accept:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, white);
  }
  .accept:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .spacer {
    flex: 1;
  }
  .ghost,
  .save {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .ghost:hover:not(:disabled),
  .save:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--dim);
  }
  .ghost.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .modes {
    display: inline-flex;
    flex-shrink: 0;
  }
  .ghost.mode:first-child {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .ghost.mode:last-child {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    margin-left: -1px;
  }
  .ghost.mode.on {
    position: relative;
  }
  /* Revert discards typing: a red outline says so without a dialog (his
     call, 2026-09-14 — the draft is the safety net, not a confirmation). */
  .ghost.revert {
    color: var(--failed);
    border-color: #7a3d3f;
  }
  .ghost.revert:hover:not(:disabled) {
    color: var(--failed);
    border-color: var(--failed);
  }
  .ghost:disabled,
  .save:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .save:not(:disabled) {
    color: var(--accent);
    border-color: var(--accent);
  }
  .pane {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin: 0;
    padding: 1rem 1.2rem;
    background: var(--bg);
    color: var(--text);
  }
  textarea.pane {
    border: none;
    resize: none;
    font-family: var(--mono);
    font-size: 0.84rem;
    line-height: 1.6;
  }
  textarea.pane:focus {
    outline: none;
  }
  .err {
    margin: 1rem 1.2rem;
    color: var(--error);
    font-size: 0.82rem;
  }
  .err.quiet {
    color: var(--dim);
  }
  .links {
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    background: var(--panel);
    padding: 0.4rem 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .strip {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .label {
    font-size: 0.64rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--dim);
    opacity: 0.8;
    margin-right: 0.15rem;
  }
  .chip {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text);
    font-family: var(--mono);
    font-size: 0.7rem;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
  }
  .chip:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  /* A link to a note that does not exist yet. Dashed rather than red: it is
     how a note gets planned, not a mistake. */
  .chip.broken {
    border-style: dashed;
    color: var(--dim);
  }
  footer {
    flex-shrink: 0;
    padding: 0.5rem 1.2rem;
    border-top: 1px solid var(--border);
    background: var(--panel);
    color: var(--dim);
    font-size: 0.7rem;
    line-height: 1.45;
  }
  footer strong {
    color: var(--text);
    font-weight: 500;
  }
  footer code {
    font-family: var(--mono);
  }

  /* Emitted by the markdown renderer, so scoped styles cannot reach it. */
  :global(.note .preview a.wikilink) {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    cursor: pointer;
  }
  :global(.note .preview a.wikilink.broken) {
    color: var(--dim);
    border-bottom-style: dashed;
  }
</style>
