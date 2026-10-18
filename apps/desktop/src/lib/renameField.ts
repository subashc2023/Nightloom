/**
 * A rename field (nightshift backlog 376): it opens focused with the whole
 * title selected, so typing replaces the name and Esc leaves it as it was.
 * Used by the sidebar row's Rename (menu and double-click) and the chat
 * tab's Rename.
 */

/** The part of an input this needs: enough to test without a DOM. */
export interface SelectableField {
  focus(): void;
  select(): void;
  readonly ownerDocument?: { activeElement: unknown } | null;
}

/**
 * Svelte action: focus the field and select all of it on mount. Again on
 * the next tick when something took the focus meanwhile — the menu whose
 * Rename opened the field closes in the same update, and a click's focus
 * can land after the mount.
 */
export function selectAllOnMount(
  node: SelectableField,
  later: (f: () => void) => void = (f) => void setTimeout(f, 0),
): void {
  node.focus();
  node.select();
  later(() => {
    const doc = node.ownerDocument;
    if (doc && doc.activeElement !== node) {
      node.focus();
      node.select();
    }
  });
}

/**
 * The name a rename field commits, or null for a cancel: an emptied field
 * (an empty name would leave the row labelled by its opening message with
 * no way back) or an unchanged one.
 */
export function renamedTo(draft: string, current: string): string | null {
  const name = draft.trim();
  if (!name || name === current.trim()) return null;
  return name;
}
