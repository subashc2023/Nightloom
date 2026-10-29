<script lang="ts">
  import { tip } from "./tip";
  import {
    app,
    openProjectFolder,
    deleteNote,
    revealFolder,
    reviewProposal,
    runCapture,
    runDream,
    saveNote,
    showGraph,
    startContentDrag,
    endContentDrag,
    showNote,
    stopCapture,
    stopDream,
  } from "./state.svelte";
  import type { NoteScope } from "./types";
  import { relativeTime } from "./time";
  import * as api from "./api";
  import { onMount, tick, untrack } from "svelte";
  import { projectFilesChanged, refreshNotes } from "./state.svelte";
  import { carriesFiles } from "./dropLook";
  import { acceptFiles, conversionJobs, readBase64 } from "./attachFiles.svelte";
  import { discardDraft, readDraft } from "./drafts.svelte";
  import {
    holdKeptNotices,
    keepNow,
    keepStateOf,
    keeps,
    keptNotices,
    noticeKept,
    releaseKeptNotices,
    takeKeptNotices,
  } from "./keep.svelte";
  import {
    FLASH_MS,
    HOLD_LINE,
    NOTES_TOAST_MS,
    Hold,
    centredScrollTop,
    flashPlan,
    holdTitle,
    keepDropped,
  } from "./notesDrop";
  import { foldQuery, hitsByScope, narrowNotes } from "./notesSearch";
  import { prefersReducedMotion } from "./chipFade";
  import { deleteNoteFolder, moveNoteTo, newNoteFolder } from "./state.svelte";
  import { runningTurn } from "./noteEdit.svelte";
  import { placeMenu } from "./menuPlace";
  import {
    ancestorsOf,
    baseOf,
    buildTree,
    cleanName,
    dropTarget,
    fileIcon,
    joinPath,
    loadOpen,
    openKey,
    parentOf,
    renamedOpen,
    renamedTo,
    saveOpen,
    visibleRows,
    type TreeRow,
  } from "./notesTree";

  /**
   * Two stores, one panel.
   *
   * **Project** is `<workspace>/.agents` — about the code, committable, and
   * only there while a project is open. **Knowledge** is the user's own vault
   * — about them, the same one in every project, and present with no project
   * at all. That last part is the headline rather than a detail: the quickest
   * thing this app does is a chat with no folder, and until now that chat had
   * no notes of any kind.
   *
   * They are sections of one panel rather than a third sidebar tab because
   * the question "where did I write that down" has two answers and a user
   * should be able to see both without choosing first.
   */

  /** Which section is being created in, or null when nothing is. */
  let creating = $state<NoteScope | null>(null);
  let draftName = $state("");
  let confirming = $state<string | null>(null);
  /** Sections start open; collapsing is per-session and deliberately not
   *  persisted — it is a glance, not a preference. */
  let collapsed = $state<Record<"project" | "knowledge", boolean>>({
    project: false,
    knowledge: false,
  });

  /**
   * The always-loaded file at the head of each section — `AGENTS.md` in the
   * workspace (instructions) and in `~/.nightloom` (memory). Read whole into
   * every chat's preamble, so unlike the notes below it there is no index to
   * show; the row carries its size, or "empty" when the file does not exist
   * yet. Re-read whenever the lists refresh, which `saveNote` does after a
   * save and the turn loop does after every turn.
   */
  const AGENTS_MD = "AGENTS.md";
  let fixed = $state<Record<"instructions" | "memory", number | null>>({
    instructions: null,
    memory: null,
  });
  $effect(() => {
    // Dependencies the effect should re-run on, read up front.
    const projectId = app.project?.id ?? null;
    void app.notes;
    void app.vault;
    void (async () => {
      fixed.instructions = projectId
        ? await api.readNote("instructions", AGENTS_MD).then(
            (t) => t.length,
            () => null,
          )
        : null;
      fixed.memory = app.knowledge
        ? await api.readNote("memory", AGENTS_MD).then(
            (t) => t.length,
            () => null,
          )
        : null;
    })();
  });

  /**
   * Item 415: the search box. Names are matched here as he types; text by
   * the backend's note search, a moment after the typing pauses, its
   * answer used only while the box still holds the query it was asked.
   * The lists it narrows are re-searched when they change.
   */
  let query = $state("");
  let textHits = $state<{
    q: string;
    project: Set<string>;
    knowledge: Set<string>;
  } | null>(null);
  let searchSeq = 0;
  const searching = $derived(foldQuery(query) !== "");
  $effect(() => {
    const q = query.trim();
    void app.notes;
    void app.vault;
    const mine = ++searchSeq;
    if (!foldQuery(q)) {
      textHits = null;
      return;
    }
    const t = setTimeout(() => {
      api.searchEverywhere(q, "notes").then(
        (r) => {
          if (mine === searchSeq) textHits = { q, ...hitsByScope(r.notes) };
        },
        () => {},
      );
    }, 120);
    return () => clearTimeout(t);
  });
  function hitsFor(scope: "project" | "knowledge"): Set<string> | null {
    return textHits && textHits.q === query.trim() ? textHits[scope] : null;
  }
  const shownProject = $derived(narrowNotes(app.notes, query, hitsFor("project")));
  const shownVault = $derived(narrowNotes(app.vault, query, hitsFor("knowledge")));
  /** A section collapsed by hand opens while a search runs: the matches
   *  are what the box is for. */
  const shut = (scope: "project" | "knowledge") => collapsed[scope] && !searching;
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      query = "";
    }
  }

  /**
   * Item 416: after a keep (a drop here, or a chat chip's Keep), scroll
   * the kept file's row to the middle of the list and flash it — the
   * existing row when the file was already there. A search hiding it is
   * cleared first. Reduced motion: a jump and a still highlight.
   */
  let panelEl = $state<HTMLDivElement | null>(null);
  let flashing = $state<Set<string>>(new Set());
  let flashSeq = 0;
  $effect(() => {
    void keptNotices.seq;
    untrack(() => void reveal());
  });
  async function reveal() {
    const notices = takeKeptNotices();
    if (notices.length === 0) return;
    const plan = flashPlan(
      notices,
      app.notes.map((n) => n.name),
      performance.now(),
    );
    if (!plan.scrollTo) return;
    query = "";
    textHits = null;
    collapsed.project = false;
    // Item 457: a kept file inside a closed folder has no row to flash
    // until its folders open.
    openAncestors("project", plan.scrollTo);
    await tick();
    const box = panelEl;
    const row = box?.querySelector<HTMLElement>(
      `[data-note="${CSS.escape(`project:${plan.scrollTo}`)}"]`,
    );
    if (!box || !row) return;
    const reduced = prefersReducedMotion();
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    box.scrollTo({
      top: centredScrollTop(box.scrollTop, r.top - b.top, r.height, box.clientHeight, box.scrollHeight),
      behavior: reduced ? "auto" : "smooth",
    });
    // Off, then on a frame later: a row still flashing from a keep a
    // moment ago starts its flash again. A timeout, not a frame callback,
    // which a window in the background never runs.
    const mine = ++flashSeq;
    flashing = new Set();
    await tick();
    setTimeout(() => {
      if (mine !== flashSeq) return;
      flashing = new Set(plan.flash.map((n) => `project:${n}`));
      setTimeout(() => mine === flashSeq && (flashing = new Set()), FLASH_MS + 150);
    }, 20);
  }

  function begin(scope: "project" | "knowledge") {
    creating = scope;
    draftName = "";
    collapsed[scope] = false;
  }

  /**
   * Create the note and open it. `.md` is appended when the name has no
   * extension — both stores are markdown by convention and a note called
   * `decisions` should not become an extensionless file nobody's editor knows
   * what to do with.
   */
  async function create(scope: NoteScope) {
    const name = draftName.trim();
    creating = null;
    if (!name) return;
    const full = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`;
    if (await saveNote(scope, full, "")) showNote(scope, full);
  }

  /** Keyed by scope as well as name: the two stores can hold `plan.md` each,
   *  and a bare name would arm both delete buttons at once. */
  function onDelete(scope: NoteScope, name: string) {
    const key = `${scope}:${name}`;
    if (confirming !== key) {
      confirming = key;
      return;
    }
    confirming = null;
    void deleteNote(scope, name);
  }

  function isOpen(scope: NoteScope, name: string): boolean {
    return (
      app.view === "note" &&
      app.openNote?.scope === scope &&
      app.openNote.name === name
    );
  }

  /**
   * Item 391: files dropped on the Project section are kept in the
   * project, as attaching them and pressing Keep would (`notesDrop.ts`).
   * The section carries `data-drop-none`, so the window's drop watcher
   * (`dropLook.svelte.ts`) never takes this drop for a chat's box.
   */
  const hold = new Hold();
  let held = $state(false);
  let keeping = $state(0);
  const sync = () => (held = hold.held(performance.now()));

  /*
   * Item 428 (his bug, 2026-10-27: "it like did nothing both times"): a
   * drop's words — kept, already there, refused — and "Keeping…" while an
   * office file converts, held at the panel's foot where he is looking.
   * The window's toasts sit at the far corner of the chat pane, a thousand
   * pixels from the panel, and came only after the conversion.
   */
  let dropToasts = $state<{ id: number; text: string }[]>([]);
  let dropToastSeq = 0;
  function dismissDropToast(id: number) {
    dropToasts = dropToasts.filter((t) => t.id !== id);
  }
  function notesToast(text: string) {
    const id = ++dropToastSeq;
    dropToasts = [...dropToasts, { id, text }];
    setTimeout(() => dismissDropToast(id), NOTES_TOAST_MS);
  }
  onMount(() => {
    const t = setInterval(() => held && sync(), 500);
    const end = () => {
      hold.end();
      sync();
    };
    window.addEventListener("dragend", end, true);
    window.addEventListener("drop", end, true);
    return () => {
      clearInterval(t);
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("drop", end, true);
    };
  });
  function onDragEnter(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    hold.enter(performance.now());
    sync();
  }
  function onDragOver(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    hold.over(performance.now());
    sync();
  }
  function onDragLeave(e: DragEvent) {
    if (!carriesFiles(e.dataTransfer)) return;
    hold.leave();
    sync();
  }
  async function onDrop(e: DragEvent) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    hold.end();
    sync();
    if (files.length === 0) return;
    e.preventDefault();
    keeping += files.length;
    holdKeptNotices();
    try {
      await keepDropped(files, {
        project: () => app.project,
        toast: notesToast,
        attach: acceptFiles,
        jobs: conversionJobs,
        chips: (k) => readDraft(k).attachments,
        state: keepStateOf,
        forget: (k) => delete keeps[k],
        keep: (k, name, mediaType, from, source) => keepNow(k, name, mediaType, from, { source, toast: notesToast }),
        discard: (k) => discardDraft(k),
        // Item 414: a zip is unpacked into files/<its name>/.
        zip: {
          read: readBase64,
          unpack: api.unpackZip,
          keepAt: (name, mediaType, data, dir) => api.keepAttachment(name, mediaType, { data }, dir),
          kept: async (rels, anyNew) => {
            if (anyNew) projectFilesChanged();
            await refreshNotes().catch(() => {});
            for (const rel of rels) noticeKept(rel);
          },
        },
      });
    } finally {
      keeping -= files.length;
      releaseKeptNotices();
    }
  }

  // ---- item 457: the panel as a file manager ----
  //
  // Folder rows open and close (remembered per section, the project's per
  // project); a note dragged onto a folder moves there; a right-click gives
  // Rename, Move to…, New note / New folder here and Delete. Every move
  // goes through `moveNoteTo`, which carries tabs and drafts along.

  type Sec = "project" | "knowledge";
  const storage = () => (typeof localStorage === "undefined" ? null : localStorage);
  const keyOf = (scope: Sec) => openKey(scope, scope === "project" ? (app.project?.id ?? null) : null);
  let openFolders = $state<Record<Sec, Set<string>>>({
    project: new Set(),
    knowledge: loadOpen(storage(), openKey("knowledge", null)),
  });
  $effect(() => {
    const id = app.project?.id ?? null;
    untrack(() => (openFolders.project = loadOpen(storage(), openKey("project", id))));
  });
  function setOpen(scope: Sec, next: Set<string>) {
    openFolders[scope] = next;
    saveOpen(storage(), keyOf(scope), next);
  }
  function toggleFolder(scope: Sec, path: string) {
    const next = new Set(openFolders[scope]);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(scope, next);
  }
  function openAncestors(scope: Sec, name: string, self = false) {
    const want = self ? [...ancestorsOf(name), name] : ancestorsOf(name);
    if (want.every((a) => openFolders[scope].has(a))) return;
    setOpen(scope, new Set([...openFolders[scope], ...want]));
  }
  // The note open in the editor has its row on screen: opened from a
  // search, the graph or a link, its folders open.
  $effect(() => {
    const o = app.openNote;
    if (!o || (o.scope !== "project" && o.scope !== "knowledge")) return;
    const scope = o.scope;
    untrack(() => openAncestors(scope, o.name));
  });

  const projectRows = $derived(
    visibleRows(buildTree(shownProject, searching ? [] : app.noteFolders.project), openFolders.project, searching),
  );
  const vaultRows = $derived(
    visibleRows(buildTree(shownVault, searching ? [] : app.noteFolders.knowledge), openFolders.knowledge, searching),
  );
  /** Every folder in a section, listed or implied by a note's path. */
  function foldersOf(scope: Sec): string[] {
    const all = new Set(app.noteFolders[scope]);
    for (const n of scope === "project" ? app.notes : app.vault) for (const a of ancestorsOf(n.name)) all.add(a);
    return [...all].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  const busy = (key: string) => runningTurn(key) !== null;

  async function move(scope: Sec, from: string, to: string, isFolder: boolean) {
    const landed = await moveNoteTo(scope, from, to, busy);
    if (landed === null || landed === from) return;
    if (isFolder) setOpen(scope, renamedOpen(openFolders[scope], from, landed));
    openAncestors(scope, landed);
  }

  /** The inline name box: a rename of a row, or a new note or folder in
   *  `path` (a folder; `""` for the top level). */
  let editing = $state<{ scope: Sec; what: "rename" | "note" | "folder"; path: string; isFolder: boolean } | null>(null);
  let editValue = $state("");
  function startEdit(scope: Sec, what: "rename" | "note" | "folder", path: string, isFolder = false) {
    menu = null;
    collapsed[scope] = false;
    if (what !== "rename" && path) openAncestors(scope, path, true);
    else if (what === "rename") openAncestors(scope, path);
    editValue = what === "rename" ? baseOf(path) : "";
    editing = { scope, what, path, isFolder };
  }
  async function commitEdit() {
    const e = editing;
    if (!e) return;
    editing = null;
    const typed = cleanName(editValue);
    if (!typed) return;
    if (e.what === "rename") {
      // A note keeps its extension when he types a bare name.
      const to = renamedTo(e.path, typed, e.isFolder);
      if (to) await move(e.scope, e.path, to, e.isFolder);
    } else if (e.what === "folder") {
      const made = await newNoteFolder(e.scope, joinPath(e.path, typed));
      if (made) openAncestors(e.scope, made);
    } else {
      const full = /\.[a-z0-9]+$/i.test(typed) ? typed : `${typed}.md`;
      const name = joinPath(e.path, full);
      if (await saveNote(e.scope, name, "")) showNote(e.scope, name);
    }
  }
  function editKeys(ev: KeyboardEvent) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void commitEdit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      editing = null;
    }
  }
  function focusEdit(el: HTMLInputElement) {
    el.focus();
    // The name, not its extension, selected — as Finder does.
    const dot = el.value.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 && editing && !editing.isFolder ? dot : el.value.length);
  }

  /** The right-click menu on a row. */
  let menu = $state<{
    scope: Sec;
    path: string;
    isFolder: boolean;
    count: number;
    x: number;
    y: number;
    page: "main" | "move";
    confirm: boolean;
    filter: string;
  } | null>(null);
  function openMenu(e: MouseEvent, scope: Sec, path: string, isFolder: boolean, count = 0) {
    e.preventDefault();
    e.stopPropagation();
    confirming = null;
    menu = { scope, path, isFolder, count, x: e.clientX, y: e.clientY, page: "main", confirm: false, filter: "" };
  }
  function placeAt(el: HTMLElement, at: { x: number; y: number }) {
    const place = () => {
      const p = placeMenu(
        { x: at.x, below: at.y, above: at.y },
        { w: el.offsetWidth, h: el.scrollHeight + (el.offsetHeight - el.clientHeight) },
        { w: window.innerWidth, h: window.innerHeight },
      );
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
      el.style.maxHeight = p.maxHeight === undefined ? "" : `${p.maxHeight}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return { destroy: () => ro.disconnect() };
  }
  /** Where Move to… can send the menu's row: the top level and every
   *  folder, less the one it is in and (a folder) itself and its own. */
  const moveChoices = $derived.by(() => {
    const m = menu;
    if (!m || m.page !== "move") return [];
    const q = m.filter.trim().toLowerCase();
    return ["", ...foldersOf(m.scope)].filter(
      (f) => dropTarget(m.path, f) !== null && (!q || (f || "top level").toLowerCase().includes(q)),
    );
  });
  async function menuMoveTo(folder: string) {
    const m = menu;
    menu = null;
    if (!m) return;
    const to = dropTarget(m.path, folder);
    if (to) await move(m.scope, m.path, to, m.isFolder);
  }
  async function menuDelete() {
    const m = menu;
    if (!m) return;
    if (!m.confirm) {
      m.confirm = true;
      return;
    }
    menu = null;
    if (m.isFolder) await deleteNoteFolder(m.scope, m.path);
    else await deleteNote(m.scope, m.path);
  }
  function menuKeys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      menu = null;
    }
  }

  /** A row being dragged inside the panel, for the folders it may land on. */
  let dragging = $state<{ scope: Sec; path: string; isFolder: boolean } | null>(null);
  let dropOn = $state<string | null>(null);
  let springTimer: ReturnType<typeof setTimeout> | null = null;
  const FOLDER_DRAG = "application/x-nightloom-note-folder";
  function clearSpring() {
    if (springTimer !== null) clearTimeout(springTimer);
    springTimer = null;
  }
  function endRowDrag() {
    dragging = null;
    dropOn = null;
    clearSpring();
  }
  function onNoteDragStart(e: DragEvent, scope: Sec, name: string) {
    startContentDrag(e, { kind: "note", scope, name });
    // Copy for a tab strip (a tab of it), move for a folder here.
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
    dragging = { scope, path: name, isFolder: false };
  }
  function onFolderDragStart(e: DragEvent, scope: Sec, path: string) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(FOLDER_DRAG, path);
    e.dataTransfer.effectAllowed = "move";
    dragging = { scope, path, isFolder: true };
  }
  /** `folder` is `""` for the section's head: the top level. */
  function canDrop(scope: Sec, folder: string): boolean {
    const d = dragging;
    return !!d && d.scope === scope && dropTarget(d.path, folder) !== null;
  }
  function onFolderDragOver(e: DragEvent, scope: Sec, folder: string, isOpen = true) {
    if (!canDrop(scope, folder)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const key = `${scope}:${folder}`;
    if (dropOn !== key) {
      dropOn = key;
      clearSpring();
      // Held over a closed folder for a moment, it opens — so a note can
      // be dropped into a folder inside it.
      if (!isOpen && folder) springTimer = setTimeout(() => openAncestors(scope, folder, true), 700);
    }
  }
  function onFolderDragLeave(scope: Sec, folder: string) {
    if (dropOn === `${scope}:${folder}`) {
      dropOn = null;
      clearSpring();
    }
  }
  async function onFolderDrop(e: DragEvent, scope: Sec, folder: string) {
    const d = dragging;
    if (!d || !canDrop(scope, folder)) return;
    e.preventDefault();
    e.stopPropagation();
    endRowDrag();
    endContentDrag();
    const to = dropTarget(d.path, folder);
    if (to) await move(scope, d.path, to, d.isFolder);
  }

  function size(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }
</script>

{#snippet pinned(scope: "instructions" | "memory", label: string, hint: string)}
  <!-- No delete button: the never-lose-work rule, and the backend refuses
       it anyway — emptying the text is the reversible form. The badge is
       the dream's pending proposal for the file (a sibling of the row, not
       inside it — a button in a button is not HTML); it opens the same
       editor in proposal mode, and nothing is applied until Load and Save. -->
  <div class="item pinned" class:active={isOpen(scope, AGENTS_MD)}>
    <button class="row" onclick={() => showNote(scope, AGENTS_MD)} use:tip={hint}>
      <span class="name">{label}</span>
      <span class="summary">{hint}</span>
      <span class="meta">
        {AGENTS_MD} ·
        {fixed[scope] === null
          ? "empty"
          : fixed[scope] === 0
            ? "empty"
            : size(fixed[scope] ?? 0)}
      </span>
    </button>
    {#if app.proposals[scope].length > 0}
      <button
        class="proposed"
        use:tip={"The dream proposed a change to this file — review it as a diff"}
        aria-label="Review the proposed change to {label}"
        onclick={() => reviewProposal(scope)}
        >{app.proposals[scope].length} proposed</button
      >
    {/if}
  </div>
{/snippet}

{#snippet fileGlyph(kind: ReturnType<typeof fileIcon>)}
  <!-- Item 457: what a row is at a glance — a folder, or a file of a kind. -->
  <svg class="glyph file {kind}" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 1.5h5.2L12.5 4.8V14a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5Z" fill="none" stroke="currentColor" stroke-width="1.1" />
    <path d="M9 1.7V5h3.3" fill="none" stroke="currentColor" stroke-width="1.1" />
    {#if kind === "text"}
      <path d="M5.6 8h4.8M5.6 10h4.8M5.6 12h3" stroke="currentColor" stroke-width="1" />
    {:else if kind === "pdf"}
      <rect x="4.6" y="8.6" width="6.8" height="3.6" rx=".6" fill="currentColor" opacity=".85" />
    {:else if kind === "image"}
      <path d="M5 12.4l2-2.6 1.4 1.6 1-1.2 1.6 2.2Z" fill="currentColor" /><circle cx="6.4" cy="7.8" r=".9" fill="currentColor" />
    {:else if kind === "deck"}
      <rect x="5" y="7.6" width="6" height="4" rx=".4" fill="none" stroke="currentColor" stroke-width="1" />
    {:else if kind === "sheet"}
      <path d="M5 8h6v4.4H5ZM5 10.2h6M8 8v4.4" fill="none" stroke="currentColor" stroke-width=".9" />
    {/if}
  </svg>
{/snippet}

{#snippet folderGlyph(open: boolean)}
  <svg class="glyph dir" class:open viewBox="0 0 16 16" aria-hidden="true">
    {#if open}
      <path d="M1.8 4V12.6c0 .3.2.5.5.5h10.2l2-6H4.4L2.4 13" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
      <path d="M1.8 4.2c0-.3.2-.5.5-.5h3.3l1.3 1.3h5.3c.3 0 .5.2.5.5v1.6" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
    {:else}
      <path d="M1.8 3.7h3.8l1.3 1.3h6.8c.3 0 .5.2.5.5v7.1c0 .3-.2.5-.5.5H2.3a.5.5 0 0 1-.5-.5Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
    {/if}
  </svg>
{/snippet}

{#snippet nameBox(depth: number, placeholder: string, folder: boolean)}
  <div class="item editing" style:--depth={depth}>
    <span class="edit-row">
      {#if folder}{@render folderGlyph(false)}{:else}{@render fileGlyph("text")}{/if}
      <input
        class="new-name inline"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        {placeholder}
        aria-label={placeholder}
        bind:value={editValue}
        use:focusEdit
        onkeydown={editKeys}
        onblur={() => void commitEdit()}
      />
    </span>
  </div>
{/snippet}

{#snippet tree(scope: Sec, rows: TreeRow[])}
  <div class="list" role="tree" aria-label="{scope === 'project' ? 'Project' : 'Knowledge'} notes">
    {#if editing && editing.scope === scope && editing.what !== "rename" && editing.path === ""}
      {@render nameBox(0, editing.what === "folder" ? "folder name" : "note name", editing.what === "folder")}
    {/if}
    {#each rows as r (r.kind === "folder" ? `d:${r.path}` : `n:${r.note.name}`)}
      {#if r.kind === "folder"}
        {#if editing && editing.scope === scope && editing.what === "rename" && editing.path === r.path}
          {@render nameBox(r.depth, "folder name", true)}
        {:else}
          <div
            class="item dir-row"
            class:drop-on={dropOn === `${scope}:${r.path}`}
            style:--depth={r.depth}
            data-folder="{scope}:{r.path}"
            role="treeitem"
            aria-selected="false"
            aria-expanded={r.open}
          >
            <button
              class="row dir"
              onclick={() => toggleFolder(scope, r.path)}
              oncontextmenu={(e) => openMenu(e, scope, r.path, true, r.count)}
              draggable={!searching}
              ondragstart={(e) => onFolderDragStart(e, scope, r.path)}
              ondragend={endRowDrag}
              ondragover={(e) => onFolderDragOver(e, scope, r.path, r.open)}
              ondragleave={() => onFolderDragLeave(scope, r.path)}
              ondrop={(e) => void onFolderDrop(e, scope, r.path)}
              use:tip={r.path}
            >
              <span class="line">
                <span class="caret" class:shut={!r.open}>▾</span>
                {@render folderGlyph(r.open)}
                <span class="name">{r.name}</span>
                <span class="n">{r.count}</span>
              </span>
            </button>
          </div>
        {/if}
        {#if editing && editing.scope === scope && editing.what !== "rename" && editing.path === r.path && r.open}
          {@render nameBox(r.depth + 1, editing.what === "folder" ? "folder name" : "note name", editing.what === "folder")}
        {/if}
      {:else if editing && editing.scope === scope && editing.what === "rename" && editing.path === r.note.name}
        {@render nameBox(r.depth, "note name", false)}
      {:else}
        {@const n = r.note}
        <div
          class="item"
          class:active={isOpen(scope, n.name)}
          class:flash={flashing.has(`${scope}:${n.name}`)}
          style:--depth={r.depth}
          data-note="{scope}:{n.name}"
          role="treeitem"
          aria-selected={isOpen(scope, n.name)}
        >
          <!-- Draggable (backlog 140 pass 2): onto a strip for a tab of
               this note at that slot, onto a pane's half to open it beside;
               onto a folder here to move it there (item 457). -->
          <button
            class="row"
            onclick={(e) => {
              // ⌘-click opens the note in a new tab (nightshift backlog
              // 099, blocker 140); a plain click replaces the active one.
              if (e.metaKey || e.ctrlKey) app.openNext = "new";
              showNote(scope, n.name);
            }}
            oncontextmenu={(e) => openMenu(e, scope, n.name, false)}
            draggable="true"
            ondragstart={(e) => onNoteDragStart(e, scope, n.name)}
            ondragend={() => {
              endContentDrag();
              endRowDrag();
            }}
            use:tip={searching && n.name.includes("/") ? n.name : undefined}
          >
            <span class="line">
              {@render fileGlyph(fileIcon(n))}
              <span class="name">{r.label}</span>
            </span>
            {#if n.summary}<span class="summary">{n.summary}</span>{/if}
            <span class="meta">{size(n.bytes)} · {relativeTime(n.modified)}</span>
          </button>
          <button
            class="delete"
            class:confirming={confirming === `${scope}:${n.name}`}
            use:tip={confirming === `${scope}:${n.name}`
              ? "Click again to delete this file"
              : "Delete note"}
            aria-label="Delete {n.name}"
            onclick={() => onDelete(scope, n.name)}
            onmouseleave={() =>
              confirming === `${scope}:${n.name}` && (confirming = null)}
          >
            {confirming === `${scope}:${n.name}` ? "sure?" : "×"}
          </button>
        </div>
      {/if}
    {/each}
  </div>
  {#if !app.notesComplete[scope]}
    <p class="hint">
      Some files are not shown: this folder goes more than 12 folders deep or
      holds more than 20,000 files. Show the folder to see them all.
    </p>
  {/if}
{/snippet}

{#snippet newRow(scope: "project" | "knowledge")}
  <div class="bar">
    {#if creating === scope}
      <!-- svelte-ignore a11y_autofocus -->
      <input autocorrect="off" autocapitalize="off" spellcheck="false"
        class="new-name"
        autofocus
        placeholder="note name"
        bind:value={draftName}
        onkeydown={(e) => {
          if (e.key === "Enter") void create(scope);
          if (e.key === "Escape") creating = null;
        }}
        onblur={() => void create(scope)}
      />
    {:else}
      <button class="add" onclick={() => begin(scope)}>New note</button>
      <button
        class="folder"
        use:tip={"New folder"}
        aria-label="New folder"
        onclick={() => startEdit(scope, "folder", "")}>{@render folderGlyph(false)}</button
      >
      {#if scope === "knowledge"}
        <!-- The Capture button is always there, unlike Dream's: the inbox
             count says nothing about what the chats hold, and the count on
             it — logs with something new since the last read — is never
             zero for long, since the chat open right now is one. -->
        {#if app.capturing}
          <button
            class="dream running"
            use:tip={"reading the chats…"}
            onclick={() => void stopCapture()}>capturing… ✕</button
          >
        {:else}
          <button
            class="dream"
            use:tip={"Read the chats since the last capture into the memory inbox"}
            disabled={app.dreaming}
            onclick={() => void runCapture()}>Capture · {app.capturePending}</button
          >
        {/if}
        <!-- The Dream button renders only with a backlog, the same rule as
             the CLI's startup line: an inbox with nothing in it needs no
             chrome, and a backlog the user cannot see is one that never
             gets consolidated. -->
        {#if app.dreaming}
          <button
            class="dream running"
            use:tip={app.dreamActivity
              ? `dreaming — ${app.dreamActivity}`
              : "dreaming…"}
            onclick={() => void stopDream()}>dreaming… ✕</button
          >
        {:else if app.dreamPending > 0}
          <button
            class="dream"
            use:tip={"Consolidate remembered observations into the vault"}
            onclick={() => void runDream()}>Dream · {app.dreamPending}</button
          >
        {/if}
        <button
          class="folder"
          use:tip={"Show the link graph — drag it onto a strip for a tab"}
          aria-label="Show the link graph"
          class:on={app.view === "graph"}
          onclick={showGraph}
          draggable="true"
          ondragstart={(e) => startContentDrag(e, { kind: "graph" })}
          ondragend={endContentDrag}>◈</button
        >
      {/if}
      <button
        class="folder"
        use:tip={"Show the folder"}
        aria-label="Show the folder"
        onclick={() =>
          void revealFolder(
            scope === "project" ? app.project?.notes_dir : app.knowledge?.dir,
          )}>↗</button
      >
    {/if}
  </div>
{/snippet}

<div class="panel" bind:this={panelEl}>
  <!-- Item 415: narrows both sections as he types; the pinned rows stay. -->
  <div class="find-bar">
    <input autocorrect="off" autocapitalize="off" spellcheck="false"
      class="find"
      type="search"
      placeholder="Search notes"
      aria-label="Search notes by name or text"
      bind:value={query}
      onkeydown={onSearchKey}
    />
  </div>
  <!-- The project's own notes. Absent rather than empty when nothing is
       open: there is no folder for them to be about. -->
  <section
    class="keep-drop"
    class:held
    role="group"
    aria-label="Project notes — drop files here to keep them in the project"
    data-drop-none
    data-notes-drop
    aria-busy={keeping > 0}
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {#if held}
      <div class="hold" aria-hidden="true">
        <div class="words">
          <b>{holdTitle(app.project)}</b>
          {#if app.project && !app.project.unfiled}<span>{HOLD_LINE}</span>{/if}
        </div>
      </div>
    {/if}
    <button
      class="head"
      class:drop-on={dropOn === "project:"}
      ondragover={(e) => onFolderDragOver(e, "project", "")}
      ondragleave={() => onFolderDragLeave("project", "")}
      ondrop={(e) => void onFolderDrop(e, "project", "")}
      onclick={() => (collapsed.project = !collapsed.project)}
      aria-expanded={!collapsed.project}
    >
      <span class="chev" class:shut={shut("project")}>▾</span>
      <span class="title">Project</span>
      {#if app.project}<span class="count"
          >{searching ? `${shownProject.length} of ${app.notes.length}` : app.notes.length}</span
        >{/if}
    </button>

    {#if !shut("project")}
      {#if !app.project}
        <div class="empty">
          <p>
            Notes about the code live in the folder, so a teammate can read
            them and a diff can review them. Open a project to get a set.
          </p>
          <button class="pick" onclick={() => void openProjectFolder()}
            >Open a folder…</button
          >
        </div>
      {:else}
        {@render pinned(
          "instructions",
          "Instructions",
          "Standing instructions for this project — read whole into every chat",
        )}
        {@render newRow("project")}
        {#if app.notes.length === 0}
          <p class="hint">
            Nothing here yet. The model writes these with the file tools, and
            the index of the folder is in its system prompt — so a task list
            left here is still there in the next chat.
          </p>
        {:else if shownProject.length === 0}
          <p class="hint no-match">No notes match</p>
        {:else}
          {@render tree("project", projectRows)}
        {/if}
      {/if}
    {/if}
  </section>

  <!-- The vault. Shown whether or not a project is open, which is the whole
       point of it being separate. -->
  <section>
    <button
      class="head"
      class:drop-on={dropOn === "knowledge:"}
      ondragover={(e) => onFolderDragOver(e, "knowledge", "")}
      ondragleave={() => onFolderDragLeave("knowledge", "")}
      ondrop={(e) => void onFolderDrop(e, "knowledge", "")}
      onclick={() => (collapsed.knowledge = !collapsed.knowledge)}
      aria-expanded={!collapsed.knowledge}
    >
      <span class="chev" class:shut={shut("knowledge")}>▾</span>
      <span class="title">Knowledge</span>
      <span class="count"
        >{searching ? `${shownVault.length} of ${app.vault.length}` : app.vault.length}</span
      >
      {#if app.knowledge}<span class="alias">{app.knowledge.alias}</span>{/if}
    </button>

    {#if !shut("knowledge")}
      {#if !app.knowledge}
        <p class="hint">
          No user config directory on this machine, so there is nowhere to keep
          a knowledge base.
        </p>
      {:else}
        {@render pinned(
          "memory",
          "Memory",
          "How you want the model to behave, everywhere — read whole into every chat",
        )}
        {@render newRow("knowledge")}
        {#if app.vault.length === 0}
          <p class="hint">
            Yours, not this folder's — the same set in every project and in a
            chat with no project at all. Worth keeping here: a decision and why
            it was made, a person, something that took real work to figure out.
            Notes link to each other with <code>[[name]]</code>.
          </p>
        {:else if shownVault.length === 0}
          <p class="hint no-match">No notes match</p>
        {:else}
          {@render tree("knowledge", vaultRows)}
        {/if}
      {/if}
    {/if}
  </section>
  {#if menu}
    {@const m = menu}
    <button class="scrim" aria-label="Close" onclick={() => (menu = null)} oncontextmenu={(e) => { e.preventDefault(); menu = null; }}></button>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="note-menu" role="menu" tabindex="-1" use:placeAt={{ x: m.x, y: m.y }} onkeydown={menuKeys}>
      {#if m.page === "main"}
        {#if !m.isFolder}
          <button role="menuitem" onclick={() => { menu = null; showNote(m.scope, m.path); }}>Open</button>
          <button role="menuitem" onclick={() => { menu = null; app.openNext = "new"; showNote(m.scope, m.path); }}>Open in a new tab</button>
          <div class="sep"></div>
        {/if}
        <button role="menuitem" onclick={() => startEdit(m.scope, "rename", m.path, m.isFolder)}>Rename</button>
        <button role="menuitem" onclick={() => { m.page = "move"; m.filter = ""; }}>Move to… <span class="key">▸</span></button>
        <div class="sep"></div>
        <button role="menuitem" onclick={() => startEdit(m.scope, "note", m.isFolder ? m.path : parentOf(m.path))}>New note here</button>
        <button role="menuitem" onclick={() => startEdit(m.scope, "folder", m.isFolder ? m.path : parentOf(m.path))}>New folder here</button>
        <div class="sep"></div>
        <button role="menuitem" class="danger" class:confirm={m.confirm} onclick={() => void menuDelete()}>
          {#if m.confirm}
            Click again — to the trash
          {:else if m.isFolder}
            Delete folder{m.count ? ` (${m.count} ${m.count === 1 ? "note" : "notes"})` : ""}
          {:else}
            Delete
          {/if}
        </button>
      {:else}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="new-name move-filter"
          autofocus
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Move {baseOf(m.path)} to…"
          aria-label="Filter folders"
          bind:value={m.filter}
          onkeydown={(e) => {
            if (e.key === "Enter" && moveChoices.length > 0) void menuMoveTo(moveChoices[0]);
          }}
        />
        <div class="choices">
          {#each moveChoices as f (f)}
            <button role="menuitem" onclick={() => void menuMoveTo(f)}>
              {@render folderGlyph(false)}<span class="choice">{f || "Top level"}</span>
            </button>
          {:else}
            <p class="none">No other folder</p>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  <!-- Item 428: the drop's words, at the panel's foot while the list
       scrolls; "Keeping…" moved here from the section's top. -->
  {#if keeping > 0 || dropToasts.length > 0}
    <div class="drop-toasts" aria-live="polite">
      {#if keeping > 0}
        <p class="keeping" role="status">Keeping {keeping} {keeping === 1 ? "file" : "files"}…</p>
      {/if}
      {#each dropToasts as t (t.id)}
        <div class="drop-toast" role="status">
          <span class="drop-toast-text">{t.text}</span>
          <button class="drop-toast-x" aria-label="Dismiss" onclick={() => dismissDropToast(t.id)}>×</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .panel {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  /* Item 415: held at the top while the list scrolls under it. */
  .find-bar {
    position: sticky;
    top: 0;
    z-index: 3;
    padding: 0.5rem 0.75rem 0.15rem;
    background: var(--paper);
  }
  .find {
    width: 100%;
    box-sizing: border-box;
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.78rem;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .find:focus {
    outline: none;
    border-color: var(--accent);
  }
  .find::placeholder {
    color: var(--dim);
  }
  .no-match {
    opacity: 0.8;
  }
  section {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  /* Item 391: files held over the Project section — the composer's drop
     zone tokens (DropOverlay's `.zone.on`), drawn over the section so its
     rows do not move. Reduced motion: it comes and goes without fading. */
  .keep-drop {
    position: relative;
    border-radius: 12px;
  }
  .keep-drop.held {
    background: color-mix(in srgb, var(--accent-soft) 85%, transparent);
    box-shadow:
      inset 0 0 0 2px var(--accent),
      0 0 0 6px color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .hold {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    padding: 0 0.75rem;
    text-align: center;
    border: 2px dashed var(--accent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--accent-soft) 85%, var(--paper));
    color: var(--accent-ink);
    font-size: 0.72rem;
    animation: hold-fade 140ms ease-out;
  }
  /* Near the head and held in view while the panel scrolls: a project
     with many kept files makes the section taller than the panel. */
  .hold .words {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 3.2rem 0 1rem;
  }
  .hold b {
    font-size: 0.9rem;
    font-weight: 500;
  }
  @media (prefers-reduced-motion: reduce) {
    .hold {
      animation: none;
    }
  }
  @keyframes hold-fade {
    from {
      opacity: 0;
    }
  }
  .keeping {
    margin: 0;
    padding: 0.1rem 0.15rem;
    font-size: 0.72rem;
    color: var(--dim);
  }
  /* Item 428: held at the panel's foot, over the list as it scrolls. */
  .drop-toasts {
    position: sticky;
    bottom: 0;
    z-index: 3;
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.4rem 0.6rem 0.6rem;
    background: linear-gradient(to bottom, transparent, var(--paper) 0.6rem);
  }
  .drop-toast {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0.4rem 0.55rem;
    border: 1px solid var(--accent, var(--border));
    border-radius: 6px;
    background: var(--panel, var(--paper));
    color: var(--text);
    font-size: 0.76rem;
    line-height: 1.35;
  }
  .drop-toast-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .drop-toast-x {
    border: none;
    background: none;
    color: var(--dim);
    font: inherit;
    font-size: 0.9rem;
    line-height: 1;
    padding: 0 0.1rem;
    cursor: pointer;
  }
  .drop-toast-x:hover {
    color: var(--text);
  }
  /* A header the whole width so the hit target is the row, not the caret. */
  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: transparent;
    border: none;
    padding: 0.5rem 0.75rem 0.4rem;
    cursor: pointer;
    color: var(--dim);
    font-family: inherit;
    text-align: left;
  }
  .head:hover {
    color: var(--text);
  }
  .chev {
    font-size: 0.6rem;
    transition: transform 0.12s ease;
  }
  .chev.shut {
    transform: rotate(-90deg);
  }
  .title {
    font-size: 0.68rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .count {
    font-size: 0.68rem;
    opacity: 0.7;
  }
  /* The string the system prompt uses, so the panel and the model call the
     vault the same thing. */
  .alias {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 0.66rem;
    opacity: 0.5;
  }
  .empty {
    padding: 0.15rem 0.75rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .empty p,
  .hint {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--dim);
  }
  .hint {
    padding: 0.1rem 0.75rem 0.75rem;
  }
  .hint code {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  .pick {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    text-align: left;
  }
  .pick:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .bar {
    display: flex;
    gap: 0.35rem;
    padding: 0 0.75rem 0.6rem;
  }
  .add {
    flex: 1;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.55rem;
    cursor: pointer;
    text-align: left;
  }
  .add:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .dream {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--accent);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.35rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .dream:hover {
    border-color: var(--accent);
  }
  .dream.running {
    color: var(--dim);
    font-style: italic;
  }
  .dream:disabled {
    color: var(--dim);
    cursor: default;
  }
  .folder {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--dim);
    font-family: inherit;
    font-size: 0.8rem;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
  }
  .folder:hover {
    color: var(--text);
    border-color: var(--dim);
  }
  .folder.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .new-name {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--accent);
    border-radius: 8px;
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.55rem;
  }
  .new-name:focus {
    outline: none;
  }
  .list {
    padding: 0 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    display: flex;
    align-items: stretch;
    border-radius: 8px;
  }
  .item:hover {
    background: var(--well);
  }
  .item.active {
    background: #211d38;
  }
  /* Item 416: a kept file's row, flashed with the accent for a second and
     faded back. Reduced motion: the highlight holds still, then goes. */
  .item.flash {
    animation: note-flash 1000ms ease-out;
  }
  @keyframes note-flash {
    0%,
    30% {
      background: color-mix(in srgb, var(--accent) 26%, transparent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    100% {
      background: transparent;
      box-shadow: inset 0 0 0 1px transparent;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .item.flash {
      animation: none;
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
  }
  /* The always-loaded file sits above the list, in the list's own gutter,
     with a hairline under it so it reads as the head of the section rather
     than the first note. */
  .item.pinned {
    margin: 0 0.5rem 0.35rem;
    border-bottom: 1px solid var(--line);
    border-radius: 8px 8px 0 0;
  }
  .row {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    color: var(--text);
  }
  .name {
    font-size: 0.82rem;
    font-family: var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .summary {
    font-size: 0.72rem;
    color: var(--dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 0.68rem;
    color: var(--dim);
    opacity: 0.75;
  }
  /* "1 proposed" beside the pinned row: the accent, since it is the one
     thing in the panel waiting on the user. */
  .proposed {
    align-self: center;
    flex-shrink: 0;
    margin-right: 0.4rem;
    background: transparent;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-family: inherit;
    font-size: 0.66rem;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .proposed:hover {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .delete {
    background: transparent;
    border: none;
    color: var(--dim);
    font-size: 0.85rem;
    padding: 0 0.5rem;
    cursor: pointer;
    border-radius: 8px;
    flex-shrink: 0;
    visibility: hidden;
  }
  .item:hover .delete {
    visibility: visible;
  }
  .delete:hover,
  .delete.confirming {
    color: var(--error);
  }
  .delete.confirming {
    font-size: 0.72rem;
  }
  /* Item 457: the tree. A row indents by its depth; folders are one line. */
  .list .item {
    margin-left: calc(var(--depth, 0) * 14px);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }
  .line .name {
    flex: 1;
    min-width: 0;
  }
  .row .summary,
  .row .meta {
    padding-left: calc(14px + 0.4rem);
  }
  .row.dir {
    padding: 0.3rem 0.6rem 0.3rem 0.35rem;
  }
  .caret {
    width: 0.7rem;
    flex-shrink: 0;
    font-size: 0.6rem;
    color: var(--dim);
    text-align: center;
    transition: transform 0.12s ease;
  }
  .caret.shut {
    transform: rotate(-90deg);
  }
  .glyph {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--dim);
  }
  .glyph.dir {
    color: var(--accent);
  }
  .glyph.file.pdf {
    color: var(--error);
  }
  .bar .folder .glyph {
    display: block;
    color: inherit;
  }
  .n {
    flex-shrink: 0;
    font-size: 0.66rem;
    color: var(--dim);
    opacity: 0.8;
  }
  .dir-row.drop-on,
  .head.drop-on {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    box-shadow: inset 0 0 0 1px var(--accent);
    border-radius: 8px;
  }
  .item.editing {
    padding: 0.2rem 0.35rem;
  }
  .edit-row {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }
  .new-name.inline {
    padding: 0.2rem 0.4rem;
    border-radius: 6px;
  }
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 35;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
  }
  .note-menu {
    position: fixed;
    z-index: 36;
    display: flex;
    flex-direction: column;
    min-width: 200px;
    max-width: 300px;
    padding: 4px;
    background: var(--sheet);
    border: 1px solid var(--line2);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .note-menu > :global(*) {
    flex-shrink: 0;
  }
  .note-menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    text-align: left;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--ink2, var(--text));
    font: inherit;
    font-size: 12.5px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .note-menu button:hover {
    background: var(--well);
    color: var(--text);
  }
  .note-menu .danger:hover,
  .note-menu .danger.confirm {
    color: var(--error);
  }
  .note-menu .key {
    color: var(--dim);
  }
  .note-menu .sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--line);
  }
  .move-filter {
    margin: 2px 2px 4px;
    font-size: 12px;
  }
  .choices {
    display: flex;
    flex-direction: column;
    max-height: 260px;
    overflow-y: auto;
  }
  .choices button {
    justify-content: flex-start;
  }
  .choice {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 12px;
  }
  .none {
    margin: 4px 10px 6px;
    font-size: 12px;
    color: var(--dim);
  }
</style>
