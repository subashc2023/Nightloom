/**
 * Where a chat lives, as far as this launch knows (item 874, finding 2):
 * an off-screen turn's own record names its project first — a chat Home's
 * routes ran in another project is that project's, never the open one; the
 * chat on screen is the open project's; else the project it was opened in
 * this launch; else (never seen) the open project.
 */
export type Home = { id: string | null; name: string | null };

export function chatHomeOf(
  id: string | null,
  w: {
    active: string | null;
    open: Home;
    record?: { project?: string | null; projectName?: string | null } | null;
    known?: { project: string | null; name: string | null } | null;
  },
): Home {
  if (id && w.record) return { id: w.record.project ?? null, name: w.record.projectName ?? null };
  if (!id || id === w.active || !w.known) return w.open;
  return { id: w.known.project, name: w.known.name };
}
