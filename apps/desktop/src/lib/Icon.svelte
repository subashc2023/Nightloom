<script lang="ts">
  import { ICONS, type IconName } from "./icons";

  let { name, size = 14 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="ns-ico"
  viewBox="0 0 20 20"
  aria-hidden="true"
  style:width="{size}px"
  style:height="{size}px"
>
  {@html ICONS[name]}
</svg>
