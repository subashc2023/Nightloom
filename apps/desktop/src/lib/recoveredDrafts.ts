/**
 * Item 871: a kept draft whose note was deleted (outside Nightloom, or while
 * it was quit) is still his work, so it is listed — "Recovered drafts",
 * from the launch toast's Show and from a row at the top of Notes — and
 * never dropped but by a confirmed Discard. Only the open project's notes
 * and the vault can lose their file; the one-file scopes always have one.
 * A note counts as missing only from a listing that was read and is whole.
 */
export type Recovered = { key: string; scope: "project" | "knowledge"; name: string; text: string };

export function recoveredDrafts(
  drafts: Readonly<Record<string, string>>,
  s: {
    projectId: string | null;
    notes: readonly { name: string }[];
    vault: readonly { name: string }[];
    listed: { project: string | null; knowledge: boolean };
    complete: { project: boolean; knowledge: boolean };
  },
): Recovered[] {
  const out: Recovered[] = [];
  const projectPrefix = s.projectId ? `${s.projectId}:project:` : null;
  const canProject = projectPrefix !== null && s.listed.project === s.projectId && s.complete.project;
  const canVault = s.listed.knowledge && s.complete.knowledge;
  const inNotes = new Set(s.notes.map((n) => n.name));
  const inVault = new Set(s.vault.map((n) => n.name));
  for (const [key, text] of Object.entries(drafts)) {
    if (canProject && projectPrefix && key.startsWith(projectPrefix)) {
      const name = key.slice(projectPrefix.length);
      if (!inNotes.has(name)) out.push({ key, scope: "project", name, text });
    } else if (canVault && key.startsWith("knowledge:")) {
      const name = key.slice("knowledge:".length);
      if (!inVault.has(name)) out.push({ key, scope: "knowledge", name, text });
    }
  }
  return out;
}

/** The first line with words, for the list. */
export function preview(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
