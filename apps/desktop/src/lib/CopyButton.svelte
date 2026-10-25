<script lang="ts">
  /*
   * Every Copy button in the app (item 402, his "make al the Copys into the
   * button", 2026-10-24): the copy icon his own messages carry
   * (Transcript's `.tool-btn`), the check for `COPIED_MS` after a copy. The
   * caller owns `copied`; the button keeps its name for a reader and the
   * tooltip, since it has no word. Styled by app.css's `.ns-icon-btn`.
   */
  import Icon from "./Icon.svelte";
  import { tip } from "./tip";

  let {
    copied = false,
    label = "Copy",
    size = 14,
    onclick,
  }: { copied?: boolean; label?: string; size?: number; onclick: () => void } = $props();
</script>

<button
  type="button"
  class="ns-icon-btn"
  class:copied
  use:tip={copied ? "Copied" : label}
  aria-label={copied ? "Copied" : label}
  {onclick}
>
  <Icon name={copied ? "check" : "copy"} {size} />
</button>
