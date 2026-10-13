/**
 * Opening a `memory_where` hit (nightshift backlog 296): the note editor at
 * that line when the editor reaches the file (user memory, the project's
 * AGENTS.md and `.agents/`, the vault, a model's file, CHAT.md); otherwise
 * the file as a tab, or with its own application when the tab refuses it
 * (Claude Code's CLAUDE.md lives outside the chat's folders).
 */
import * as api from "./api";
import { addToast, app, openContent } from "./state.svelte";
import { findRefs, type MemoryHit } from "./memoryHits";
import { lineOfNeedle, type MemoryEdit } from "./memoryEdits";

export async function openMemoryHit(hit: MemoryHit): Promise<void> {
  try {
    const note = await api.memoryNoteFor(hit.path);
    if (note) {
      const [scope, name] = note;
      app.noteAt = { scope, name, line: hit.line };
      await openContent({ kind: "note", scope, name });
      return;
    }
  } catch (e) {
    addToast(String(e));
    return;
  }
  const chat = app.activeSessionId;
  try {
    const f = await api.readFileTab(hit.path, chat);
    if (f.kind !== "other") {
      await openContent(chat ? { kind: "file", path: hit.path, session: chat } : { kind: "file", path: hit.path });
      addToast(`Line ${hit.line} — this file opens read-only here; open it with its app to edit`);
      return;
    }
  } catch {
    // Outside the chat's folders: its own application below.
  }
  try {
    await api.openFile(hit.path);
  } catch (e) {
    addToast(`Could not open: ${String(e)}`);
  }
}

/**
 * The "Updated <file>" line's click (backlog 305): the note editor at the
 * line the edit wrote, found in the file as it is now; a file the editor
 * does not reach opens the way a memory hit's does.
 */
export async function openMemoryEdit(edit: MemoryEdit): Promise<void> {
  let line = 1;
  try {
    const note = await api.memoryNoteFor(edit.path);
    if (note) line = lineOfNeedle(await api.readNote(note[0], note[1]), edit.needle, edit.skip);
  } catch {
    // Unreadable now (moved, deleted): the open below says so in its words.
  }
  await openMemoryHit({ path: edit.path, line, text: "" });
}

/** Strike the hit's line with today's date; the new line, or null. */
export async function strikeMemoryHit(hit: MemoryHit): Promise<string | null> {
  try {
    const line = await api.memoryStrike(hit.path, hit.line, hit.text);
    addToast(`Struck line ${hit.line} — the text stays, marked superseded`);
    return line;
  } catch (e) {
    addToast(String(e));
    return null;
  }
}

/**
 * The reply's own `path:line` references as links (backlog 296): the model
 * is asked to name each place it means as the tool wrote it, and every one
 * that resolves to a hit of this turn opens like the row below the reply.
 * Text nodes only, never inside a link or a code block — the HTML is the
 * sanitizer's, and this adds one inert element around text it already has.
 */
export function memoryRefs(node: HTMLElement, params: { hits: MemoryHit[]; text: string }) {
  let hits = params.hits;
  const onclick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a.mem-ref") as HTMLAnchorElement | null;
    if (!a || !node.contains(a)) return;
    e.preventDefault();
    const hit = hits[Number(a.dataset.memHit)];
    if (hit) void openMemoryHit(hit);
  };
  const apply = () => {
    if (hits.length === 0) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = (n as Text).parentElement;
      if (p?.closest("a, pre")) continue;
      nodes.push(n as Text);
    }
    for (const t of nodes) {
      const refs = findRefs(t.data, hits);
      if (refs.length === 0) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const r of refs) {
        if (r.start > at) frag.append(t.data.slice(at, r.start));
        const a = document.createElement("a");
        a.href = "#";
        a.className = "mem-ref";
        a.dataset.memHit = String(hits.indexOf(r.hit));
        a.title = `${r.hit.path}:${r.hit.line} — open at this line`;
        a.textContent = t.data.slice(r.start, r.end);
        frag.append(a);
        at = r.end;
      }
      if (at < t.data.length) frag.append(t.data.slice(at));
      t.replaceWith(frag);
    }
  };
  node.addEventListener("click", onclick);
  apply();
  return {
    update(next: { hits: MemoryHit[]; text: string }) {
      hits = next.hits;
      apply();
    },
    destroy() {
      node.removeEventListener("click", onclick);
    },
  };
}
