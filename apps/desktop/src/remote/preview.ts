/**
 * A message's preview in the long-press menu as plain words (nightshift 300
 * A25): the menu showed the raw markdown (`# Plan`, `**bold**`). The marks
 * go, the words stay; a code fence keeps its code, a table its cells.
 */
export function plainPreview(md: string): string {
  const lines: string[] = [];
  let fence = false;
  for (const raw of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      lines.push(raw);
      continue;
    }
    // A table's rule row says nothing.
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw)) continue;
    let l = raw
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, "$1")
      .replace(/^(\s*)[-*+]\s+/, "$1• ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
    if (/^\s*\|.*\|\s*$/.test(l))
      l = l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .join(" · ");
    lines.push(l);
  }
  return lines
    .join("\n")
    // Three lines show: a blank line between paragraphs would spend one.
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
