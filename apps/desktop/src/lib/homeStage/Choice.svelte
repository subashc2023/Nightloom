<script lang="ts">
  // Round 5, point 1: Accept / Skip as one choice — Send's bulb joined to a ghost half (as Send joins its ▾). Once he
  // picks, the pair becomes what he chose, with Undo.
  import Btn from "./Btn.svelte";
  let { value, yes = "Accept", no = "Skip", done = "accepted", skipped = "skipped", onpick, onundo }: { value: "" | "yes" | "no" | undefined; yes?: string; no?: string; done?: string; skipped?: string; onpick: (v: "yes" | "no") => void; onundo: () => void } = $props();
</script>

{#if !value}
  <span class="jc"><Btn kind="send" icon="check" small onclick={() => onpick("yes")}>{yes}</Btn><Btn small onclick={() => onpick("no")}>{no}</Btn></span>
{:else}
  <span class="jc-done"><span class="ns-pill {value === 'yes' ? 'done' : 'grey'}"><span class="dot"></span>{value === "yes" ? done : skipped}</span><Btn small icon="revert" tip={"Undo this choice"} onclick={onundo}>Undo</Btn></span>
{/if}
