<script lang="ts">
  // Round 5, point 1: every stage button, in the composer bottom row's Jarvis styles (stage.css `.jb`). `send` is Send's
  // bulb with the app's own coil (FilamentMark) and scan line; `ghost` is Attach / Ask aside / Council's bulb; `danger`
  // is the Stop that takes Send's place.
  import type { Snippet } from "svelte";
  import Icon from "../Icon.svelte";
  import FilamentMark from "../FilamentMark.svelte";
  import { tip as tipAct } from "../tip";
  import type { IconName } from "../icons";
  let { kind = "ghost", icon, tip = "", on = false, disabled = false, small = false, label, onclick, children }: { kind?: "ghost" | "send" | "danger" | "home"; icon?: IconName; tip?: string; on?: boolean; disabled?: boolean; small?: boolean; label?: string; onclick?: (e: MouseEvent) => void; children?: Snippet } = $props();
</script>

<button class="jb fil-btn {kind}" class:on class:small {disabled} aria-label={label} aria-pressed={on || undefined} use:tipAct={tip || null} onclick={(e) => (e.stopPropagation(), onclick?.(e))}>
  {#if kind === "send"}<span class="jb-scan" aria-hidden="true"></span>{#if icon}<Icon name={icon} size={12} />{:else}<FilamentMark kind="send" />{/if}{:else if icon}<Icon name={icon} size={12} />{/if}{@render children?.()}
</button>
