<script lang="ts">
  import { tip } from "./tip";
  /** A key cap: `⌘K`, `↵`, `esc`. Drawn, never a font glyph, so every palette colours it. */
  let { keys, dim = false }: { keys: string; dim?: boolean } = $props();

  /**
   * The chord in words, as the tooltip: `⌘⇧S` → "Command + Shift + S".
   * Added after ⇧ was read as caps lock (review round 1, 2026-09-13) — the
   * glyphs are the Mac convention, but nothing on screen said which key
   * ⇧ is, and ⇪ (caps lock) is one stroke away from it.
   */
  const NAMES: Record<string, string> = {
    "⌘": "Command",
    "⇧": "Shift",
    "⌥": "Option",
    "⌃": "Control",
    "↵": "Return",
    "⎋": "Escape",
  };
  const spelled = $derived.by(() => {
    const parts: string[] = [];
    let rest = keys;
    while (rest.length > 0 && NAMES[rest[0]]) {
      parts.push(NAMES[rest[0]]);
      rest = rest.slice(1);
    }
    if (rest) parts.push(rest);
    return parts.length > 1 ? parts.join(" + ") : "";
  });
</script>

<kbd class="kbd" class:dim use:tip={spelled || undefined}>{keys}</kbd>

<style>
  .kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 19px;
    padding: 0 5px;
    border: 1px solid var(--line2);
    border-bottom-width: 2px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink2);
    background: var(--sheet);
    white-space: nowrap;
    flex: none;
  }
  .kbd.dim {
    opacity: 0.45;
  }
</style>
