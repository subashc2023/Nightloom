// A chat's name as drawn (item 462), pure: no state, safe to import anywhere.

/**
 * A chat's name as drawn anywhere (item 462): its first line, at most 60
 * characters with an ellipsis where it was cut. A chat with no title is
 * called by its first message, and a fork before 462 carried that whole
 * message as its title — many lines — into the tab, its hover and the list.
 */
export function nameLine(text: string): string {
  const t = text.trim().split("\n")[0].trim();
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

/** `nameLine` of the title, else of the first message, else `fallback`. */
export function chatLabel(
  s: { title?: string | null; first_user?: string | null } | null | undefined,
  fallback: string,
): string {
  return nameLine(s?.title ?? s?.first_user ?? "") || fallback;
}
