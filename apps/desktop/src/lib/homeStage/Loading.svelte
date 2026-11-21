<script lang="ts">
  // Round 5, point 14: a view's loading state in the thinking block's vocabulary — scan brackets locking on, a line
  // that says what Home is reading, shimmering lines where the rows will land.
  let { label, lines = 3 }: { label: string; lines?: number } = $props();
  const W = ["82%", "64%", "74%", "52%"];
</script>

<div class="h9-load h9-brk">
  <i class="bk tl"></i><i class="bk tr"></i><i class="bk bl"></i><i class="bk br"></i>
  <span class="h9-load-l h9-caret">{label}</span>
  {#each Array(lines) as _, i (i)}<i class="h9-skel" style:--w={W[i % 4]} style:--i={i}></i>{/each}
</div>
