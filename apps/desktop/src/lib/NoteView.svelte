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
  import ProposalReview from "./ProposalReview.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { linkTitle, parseLinks, resolveLink } from "./links";
  import type { NoteResolution } from "./links";
  import { modelOfInstructionFile } from "./catalog";
  import type { NoteScope } from "./types";
  import { tick, untrack } from "svelte";
  import NoteEditor from "./NoteEditor.svelte";
  import NoteMedia from "./NoteMedia.svelte";
  import NoteToolbar from "./NoteToolbar.svelte";
  import { loadNoteMarkdown, saveNoteMarkdown } from "./noteMode";
  import { attachmentsFolder, imageAlt, imageNoteName, insertImage, linkPath, relativeToNote } from "./noteFormat";
  import { readBase64 } from "./attachFiles.svelte";
  import NoteEditPanel from "./NoteEditPanel.svelte";
  import { noteEditUi, onLanded, runningTurn } from "./noteEdit.svelte";
  import { changedLines, editBlock, jumpTarget } from "./noteEdit";
  import { lineOffset } from "./memoryHits";
  import { moveNoteTo } from "./state.svelte";
  import { baseOf, parentOf, renamedTo } from "./notesTree";
  import { floatMenu } from "./floatMenu";
  import { viewGet, viewSet } from "./viewState";
  import { splitExt, whoFoldKey } from "./noteHead";
  import { exactTime, relativeTime } from "./time";

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
  /**
   * `away` (item 487): the view is a kept tab behind another one in its
   * pane — mounted, hidden, keeping its caret, selection and scroll. It
   * then takes no keys (⌘S is the note in front's), and coming back to the
   * front it takes up the mode last picked in another note (one setting for
   * every note, 150's rule), the cursor carried over as a switch does.
   */
  let { note = null, away = false }: { note?: { scope: NoteScope; name: string } | null; away?: boolean } = $props();

  let loaded: string | null = null;
  let text = $state("");
  let saved = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);
  /** A note that is not text (backlog 307): drawn, never edited. */
  let media = $state<api.FileTabData | null>(null);
  /**
   * Item 498: one editor (the CodeMirror one, `noteEditor.ts`), opened
   * formatted — the Plain textarea and the Preview are gone from the note.
   * `markdown` is the toolbar's switch to the raw Markdown in the same
   * editor: one setting for every note, the last picked (`noteMode.ts`),
   * kept across a chat switch, a tab switch and a relaunch.
   */
  let markdown = $state(loadNoteMarkdown());
  /** Where the cursor was, as an offset into `text`: where the editor
   *  mounts it (a jump to a line, a reload). */
  let caret = $state(0);
  let formatted = $state<ReturnType<typeof NoteEditor> | null>(null);

  const dirty = $derived(text !== saved);
  const open = $derived(note ?? app.openNote);
  const isVault = $derived(open?.scope === "knowledge");
  /**
   * Item 565: the head's facts line under Filament IV (f4-notes.png) —
   * when the note was last saved (from the notes list the panel already
   * holds), its words, and whether what is on screen is saved. Classic
   * hides the line by CSS.
   */
  const listed = $derived.by(() => {
    const o = open;
    if (!o) return null;
    const list = o.scope === "knowledge" ? app.vault : o.scope === "project" ? app.notes : [];
    return list.find((n) => n.name === o.name) ?? null;
  });
  const words = $derived(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
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
  /** The proposal card, for the edit panel's "Show the proposal". */
  let reviewEl = $state<HTMLDivElement | null>(null);
  let reviewFlash = $state(false);
  let reviewFlashTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bring the proposal card into view, focus its first live button, and
   *  flash it for a moment so the eye finds it. A second click restarts
   *  the flash's 1.2 s: the earlier timer is cleared, so it cannot end the
   *  new flash early (w3 review finding 5, 2026-10-08). */
  function showProposal() {
    const el = reviewEl;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    const first = el.querySelector<HTMLButtonElement>(".actions button:not(:disabled)");
    first?.focus();
    reviewFlash = true;
    if (reviewFlashTimer !== null) clearTimeout(reviewFlashTimer);
    reviewFlashTimer = setTimeout(() => {
      reviewFlash = false;
      reviewFlashTimer = null;
    }, 1200);
  }
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
  /** Why the edit panel cannot send (backlog 325), or null — a proposal
   *  open on the note is not a reason (backlog 345). */
  const editBlocked = $derived(
    editBlock({ loading, error: !!error, hasBuffer: bufferKey !== null }),
  );

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
   * Edit with a prompt (nightshift backlog 151). While a turn on this note
   * runs, the note's pane shows the file as each Edit leaves it (pass 2:
   * `current`, from `note-edit-landed`), the lines that differ from the
   * text before the turn marked. The pane is read-only and stands in for
   * the editor, so nothing can be typed into the note for an Edit to land
   * over. When the turn ends (`onLanded`) the buffer takes the file's text
   * as saved, and the changed lines stay marked for a few seconds, or
   * until a click or a key.
   */
  const streaming = $derived(bufferKey ? runningTurn(bufferKey) : null);
  const streamed = $derived.by(() => {
    const t = streaming;
    if (!t) return null;
    const note = t.current ?? t.before;
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
    jumped = false;
  }
  /**
   * A changed line clicked in the edit panel (backlog 345): the note shows
   * with that line marked for a moment (the landed-edit marks, reused), then
   * the editor comes back with the cursor on it.
   */
  let jumped = $state(false);
  const JUMP_MS = 1600;
  function showLine(line: number) {
    if (streamed || !bufferKey || media) return;
    clearMarks();
    // `jumpTarget` (wave 7 review round 2): the caret goes to the start of
    // the marked line — `lineOffset` counts from 1, and passing the 0-based
    // line put it one line above the mark.
    const { lines, at, offset } = jumpTarget(text, line);
    marks = { lines, marked: new Set([at]) };
    jumped = true;
    caret = offset;
    marksTimer = setTimeout(() => {
      clearMarks();
      jump += 1;
    }, JUMP_MS);
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
  /** The first marked line in view — as each Edit lands, and when the
   *  marks show at the end. (Pass 1 followed the stream's tail instead.) */
  $effect(() => {
    const m = streamed ?? marks;
    const el = streamPane;
    if (!m || !el) return;
    void tick().then(() => {
      const first = el.querySelector(".ln.mark");
      if (first instanceof HTMLElement) el.scrollTop = Math.max(0, first.offsetTop - el.clientHeight / 3);
    });
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

  /**
   * A memory hit on the note already open (backlog 296): move the cursor to
   * its line — the formatted editor takes a caret only on mount, so
   * `jump` remounts it — and leave the buffer, a draft included, as it is.
   */
  let jump = $state(0);
  $effect(() => {
    const at = app.noteAt;
    if (!at || !open || loading || !bufferKey) return;
    if (`${at.scope}:${at.name}` !== loaded || open.scope !== at.scope || open.name !== at.name) return;
    caret = lineOffset(text, at.line);
    app.noteAt = null;
    jump += 1;
  });

  async function load(target: { scope: NoteScope; name: string } | null) {
    bufferKey = null;
    caret = 0;
    text = "";
    saved = "";
    error = null;
    media = null;
    backlinks = [];
    images.clear();
    if (!target) return;
    loading = true;
    try {
      // Not text — a PDF, an image, a deck in the project's files — is
      // drawn rather than read as a string (backlog 307: "stream did not
      // contain valid UTF-8"), and no buffer is opened on it.
      const drawn = await api.readNoteMedia(target.scope, target.name);
      if (drawn) {
        media = drawn;
        return;
      }
      const content = await api.readNote(target.scope, target.name);
      const key = noteDraftKey(target.scope, target.name);
      saved = content;
      // A draft left on this note takes the buffer; the file stays the
      // saved baseline, so the ● and the Revert button say what differs.
      const draft = app.noteDrafts[key];
      text = draft !== undefined && draft !== content ? draft : content;
      // Opened from a memory hit (backlog 296): the cursor on its line,
      // set before the editor mounts on the new buffer.
      const at = app.noteAt;
      if (at && at.scope === target.scope && at.name === target.name) {
        caret = lineOffset(text, at.line);
        app.noteAt = null;
      }
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
   * Follow a `[[link]]` (⌘-click in the editor, a chip). A target that
   * resolves to nothing *creates* the note — writing `[[thing]]` before it
   * exists is how a note gets planned, so the click is the natural moment to
   * start it. An *ambiguous* one does not: the note it names already exists
   * more than once, and a third copy is the one outcome that makes the vault
   * worse. (The Preview's anchor clicks came here too until item 498.)
   */
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

  /* Coming back to the front (487's kept tab), the Markdown switch is as
     last picked in another note (one setting, 495's rule for the Preview). */
  $effect(() => {
    if (away) return;
    untrack(() => {
      const last = loadNoteMarkdown();
      if (last !== markdown) markdown = last;
    });
  });

  /** The toolbar's Markdown switch: the same editor, drawn or not. */
  function setMarkdownView(on: boolean) {
    markdown = on;
    saveNoteMarkdown(on);
  }

  /**
   * Images (item 498, blocker 1652). The toolbar's Image copies the file
   * picked into `attachments/` beside the note (`keep_note_file`, the notes
   * panel's keep with Keep both) and inserts `![name](attachments/…)` at
   * the caret, as one undo step. Only the two stores of notes have a folder
   * beside the note; the fixed files (AGENTS.md, memory, a model's file)
   * do not take images.
   */
  const canImage = $derived(open?.scope === "project" || open?.scope === "knowledge");
  async function addImage(file: File) {
    const target = open;
    const key = bufferKey;
    if (!target || !key || !canImage) return;
    try {
      const data = await readBase64(file);
      const landing = await api.keepNoteFile(
        target.scope,
        attachmentsFolder(target.name),
        file.name,
        file.type || "application/octet-stream",
        data,
      );
      if (landing.kind !== "kept") throw new Error(`${landing.rel} is taken`);
      // The round trip is long enough to switch notes: the link goes only
      // into the note it was picked for.
      if (bufferKey !== key || !formatted) return;
      formatted.run(insertImage(imageAlt(file.name), linkPath(relativeToNote(target.name, landing.rel))));
    } catch (e) {
      addToast(`Could not add the image: ${String(e)}`);
    }
  }

  /** A relative image link drawn from the file beside the note: its bytes
   *  as a `data:` URL (the way an image tab draws one), kept per note. */
  const images = new Map<string, Promise<string | null>>();
  function imageSource(src: string): Promise<string | null> {
    const target = open;
    if (!target) return Promise.resolve(null);
    const name = imageNoteName(target.name, src);
    if (!name) return Promise.resolve(null);
    const k = `${target.scope}:${name}`;
    const have = images.get(k);
    if (have) return have;
    const p = api
      .readNoteMedia(target.scope, name)
      .then((m) => (m?.kind === "image" && m.data ? `data:${m.media_type};base64,${m.data}` : null))
      .catch(() => null);
    // A miss is not kept: the file may land a moment later.
    void p.then((u) => {
      if (!u) images.delete(k);
    });
    images.set(k, p);
    return p;
  }

  function onkeydown(e: KeyboardEvent) {
    if (away) return;
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

  /**
   * Item 460 (his bug: "i dont see a way for me to rename the file"): the
   * title is the name, and clicking it edits it in place — Enter renames,
   * Escape leaves it as it was. Only the two folders of notes can be
   * renamed; the fixed files (`AGENTS.md`, a model's file) cannot. Tabs
   * and the draft follow the file (`moveNoteTo`).
   */
  const canRename = $derived(!!open && (open.scope === "project" || open.scope === "knowledge") && !reviewing);
  let renaming = $state(false);
  let renameValue = $state("");
  function startRename() {
    if (!canRename || !open) return;
    renameValue = baseOf(open.name);
    renaming = true;
  }
  async function commitRename() {
    if (!renaming) return;
    renaming = false;
    const o = open;
    if (!o || (o.scope !== "project" && o.scope !== "knowledge")) return;
    const to = renamedTo(o.name, renameValue);
    if (!to) return;
    await moveNoteTo(o.scope, o.name, to, (k) => runningTurn(k) !== null);
  }
  function renameKeys(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      renaming = false;
    }
  }
  function focusRename(el: HTMLInputElement) {
    el.focus();
    const dot = el.value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
  }

  /*
   * Item 496, his pick option 2 ("Document head"): no bar. A back link and a
   * small tool cluster on a thin row; then the scope chip and folder, the
   * name as a large serif heading and one "who reads this" line, which
   * scroll away with the text; Save / Revert in a pill only while there is
   * a draft.
   *
   * The head scrolls with the text without moving the text's scroller: the
   * editor, the textarea, the preview and the stream pane each keep their
   * own scroll (the find bar, the caret centring, CodeMirror's viewport and
   * 487's kept tabs all rely on it). The head is laid over the top of the
   * pane, the pane leaves `--head-h` of room above its first line, and the
   * head moves up by the pane's `scrollTop` — so it reads as the page's top
   * and goes with it. A wheel over the head is handed to the pane. A PDF or
   * an image, the proposal review, a read error and "Reading…" keep the head
   * in the flow above them instead (`overlay` false).
   */
  const overlay = $derived(!media && !reviewing && !error && !loading);
  /** The editor is what shows (item 498: the toolbar is only over it). */
  const editorShown = $derived(overlay && !streamed && !marks && !!open);
  /* Blocker 1649 (answered by his pick): the large name always shows, and
     a note's own first heading stays in its text as it is. */
  const nameParts = $derived(splitExt(baseOf(open?.name ?? "")));
  let mainEl = $state<HTMLDivElement | null>(null);
  let headEl = $state<HTMLDivElement | null>(null);
  let headH = $state(0);
  let shift = $state(0);
  $effect(() => {
    const el = headEl;
    if (!el) return;
    const ro = new ResizeObserver(() => (headH = el.offsetHeight));
    ro.observe(el);
    headH = el.offsetHeight;
    return () => ro.disconnect();
  });
  /** The pane that scrolls the note's text now, if any. */
  function activePane(): HTMLElement | null {
    return mainEl?.querySelector<HTMLElement>(".scrolls > .pane, .scrolls .cm-scroller") ?? null;
  }
  function onPaneScroll(e: Event) {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t !== activePane()) return;
    shift = t.scrollTop;
  }
  /** A different pane came in (a mode switch, the stream, a reload): the
   *  head follows that pane's own scroll. */
  $effect(() => {
    void markdown;
    void streamed;
    void marks;
    void bufferKey;
    void overlay;
    void jump;
    void tick().then(() => (shift = activePane()?.scrollTop ?? 0));
  });
  function onHeadWheel(e: WheelEvent) {
    if (!overlay) return;
    activePane()?.scrollBy({ top: e.deltaY, left: e.deltaX });
  }

  /** The ⋯ menu: Show the folder, and Rename for the notes that can be. */
  let moreOpen = $state(false);
  let moreBtn = $state<HTMLButtonElement | null>(null);
  let moreEl = $state<HTMLDivElement | null>(null);
  function onDocDown(e: MouseEvent) {
    const t = e.target as Node;
    if (moreBtn?.contains(t) || moreEl?.contains(t)) return;
    moreOpen = false;
  }
  $effect(() => {
    if (!moreOpen) return;
    document.addEventListener("mousedown", onDocDown, true);
    return () => document.removeEventListener("mousedown", onDocDown, true);
  });
  $effect(() => {
    if (away) moreOpen = false;
  });
  function moreKeys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      moreOpen = false;
      moreBtn?.focus();
    }
  }
  function pickMore(act: () => void) {
    moreOpen = false;
    act();
  }

  /** The "who reads this" line's More (drawback 3): the long per-scope
   *  texts are cut to one line, the whole a click away, the fold kept per
   *  scope past the view (495's viewState). */
  let whoFolds = $state<Record<string, boolean>>({});
  const whoScope = $derived(media ? "media" : (open?.scope ?? "project"));
  const whoLong = $derived(whoScope === "instructions" || whoScope === "memory" || whoScope === "models" || whoScope === "media");
  const whoOpen = $derived(whoLong && (whoFolds[whoScope] ?? viewGet(whoFoldKey(whoScope), false)));
  function toggleWho() {
    const next = !whoOpen;
    whoFolds[whoScope] = next;
    viewSet(whoFoldKey(whoScope), next, false);
  }
  const backLabel = $derived(app.noteFrom === "rail" ? "Model" : app.noteFrom === "settings" ? "Settings" : "Chat");
</script>

<svelte:window {onkeydown} />

<div class="note" class:with-draft={dirty && !media}>
  <!-- Item 496 (option 2): no bar — the way back at the left, the tools at
       the right, on the page's own background. -->
  <div class="toprow">
    <button class="back" use:tip={`Back to the ${backLabel.toLowerCase()} (Esc)`} onclick={closeNote}>
      <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>{backLabel}
    </button>
    <span class="spacer"></span>
    <div class="tools">
      {#if !media}
        <!-- Item 498: no Plain / Formatted / Preview — the note opens
             formatted, and the toolbar below carries the Markdown switch. -->
        <button
          class="seg ask"
          class:on={noteEditUi.open}
          aria-pressed={noteEditUi.open}
          aria-label="Edit with a prompt"
          use:tip={"Tell a model what changed and it edits this note to fit, in a small chat on the right. Direct editing stays as it is."}
          onclick={() => (noteEditUi.open = !noteEditUi.open)}
          disabled={!open}
          ><svg class="ico spark" viewBox="0 0 16 16" aria-hidden="true"
            ><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.6 1.6M10.4 10.4 12 12M12 4l-1.6 1.6M5.6 10.4 4 12" /></svg
          ><span class="ask-label">Edit with a prompt</span></button
        >
        <span class="vr"></span>
      {/if}
      <button
        class="seg more"
        class:on={moreOpen}
        bind:this={moreBtn}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        use:tip={moreOpen ? null : "More: show the folder, rename"}
        onclick={() => (moreOpen = !moreOpen)}
        ><svg class="ico" viewBox="0 0 16 16" aria-hidden="true"
          ><circle cx="3.5" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="12.5" cy="8" r="1" /></svg
        ></button
      >
    </div>
  </div>
  {#if moreOpen}
    <div
      class="more-menu"
      role="menu"
      tabindex="-1"
      aria-label="More"
      bind:this={moreEl}
      use:floatMenu={{ anchor: moreBtn, align: "right" }}
      onkeydown={moreKeys}
    >
      <button type="button" class="it" role="menuitem" onclick={() => pickMore(() => void showFolder())}>Show the folder</button>
      {#if canRename}
        <button type="button" class="it" role="menuitem" onclick={() => pickMore(startRename)}
          >Rename… <span class="hint">or click the name</span></button
        >
      {/if}
    </div>
  {/if}

  <div class="body" class:editing={noteEditUi.open && !!open && !media}>
  <div class="main" bind:this={mainEl} onscrollcapture={onPaneScroll}>
  {#if editorShown}
    <NoteToolbar
      run={(cmd) => formatted?.run(cmd)}
      current={() => formatted?.editorState() ?? null}
      {markdown}
      onmarkdown={setMarkdownView}
      {canImage}
      imageWhy="Images go beside a note in the project's notes or the vault; this file takes text only"
      onimage={(f) => void addImage(f)}
    />
  {/if}
  <div class="scrolls" class:overlay style:--head-h="{overlay ? headH : 0}px">
  <!-- The document head (item 496): where the note lives, its name, who
       reads it. Over the pane's top and moved with its scroll (see the
       script), or in the flow above a PDF, an image or the review. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="head"
    bind:this={headEl}
    style:transform={overlay && shift > 0 ? `translateY(${-Math.min(shift, headH + 8)}px)` : undefined}
    onwheel={onHeadWheel}
  >
    <div class="folder">
      <span class="scope" class:vault={isVault}>{open?.scope === "knowledge" ? "knowledge" : (open?.scope ?? "project")}</span>
      {#if reviewing}<span class="proposed" use:tip={"The dream proposed a replacement; nothing is applied until you Accept it (or open it in the editor and save)"}>proposed change</span>{/if}
      {#if open && parentOf(open.name)}<span class="folder-part">{parentOf(open.name)} /</span>{/if}
      {#if !media && !reviewing}
        <span class="facts" aria-label="About this note">
          {#if listed}<span>edited {relativeTime(listed.modified)}</span>{/if}
          <span>{words} {words === 1 ? "word" : "words"}</span>
          <span class="state" class:unsaved={dirty}>{dirty ? "unsaved" : "saved"}</span>
        </span>
      {/if}
    </div>
    {#if renaming && open}
        <input
          class="rename big"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label="Rename {open.name}"
          bind:value={renameValue}
          use:focusRename
          onkeydown={renameKeys}
          onblur={() => void commitRename()}
        />
      {:else if canRename && open}
        <h1 class="name">
          <button class="rename-btn" use:tip={"Click to rename"} aria-label="Rename {open.name}" onclick={startRename}
            >{nameParts.stem}<span class="ext">{nameParts.ext}</span></button
          >
        </h1>
      {:else}
        <h1 class="name"><span class="fixed">{open ? nameParts.stem : "no note"}<span class="ext">{nameParts.ext}</span></span></h1>
      {/if}
    <!-- Who reads this (the old footer). One line; the long texts for the
         instructions, memory, a model's file and a file that is not text
         keep their whole a click away (drawback 3). -->
    <div class="who" class:open={whoOpen}>
      <span class="who-text">
        {#if whoScope === "instructions"}
          Standing instructions for <strong>{app.project?.name ?? "this project"}</strong> — read <em>whole</em> into every chat's system prompt.
          {#if whoOpen}
            Keep it short and specific; anything that is only sometimes relevant belongs in a note, which the model reads on demand. Saving re-connects the open chat.
          {/if}
        {:else if whoScope === "memory"}
          How you want the model to behave, in every project and in chats with no project — read <em>whole</em> into every chat's system prompt.
          {#if whoOpen}
            Keep it short; facts and decisions worth keeping belong in the knowledge base, which the model reads on demand. Saving re-connects the open chat.
          {/if}
        {:else if whoScope === "models"}
          Instructions for <strong>{modelId}</strong> and no other model, in every project — read <em>whole</em> into that model's chats.
          {#if whoOpen}
            It goes into the system prompt after your memory and before the project's instructions — for what you want of this model in particular; what applies to every model belongs in Memory. An empty file is the same as none. Saving re-connects the open chat.
          {/if}
        {:else if whoScope === "media"}
          {isVault ? "Yours, across every project" : `Shared with every chat in ${app.project?.name ?? "this project"}`} — this file isn't text: the model sees its name, kind and size.
          {#if whoOpen}
            Never its contents in the system prompt; it reads the file with a tool that takes its kind (a PDF by page range).
          {/if}
        {:else if isVault}
          Yours, across every project — the model sees the name and first line, and reads the rest at <code>@kb/{open?.name ?? ""}</code>.
        {:else}
          Shared with every chat in <strong>{app.project?.name ?? "this project"}</strong> — the model sees the name and first line, and reads the rest when it needs to.
        {/if}
      </span>
      {#if whoLong}
        <button class="who-more" aria-expanded={whoOpen} onclick={toggleWho}>{whoOpen ? "Less" : "More"}</button>
      {/if}
    </div>
    <hr />
  </div>
  {#if error}
    <p class="err">{error}</p>
  {:else if loading}
    <p class="err quiet">Reading…</p>
  {:else if media}
    <NoteMedia file={media} name={open?.name ?? ""} />
  {:else if streamed || marks}
    <!-- A rewrite streaming in, or one that just landed with its changed
         lines marked (backlog 151). Read-only; a click or a key goes back
         to the editor, which already holds the landed text. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="pane stream"
      class:live={!!streamed}
      class:jumped
      bind:this={streamPane}
      onclick={() => {
        if (!streamed) clearMarks();
      }}
    >
      {#each (streamed ?? marks)?.lines ?? [] as line, i (i)}
        <div class="ln" class:mark={(streamed ?? marks)?.marked.has(i)}>{line || " "}</div>
      {/each}
      {#if streamed}<div class="ln"><span class="caret">▍</span> editing — {streaming?.edits ?? 0} edit{streaming?.edits === 1 ? "" : "s"} so far</div>{/if}
    </div>
  {:else if reviewing}
    <!-- The proposal: why, the diff with its proposed side editable, four
         ways out. The editor and its buffer are behind this, untouched,
         until Accept or Open in the editor (backlog 184). -->
    <div class="review" class:flash={reviewFlash} bind:this={reviewEl}>
      <div class="why">
        <span class="label">why</span>
        <p>{reviewing.entry.proposal.why}</p>
        <span class="when">
          proposed by the dream · {exactTime(reviewing.entry.proposal.at)}
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
  {:else}
    {#key `${bufferKey}#${jump}`}
      <NoteEditor
        bind:this={formatted}
        bind:value={text}
        {caret}
        {markdown}
        {imageSource}
        placeholder={isVault
          ? "Yours, and readable from every project. Link another note with [[name]]."
          : isModel
            ? `How you want ${modelId} in particular to behave. Empty means no file.`
            : "Anything here is read by every chat in this project."}
        oncaret={(o) => (caret = o)}
        onfollow={(t) => void follow(t)}
      />
    {/key}
  {/if}

  </div>

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
  <!-- Save / Revert while there is a draft (item 496); ⌘S unchanged. The
       panes pad under it, so it never covers the last lines. -->
  {#if dirty && !media}
    <div class="draftpill" class:above-actions={!!reviewing && !streamed && !marks} role="group" aria-label="Unsaved draft">
      <span class="d" use:tip={"Unsaved changes — kept as a draft until you save or revert"}>Unsaved draft</span>
      <button
        class="revert"
        use:tip={"Discard the draft and go back to the last saved version"}
        onclick={revert}>Revert</button
      >
      <button class="save" use:tip={{ text: "Save the note", keys: "⌘S" }} onclick={() => void commit()}>Save <span class="kbd">⌘S</span></button>
    </div>
  {/if}
  </div>
  {#if noteEditUi.open && open && !media}
    <NoteEditPanel
      scope={open.scope}
      name={open.name}
      {text}
      blocked={editBlocked}
      proposalOpen={!!reviewing}
      onShowBlock={showProposal}
      onJump={showLine}
    />
  {/if}
  </div>
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
  /* A phone-narrow window: the edit panel takes the width (backlog 345);
     the note is a click on its × away. */
  @media (max-width: 640px) {
    .body.editing > .main {
      display: none;
    }
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
  /* A line jumped to from the edit panel (backlog 345). */
  .stream.jumped .ln.mark {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  @media (prefers-reduced-motion: no-preference) {
    .stream.jumped .ln.mark {
      animation: jump-flash 1.6s ease-out;
    }
  }
  @keyframes jump-flash {
    0%,
    20% {
      background: color-mix(in srgb, var(--accent) 38%, transparent);
    }
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
  /* Item 496 (option 2): the row over the page — back at the left, the
     tool cluster at the right, no bar under them. */
  .toprow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.9rem 0.2rem 1rem;
    background: var(--bg);
    flex-shrink: 0;
    min-width: 0;
  }
  .ico {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }
  .more .ico circle {
    fill: currentColor;
    stroke: none;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: transparent;
    border: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.78rem;
    padding: 0.25rem 0.4rem;
    cursor: pointer;
    border-radius: 6px;
    flex-shrink: 0;
  }
  .back:hover {
    color: var(--text);
    background: var(--well);
  }
  .tools {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: var(--sheet);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 3px;
    min-width: 0;
    flex-shrink: 1;
  }
  .seg {
    border: 0;
    background: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.74rem;
    padding: 0.3rem 0.62rem;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    gap: 0.38rem;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .seg:hover:not(:disabled) {
    color: var(--text);
  }
  .seg.on {
    background: var(--well);
    color: var(--ink);
  }
  .seg:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .seg.ask {
    color: var(--ink2);
  }
  .seg.ask .spark {
    color: var(--accent);
  }
  .seg.ask.on {
    color: var(--accent);
  }
  .seg.more {
    padding: 0.3rem 0.45rem;
  }
  .vr {
    width: 1px;
    height: 18px;
    background: var(--line);
    margin: 0 3px;
    flex-shrink: 0;
  }
  /* A narrow note column (a 700 px window with the prompt panel open):
     Edit with a prompt keeps its spark and its name in the tooltip. */
  @container note (max-width: 560px) {
    .ask-label {
      display: none;
    }
  }
  .more-menu {
    position: fixed;
    z-index: 60;
    min-width: 13rem;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 10px;
    padding: 5px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
  }
  .more-menu .it {
    text-align: left;
    background: none;
    border: 0;
    border-radius: 6px;
    color: var(--ink2);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.45rem 0.6rem;
    cursor: pointer;
  }
  .more-menu .it:hover,
  .more-menu .it:focus-visible {
    background: var(--well);
    color: var(--ink);
    outline: none;
  }
  .more-menu .hint {
    color: var(--dim);
    font-size: 0.72rem;
    margin-left: 0.3rem;
  }

  /* The text's column: its side padding, shared by the head and every pane
     so the name, the who line and the first line of text start together. */
  .note {
    container: note / inline-size;
  }
  .scrolls {
    --pad: clamp(1.2rem, 4.5cqi, 2.6rem);
    --pill-room: 4.75rem;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
    overflow: hidden;
    background: var(--bg);
  }
  .head {
    flex-shrink: 0;
    max-width: calc(48rem + 2 * var(--pad));
    padding: 0.9rem var(--pad) 0;
    box-sizing: border-box;
    background: var(--bg);
  }
  /* Over the pane's top, moved with its scroll (the script). */
  .overlay > .head {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2;
    background: transparent;
    will-change: transform;
  }
  .head .folder {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-family: var(--mono);
    font-size: 0.74rem;
    color: var(--dim);
    min-width: 0;
  }
  .head hr {
    border: 0;
    border-top: 1px solid var(--line);
    margin: 0.9rem 0 0;
  }
  .name {
    font-family: var(--serif);
    font-weight: 500;
    font-size: clamp(1.55rem, 4.2cqi, 2.1rem);
    line-height: 1.15;
    margin: 0.35rem 0 0.4rem -0.4rem;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .name .rename-btn,
  .name .fixed {
    font: inherit;
    color: inherit;
    padding: 0.05rem 0.4rem;
    display: inline-block;
    text-align: left;
    max-width: 100%;
  }
  .name .ext {
    color: var(--dim);
    font-size: 0.62em;
  }
  .who {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.76rem;
    color: var(--dim);
    line-height: 1.5;
    min-width: 0;
  }
  .who-text {
    min-width: 0;
  }
  /* The long texts, folded: one line, cut with an ellipsis; More opens it. */
  .who:has(.who-more):not(.open) .who-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .who strong {
    color: var(--ink2);
    font-weight: 500;
  }
  .who code {
    font-family: var(--mono);
  }
  .who-more {
    flex-shrink: 0;
    background: none;
    border: 0;
    padding: 0;
    font-family: inherit;
    font-size: 0.74rem;
    color: var(--ink2);
    text-decoration: underline;
    text-decoration-color: var(--line2);
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .who-more:hover {
    color: var(--text);
  }
  /* Which store this note is in. Two of them can hold the same name, and the
     head is the only place that says which one is open. */
  .scope {
    font-family: var(--sans);
    font-size: 0.6rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--ink2);
    background: var(--well);
    border-radius: 4px;
    padding: 0.12rem 0.4rem;
    flex-shrink: 0;
  }
  .scope.vault {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }
  /* Item 460: the name renames in place. */
  .rename-btn {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--text);
    cursor: text;
    min-width: 0;
  }
  .rename-btn:hover {
    border-color: var(--border);
  }
  .folder-part {
    color: var(--dim);
  }
  .rename {
    min-width: 6rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0.05rem 0.4rem;
  }
  .rename.big {
    display: block;
    box-sizing: border-box;
    width: min(100%, 30rem);
    font-family: var(--serif);
    font-weight: 500;
    font-size: clamp(1.55rem, 4.2cqi, 2.1rem);
    line-height: 1.15;
    margin: 0.35rem 0 0.4rem -0.4rem;
  }
  .rename:focus {
    outline: none;
  }
  /* The review's marker, in the scope chip's shape. */
  .proposed {
    font-family: var(--sans);
    font-size: 0.6rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 0.06rem 0.35rem;
    flex-shrink: 0;
  }
  /* Save and Revert, only while there is a draft (item 496). */
  .main {
    position: relative;
  }
  .draftpill {
    position: absolute;
    right: 1.3rem;
    bottom: 1.2rem;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 12px;
    padding: 0.42rem 0.5rem 0.42rem 0.85rem;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
    font-size: 0.76rem;
    color: var(--ink2);
  }
  /* In the review, above its row of actions. */
  .draftpill.above-actions {
    bottom: 3.6rem;
  }
  .draftpill .d {
    display: inline-flex;
    align-items: center;
    gap: 0.38rem;
    color: var(--accent);
    white-space: nowrap;
  }
  .draftpill .d::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .draftpill .revert {
    border: 0;
    background: none;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 0.3rem 0.4rem;
    border-radius: 6px;
    cursor: pointer;
  }
  /* Revert discards typing (his call, 2026-09-14: the draft is the safety
     net, not a confirmation): red on hover says so. */
  .draftpill .revert:hover {
    color: var(--failed);
    background: color-mix(in srgb, var(--failed) 12%, transparent);
  }
  .draftpill .save {
    border: 0;
    background: var(--accent);
    color: var(--paper);
    font-family: inherit;
    font-weight: 600;
    font-size: 0.76rem;
    padding: 0.36rem 0.8rem;
    border-radius: 8px;
    display: inline-flex;
    gap: 0.45rem;
    align-items: center;
    cursor: pointer;
    white-space: nowrap;
  }
  .draftpill .save:hover {
    background: color-mix(in srgb, var(--accent) 85%, white);
  }
  .draftpill .kbd {
    font-size: 0.66rem;
    border: 1px solid color-mix(in srgb, var(--paper) 40%, transparent);
    border-radius: 4px;
    padding: 0 0.25rem;
  }
  .review {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    outline: 2px solid transparent;
    outline-offset: -2px;
    transition: outline-color 0.3s;
  }
  .review.flash {
    outline-color: var(--accent);
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
  .ghost {
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
  .ghost:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--dim);
  }
  /* Dismiss in the review: a red outline, as Revert had. */
  .ghost.revert {
    color: var(--failed);
    border-color: #7a3d3f;
  }
  .ghost.revert:hover:not(:disabled) {
    color: var(--failed);
    border-color: var(--failed);
  }
  .ghost:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .pane {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin: 0;
    position: relative;
    box-sizing: border-box;
    padding: calc(var(--head-h, 0px) + 1rem) var(--pad, 1.2rem) var(--pill-room, 1rem);
    background: var(--bg);
    color: var(--text);
  }
  /* The formatted editor: the same room above (the head) and below (the
     pill) as the other panes, and the same side padding. */
  .scrolls :global(.cm-content) {
    padding: calc(var(--head-h, 0px) + 1rem) var(--pad, 1.2rem) var(--pill-room, 1rem) !important;
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

  /* ---- Filament IV (item 565, stage 8; f4-notes.png) ----
     Look only, behind the layout gate; Classic keeps the rules above. Gated
     CSS, not a Classic copy: this view holds the note being typed, and an
     unmount on a layout switch must never touch it. */
  .facts {
    display: none;
  }
  :global(:where(:root:not([data-layout="classic"]))) .facts {
    display: inline-flex;
    gap: 0.9rem;
    margin-left: 0.4rem;
    font-variant-numeric: tabular-nums;
  }
  :global(:where(:root:not([data-layout="classic"]))) .facts .state {
    color: var(--signal);
  }
  :global(:where(:root:not([data-layout="classic"]))) .facts .state.unsaved {
    color: var(--accent);
  }
  :global(:where(:root:not([data-layout="classic"]))) .toprow {
    background: var(--paper);
  }
  :global(:where(:root:not([data-layout="classic"]))) .tools {
    background: var(--raised);
    border-color: var(--line2);
    border-radius: var(--r2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .seg {
    border-radius: var(--r1);
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ink2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .seg.on {
    background: var(--well);
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .back {
    font-size: 12.5px;
    border-radius: var(--r1);
  }
  :global(:where(:root:not([data-layout="classic"]))) .scrolls,
  :global(:where(:root:not([data-layout="classic"]))) .head {
    background: var(--paper);
  }
  :global(:where(:root:not([data-layout="classic"]))) .overlay > .head {
    background: transparent;
  }
  :global(:where(:root:not([data-layout="classic"]))) .head .folder {
    font-size: 12px;
  }
  /* The title in the light reading face, as the page titles elsewhere. */
  :global(:where(:root:not([data-layout="classic"]))) .name,
  :global(:where(:root:not([data-layout="classic"]))) .rename.big {
    font-family: var(--sans);
    font-weight: 300;
    font-size: clamp(1.7rem, 4.4cqi, 2.35rem);
    letter-spacing: -0.005em;
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .name .ext {
    font-family: var(--mono);
    font-size: 0.42em;
    font-weight: 400;
  }
  :global(:where(:root:not([data-layout="classic"]))) .scope {
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    border-radius: var(--r1);
  }
  :global(:where(:root:not([data-layout="classic"]))) .proposed {
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    border-radius: var(--r1);
  }
  :global(:where(:root:not([data-layout="classic"]))) .head hr {
    border-top-color: var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .who {
    font-size: 12.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .more-menu {
    background: var(--raised);
    border-radius: var(--r2);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  }
  :global(:where(:root:not([data-layout="classic"]))) .more-menu .it {
    min-height: 30px;
    border-radius: var(--r1);
    color: var(--ink);
    font-size: 13px;
  }
  /* Links, both directions: ruled capital labels, chips in the control
     grammar. */
  :global(:where(:root:not([data-layout="classic"]))) .links {
    background: var(--sheet);
    border-top-color: var(--line);
    padding: 0.5rem clamp(1.2rem, 4.5cqi, 2.6rem);
  }
  :global(:where(:root:not([data-layout="classic"]))) .label {
    font: 500 10px var(--mono);
    letter-spacing: 0.14em;
    color: var(--ink2);
    opacity: 1;
    margin-right: 0.4rem;
  }
  :global(:where(:root:not([data-layout="classic"]))) .chip {
    min-height: 24px;
    border: 1px solid var(--line2);
    border-radius: var(--r1);
    background: var(--well);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 12px;
    padding: 0.1rem 0.55rem;
  }
  :global(:where(:root:not([data-layout="classic"]))) .chip:hover {
    background: var(--well2);
    border-color: var(--accent);
    color: var(--ink);
  }
  :global(:where(:root:not([data-layout="classic"]))) .chip.broken {
    background: transparent;
    border-style: dashed;
    color: var(--dim);
  }
  /* The draft's Save and Revert: a card in front; Save the one amber block. */
  :global(:where(:root:not([data-layout="classic"]))) .draftpill {
    background: var(--raised);
    border-radius: var(--r2);
    font-size: 12.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .draftpill .save {
    min-height: 28px;
    border-radius: var(--r1);
    font-size: 12.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .draftpill .revert {
    border-radius: var(--r1);
    font-size: 12.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .why,
  :global(:where(:root:not([data-layout="classic"]))) .actions {
    background: var(--sheet);
    border-color: var(--line);
  }
  :global(:where(:root:not([data-layout="classic"]))) .accept,
  :global(:where(:root:not([data-layout="classic"]))) .load,
  :global(:where(:root:not([data-layout="classic"]))) .ghost {
    min-height: 28px;
    border-radius: var(--r1);
    font-size: 12.5px;
  }
  :global(:where(:root:not([data-layout="classic"]))) .load,
  :global(:where(:root:not([data-layout="classic"]))) .ghost {
    background: var(--well);
    border-color: var(--line2);
  }
  :global(:where(:root:not([data-layout="classic"]))) .ghost.revert {
    border-color: color-mix(in srgb, var(--failed) 55%, var(--line2));
  }
</style>
