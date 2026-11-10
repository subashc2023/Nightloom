<script lang="ts">
  /**
   * One action on a waiting message (nightshift item 549, 2026-11-10; his
   * words: "instead of a button saying send now or a button saying edit, or a
   * button saying cancel, those should all be icons"): an icon from the app's
   * set in app.css's `.ns-icon-btn` box, its name as the `aria-label` and
   * its explanation as the tip. A real `<button>`, so Tab reaches it and
   * Enter or Space presses it. Filament IV only: the Classic layout keeps
   * the word buttons (item 542).
   */
  import Icon from "./Icon.svelte";
  import { tip } from "./tip";
  import type { IconName } from "./icons";

  let {
    icon,
    label,
    hint,
    onclick,
    disabled = false,
    accent = false,
    ...rest
  }: {
    icon: IconName;
    /** The action's name: the aria-label, and the tip's first words. */
    label: string;
    /** What it does, after the name in the tip. */
    hint?: string;
    onclick: () => void;
    disabled?: boolean;
    /** The message's main action (Send now), in the accent colour. */
    accent?: boolean;
    [k: `data-${string}`]: string | undefined;
  } = $props();
</script>

<button
  class="ns-icon-btn wait-act"
  class:accent
  type="button"
  aria-label={label}
  {disabled}
  use:tip={hint ? `${label} — ${hint}` : label}
  {onclick}
  {...rest}
>
  <Icon name={icon} size={14} />
</button>

<style>
  .wait-act {
    width: 26px;
    height: 26px;
  }
  .wait-act.accent {
    color: var(--accent);
  }
  .wait-act:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .wait-act:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
