/**
 * The Notes panel as a file manager (nightshift item 457, his ask: "have me
 * click into folders and make clear when something's a folder vs file").
 * Pure: notes and folder paths in, the rows to draw out; plus the renames a
 * move implies for every name under it. `NotesPanel.svelte` draws the rows,
 * `state.svelte.ts` (`moveNoteTo`) applies the renames to tabs and drafts.
 */
import type { Note } from "./types";

export interface FolderNode {
  /** `a/b`, docspace-relative; `""` for the section's top level. */
  path: string;
  name: string;
  folders: FolderNode[];
  notes: Note[];
  /** Notes in this folder and every folder below it. */
  count: number;
}

export type TreeRow =
  | { kind: "folder"; path: string; name: string; depth: number; open: boolean; count: number }
  | { kind: "note"; note: Note; label: string; depth: number };

/** The last part of a path. */
export function baseOf(name: string): string {
  const cut = name.lastIndexOf("/");
  return cut < 0 ? name : name.slice(cut + 1);
}

/** The folder a path sits in, `""` at the top level. */
export function parentOf(name: string): string {
  const cut = name.lastIndexOf("/");
  return cut < 0 ? "" : name.slice(0, cut);
}

/** `folder/base`, or `base` at the top level. */
export function joinPath(folder: string, base: string): string {
  return folder ? `${folder}/${base}` : base;
}

/** Every folder a path sits under, outermost first: `a/b/c.md` → `a`, `a/b`. */
export function ancestorsOf(name: string): string[] {
  const parts = name.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The tree of `notes` and `folders` (the backend lists empty folders too;
 * a note's own folders are implied by its path, so a list without them —
 * a search's narrowed one — still nests). Folders first, then files, each
 * in natural order (`n2` before `n10`).
 */
export function buildTree(notes: Note[], folders: string[] = []): FolderNode {
  const root: FolderNode = { path: "", name: "", folders: [], notes: [], count: 0 };
  const index = new Map<string, FolderNode>([["", root]]);
  const folderAt = (path: string): FolderNode => {
    const have = index.get(path);
    if (have) return have;
    const parent = folderAt(parentOf(path));
    const node: FolderNode = { path, name: baseOf(path), folders: [], notes: [], count: 0 };
    parent.folders.push(node);
    index.set(path, node);
    return node;
  };
  for (const f of folders) if (f) folderAt(f);
  for (const n of notes) {
    const home = folderAt(parentOf(n.name));
    home.notes.push(n);
  }
  const finish = (node: FolderNode): number => {
    node.folders.sort((a, b) => byName.compare(a.name, b.name));
    node.notes.sort((a, b) => byName.compare(baseOf(a.name), baseOf(b.name)));
    node.count = node.notes.length + node.folders.reduce((s, f) => s + finish(f), 0);
    return node.count;
  };
  finish(root);
  return root;
}

/**
 * The rows on screen: a folder's contents only while it is open, or every
 * folder open when `allOpen` (a search: the matches are what the box is
 * for). Indented by depth.
 */
export function visibleRows(root: FolderNode, open: ReadonlySet<string>, allOpen = false): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (node: FolderNode, depth: number) => {
    for (const f of node.folders) {
      const isOpen = allOpen || open.has(f.path);
      out.push({ kind: "folder", path: f.path, name: f.name, depth, open: isOpen, count: f.count });
      if (isOpen) walk(f, depth + 1);
    }
    for (const n of node.notes) out.push({ kind: "note", note: n, label: baseOf(n.name), depth });
  };
  walk(root, 0);
  return out;
}

/**
 * What `name` is called once `from` has moved to `to`: `to` itself, the
 * same path under `to` when `name` sat inside the folder `from`, or null
 * when the move does not touch it.
 */
export function movedName(name: string, from: string, to: string): string | null {
  if (name === from) return to;
  if (name.startsWith(`${from}/`)) return to + name.slice(from.length);
  return null;
}

/** Where dropping `name` on `folder` puts it; null when it stays put or
 *  would land inside itself. */
export function dropTarget(name: string, folder: string): string | null {
  if (parentOf(name) === folder) return null;
  if (folder === name || folder.startsWith(`${name}/`)) return null;
  return joinPath(folder, baseOf(name));
}

/** A new note's or folder's name as he typed it: trimmed, no leading or
 *  trailing slash, no empty parts — `""` when nothing is left. */
export function cleanName(typed: string): string {
  return typed
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== ".")
    .join("/");
}

/** The kind of icon a file row gets, from its extension and the backend's
 *  `kind` for files that are not text. */
export function fileIcon(note: Pick<Note, "name" | "kind">): "text" | "pdf" | "image" | "deck" | "sheet" | "file" {
  const ext = baseOf(note.name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const kind = (note.kind ?? "").toLowerCase();
  if (kind === "pdf" || ext === "pdf") return "pdf";
  if (kind.includes("image")) return "image";
  if (kind === "slide deck") return "deck";
  if (kind === "spreadsheet" || ext === "csv") return "sheet";
  if (!note.kind) return "text";
  return "file";
}

/** The localStorage key a section's open folders are kept under: per
 *  project for the project's notes, one for the vault. */
export function openKey(scope: "project" | "knowledge", projectId: string | null): string {
  return scope === "project" ? `nightloom.notesOpen.project.${projectId ?? "unfiled"}` : "nightloom.notesOpen.knowledge";
}

export function loadOpen(store: Pick<Storage, "getItem"> | null, key: string): Set<string> {
  try {
    const raw = store?.getItem(key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveOpen(store: Pick<Storage, "setItem"> | null, key: string, open: ReadonlySet<string>): void {
  try {
    store?.setItem(key, JSON.stringify([...open].sort()));
  } catch {
    // A full or blocked store forgets which folders were open; nothing else.
  }
}

/** The open set after `from` moved to `to`: an open folder stays open
 *  under its new name, and so does every open folder inside it. */
export function renamedOpen(open: ReadonlySet<string>, from: string, to: string): Set<string> {
  const out = new Set<string>();
  for (const p of open) out.add(movedName(p, from, to) ?? p);
  return out;
}

/**
 * Where a rename of `path` to the typed name lands, in the same folder
 * (items 457 and 460): null when nothing is left of what he typed or it is
 * the same name. A note keeps its extension when he types a bare name
 * (`Pasted text (2)` → `module_2_overview` is `module_2_overview.md` when
 * the note was `.md`); a folder takes the name as typed.
 */
export function renamedTo(path: string, typed: string, isFolder = false): string | null {
  const name = cleanName(typed);
  if (!name) return null;
  const oldBase = baseOf(path);
  const ext = isFolder ? "" : (oldBase.match(/\.[a-z0-9]+$/i)?.[0] ?? "");
  const base = ext && !/\.[a-z0-9]+$/i.test(name) ? `${name}${ext}` : name;
  const to = joinPath(parentOf(path), base);
  return to === path ? null : to;
}

/**
 * What a failed `read_note` says about a name New note is about to write
 * (review fix, item 457 — New note never writes over a note). Only the
 * read's own "cannot read …: <io error>" speaks to the disk: "no such
 * file" (os error 2) is `free`, a directory (os error 21) is `folder`,
 * any other read failure (a PDF is not UTF-8, a permission) is `taken`.
 * Anything else — no project open, a name outside the folder — is `free`
 * here, and the save reports it as it always has.
 */
export function readSaysTaken(err: unknown): "free" | "taken" | "folder" {
  const why = String(err);
  if (!why.includes("cannot read")) return "free";
  if (why.includes("(os error 21)")) return "folder";
  if (why.includes("(os error 2)")) return "free";
  return "taken";
}
